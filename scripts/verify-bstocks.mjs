import { pathToFileURL } from "node:url"
import { createPublicClient, getAddress, http, isAddress } from "viem"
import { bsc, bscTestnet } from "viem/chains"
import { resolveBnbNetworkProfile } from "../src/config/bnbNetworks.js"

const UINT256_MAX = (1n << 256n) - 1n
const SCALED_UI_BASE = 10n ** 18n
const ZERO_STORAGE_WORD = `0x${"0".repeat(64)}`

export const scaledUiInterfaceIds = Object.freeze({
  core: "0xa60bf13d",
  conversion: "0x57854fc3",
  pending: "0x4bd27648",
})

export const eip1967Slots = Object.freeze({
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
})

const tokenAbi = Object.freeze([
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "supportsInterface",
    stateMutability: "view",
    inputs: [{ name: "interfaceId", type: "bytes4" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "uiMultiplier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "newUIMultiplier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "effectiveAt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "toUIAmount",
    stateMutability: "view",
    inputs: [{ name: "rawAmount", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "fromUIAmount",
    stateMutability: "view",
    inputs: [{ name: "uiAmount", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
])

const beaconAbi = Object.freeze([
  {
    type: "function",
    name: "implementation",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
])

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertUint256(value, label, { allowZero = false } = {}) {
  assert(typeof value === "bigint", `${label} did not return a uint256.`)
  assert(value >= 0n && value <= UINT256_MAX, `${label} is outside the uint256 range.`)
  assert(allowZero || value > 0n, `${label} must be greater than zero.`)
  return value
}

function normalizeAsset(input) {
  const separator = input.indexOf("=")
  assert(separator > 0 && separator < input.length - 1, `Invalid asset input: ${input}`)

  const symbol = input.slice(0, separator).trim()
  const address = input.slice(separator + 1).trim()
  assert(/^[A-Z][A-Z0-9]{0,15}$/.test(symbol), `Invalid asset symbol: ${symbol || "(empty)"}`)
  assert(isAddress(address, { strict: false }), `Invalid address for ${symbol}.`)

  return Object.freeze({ symbol, address: getAddress(address) })
}

export function parseBstockArgs(argv) {
  const assets = []
  let network = "mainnet"
  let rpcUrl

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (argument === "--network" || argument === "--rpc-url") {
      const value = argv[index + 1]
      assert(value && !value.startsWith("--"), `Missing value for ${argument}.`)
      if (argument === "--network") network = value
      else rpcUrl = value
      index += 1
      continue
    }

    assert(!argument.startsWith("--"), `Unexpected argument: ${argument}`)
    assets.push(normalizeAsset(argument))
  }

  assert(assets.length > 0, "Provide at least one explicit SYMBOL=ADDRESS input.")
  const symbols = new Set()
  const addresses = new Set()
  for (const asset of assets) {
    assert(!symbols.has(asset.symbol), `Duplicate asset symbol: ${asset.symbol}`)
    assert(!addresses.has(asset.address), `Duplicate asset address: ${asset.address}`)
    symbols.add(asset.symbol)
    addresses.add(asset.address)
  }

  return Object.freeze({
    network,
    rpcUrl,
    assets: Object.freeze(
      [...assets].sort((left, right) => left.symbol.localeCompare(right.symbol)),
    ),
  })
}

export function storageWordAddress(value, label) {
  const word = value ?? ZERO_STORAGE_WORD
  assert(/^0x[0-9a-f]{64}$/i.test(word), `${label} returned an invalid storage word.`)
  assert(/^0x0{24}/i.test(word), `${label} contains non-address data.`)
  if (word === ZERO_STORAGE_WORD) return null
  return getAddress(`0x${word.slice(-40)}`)
}

async function requireCode(client, address, label) {
  const bytecode = await client.getBytecode({ address })
  assert(bytecode && bytecode !== "0x", `${label} has no deployed code.`)
  return bytecode
}

async function inspectProxy(client, tokenAddress, symbol) {
  const [implementationWord, beaconWord] = await Promise.all([
    client.getStorageAt({ address: tokenAddress, slot: eip1967Slots.implementation }),
    client.getStorageAt({ address: tokenAddress, slot: eip1967Slots.beacon }),
  ])
  const directImplementation = storageWordAddress(
    implementationWord,
    `${symbol} EIP-1967 implementation slot`,
  )
  const beaconAddress = storageWordAddress(beaconWord, `${symbol} EIP-1967 beacon slot`)

  assert(
    !(directImplementation && beaconAddress),
    `${symbol} sets both EIP-1967 implementation and beacon slots.`,
  )

  if (directImplementation) {
    await requireCode(client, directImplementation, `${symbol} implementation`)
    return Object.freeze({
      kind: "implementation",
      implementationSlot: directImplementation,
      beaconSlot: null,
      resolvedImplementation: directImplementation,
    })
  }

  if (beaconAddress) {
    await requireCode(client, beaconAddress, `${symbol} beacon`)
    const beaconImplementation = await client.readContract({
      address: beaconAddress,
      abi: beaconAbi,
      functionName: "implementation",
    })
    assert(isAddress(beaconImplementation, { strict: false }), `${symbol} beacon is invalid.`)
    const resolvedImplementation = getAddress(beaconImplementation)
    await requireCode(client, resolvedImplementation, `${symbol} beacon implementation`)

    return Object.freeze({
      kind: "beacon",
      implementationSlot: null,
      beaconSlot: beaconAddress,
      resolvedImplementation,
    })
  }

  return Object.freeze({
    kind: "none-detected",
    implementationSlot: null,
    beaconSlot: null,
    resolvedImplementation: null,
  })
}

async function verifyAsset(client, asset) {
  await requireCode(client, asset.address, asset.symbol)

  const [symbol, decimals, supportsCore, supportsConversion, supportsPending] = await Promise.all([
    client.readContract({ address: asset.address, abi: tokenAbi, functionName: "symbol" }),
    client.readContract({ address: asset.address, abi: tokenAbi, functionName: "decimals" }),
    ...Object.values(scaledUiInterfaceIds).map((interfaceId) =>
      client.readContract({
        address: asset.address,
        abi: tokenAbi,
        functionName: "supportsInterface",
        args: [interfaceId],
      }),
    ),
  ])

  assert(symbol === asset.symbol, `${asset.symbol} contract reports symbol ${String(symbol)}.`)
  assert(
    Number.isInteger(decimals) && decimals >= 0 && decimals <= 255,
    `${asset.symbol} decimals are invalid.`,
  )
  assert(supportsCore === true, `${asset.symbol} does not support the ERC-8056 core interface.`)
  assert(
    supportsConversion === true,
    `${asset.symbol} does not support the ERC-8056 conversion interface.`,
  )
  assert(
    supportsPending === true,
    `${asset.symbol} does not support the ERC-8056 pending-state interface.`,
  )

  const [currentMultiplier, pendingMultiplier, effectiveAt] = await Promise.all([
    client.readContract({ address: asset.address, abi: tokenAbi, functionName: "uiMultiplier" }),
    client.readContract({
      address: asset.address,
      abi: tokenAbi,
      functionName: "newUIMultiplier",
    }),
    client.readContract({ address: asset.address, abi: tokenAbi, functionName: "effectiveAt" }),
  ])
  assertUint256(currentMultiplier, `${asset.symbol} current UI multiplier`)
  assertUint256(pendingMultiplier, `${asset.symbol} pending UI multiplier`)
  assertUint256(effectiveAt, `${asset.symbol} multiplier effective time`, { allowZero: true })

  const uiAmount = await client.readContract({
    address: asset.address,
    abi: tokenAbi,
    functionName: "toUIAmount",
    args: [SCALED_UI_BASE],
  })
  assertUint256(uiAmount, `${asset.symbol} displayed conversion amount`)
  assert(
    uiAmount === currentMultiplier,
    `${asset.symbol} toUIAmount does not match its current multiplier.`,
  )

  const rawRoundTrip = await client.readContract({
    address: asset.address,
    abi: tokenAbi,
    functionName: "fromUIAmount",
    args: [uiAmount],
  })
  assertUint256(rawRoundTrip, `${asset.symbol} raw roundtrip amount`)
  assert(rawRoundTrip === SCALED_UI_BASE, `${asset.symbol} scaled-amount roundtrip is inexact.`)

  const proxy = await inspectProxy(client, asset.address, asset.symbol)

  return Object.freeze({
    symbol: asset.symbol,
    address: asset.address,
    decimals,
    erc8056: {
      interfaces: {
        core: scaledUiInterfaceIds.core,
        conversion: scaledUiInterfaceIds.conversion,
        pending: scaledUiInterfaceIds.pending,
      },
      currentMultiplier: currentMultiplier.toString(),
      pendingMultiplier: pendingMultiplier.toString(),
      effectiveAt: effectiveAt.toString(),
      roundtrip: {
        rawInput: SCALED_UI_BASE.toString(),
        displayedAmount: uiAmount.toString(),
        rawOutput: rawRoundTrip.toString(),
      },
    },
    proxy,
    technicalChecks: "pass",
  })
}

export async function verifyBstocks({ client, network, chainId, assets }) {
  const actualChainId = await client.getChainId()
  assert(actualChainId === chainId, `RPC returned chain ${actualChainId}; expected ${chainId}.`)

  const reports = []
  for (const asset of [...assets].sort((left, right) => left.symbol.localeCompare(right.symbol))) {
    reports.push(await verifyAsset(client, asset))
  }

  return Object.freeze({
    schema: "woven-bstock-technical-preflight/v1",
    network,
    chainId: actualChainId,
    scope: {
      readOnly: true,
      addressEvidence:
        "This command does not prove that an input address is canonical, backed, eligible, or unrestricted. Verify every address and restriction against primary issuer sources before admission.",
    },
    assets: reports,
    technicalChecks: "pass",
  })
}

async function main() {
  const args = parseBstockArgs(process.argv.slice(2))
  const network = resolveBnbNetworkProfile(args.network)
  const chain = network.key === "mainnet" ? bsc : bscTestnet
  const client = createPublicClient({
    chain,
    transport: http(args.rpcUrl || network.rpcUrl, { timeout: 12_000 }),
  })
  const report = await verifyBstocks({
    client,
    network: network.key,
    chainId: network.chainId,
    assets: args.assets,
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`bStock technical preflight failed: ${message}\n`)
    process.exitCode = 1
  })
}
