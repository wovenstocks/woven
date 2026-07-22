import { createPublicClient, getAddress, http, zeroAddress } from "viem"
import { bsc, bscTestnet } from "viem/chains"
import { resolveBnbNetworkProfile } from "../src/config/bnbNetworks.js"
import {
  assertPinnedBytecode,
  parseArgs,
  requiredAddress,
  safeAbi,
  safeProfile,
  storageWordAddress,
  validateSafeCreationEvidence,
} from "./safe-profile.mjs"

const wovenAbi = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
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
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "_mode",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const network = resolveBnbNetworkProfile(args.network)
  const owner = requiredAddress(args.owner, "Expected Safe owner")
  const safeAddress = requiredAddress(args.safe, "Protocol Safe")
  const wovenAddress = requiredAddress(args.woven, "WOVEN token")
  const rpcUrl = process.env.WOVEN_BNB_RPC_URL || network.rpcUrl
  const chain = network.key === "mainnet" ? bsc : bscTestnet
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 12_000 }) })

  const chainId = await client.getChainId()
  assert(chainId === network.chainId, `RPC returned chain ${chainId}; expected ${network.chainId}.`)

  const [wovenCode, safeCode, singletonCode, proxyFactoryCode, fallbackHandlerCode] =
    await Promise.all([
      client.getBytecode({ address: wovenAddress }),
      client.getBytecode({ address: safeAddress }),
      client.getBytecode({ address: safeProfile.singleton }),
      client.getBytecode({ address: safeProfile.proxyFactory }),
      client.getBytecode({ address: safeProfile.fallbackHandler }),
    ])
  assert(wovenCode && wovenCode !== "0x", "WOVEN token has no deployed code.")
  const safeRuntimeCodehash = assertPinnedBytecode(
    safeCode,
    safeProfile.proxyRuntimeCodehash,
    "Protocol Safe proxy",
  )
  const proxyFactoryRuntimeCodehash = assertPinnedBytecode(
    proxyFactoryCode,
    safeProfile.proxyFactoryRuntimeCodehash,
    "Safe proxy factory",
  )
  const singletonRuntimeCodehash = assertPinnedBytecode(
    singletonCode,
    safeProfile.singletonRuntimeCodehash,
    "Safe singleton",
  )
  const fallbackHandlerRuntimeCodehash = assertPinnedBytecode(
    fallbackHandlerCode,
    safeProfile.fallbackHandlerRuntimeCodehash,
    "Safe fallback handler",
  )

  const transactionHash = args["safe-creation-tx"]
  if (!/^0x[0-9a-f]{64}$/i.test(transactionHash || "")) {
    throw new Error("--safe-creation-tx must be the confirmed Safe creation transaction hash.")
  }
  const [transaction, receipt] = await Promise.all([
    client.getTransaction({ hash: transactionHash }),
    client.getTransactionReceipt({ hash: transactionHash }),
  ])
  const creationEvidence = validateSafeCreationEvidence({
    safeAddress,
    expectedOwner: owner,
    transaction,
    receipt,
  })

  const [name, symbol, decimals, totalSupply, mode, tokenOwner] = await Promise.all(
    ["name", "symbol", "decimals", "totalSupply", "_mode", "owner"].map((functionName) =>
      client.readContract({ address: wovenAddress, abi: wovenAbi, functionName }),
    ),
  )
  assert(name === "Woven Stocks", "Unexpected WOVEN name.")
  assert(symbol === "WOVEN", "Unexpected WOVEN symbol.")
  assert(decimals === 18, "Unexpected WOVEN decimals.")
  assert(totalSupply === 1_000_000_000n * 10n ** 18n, "Unexpected WOVEN supply.")
  assert(mode === 0n, "WOVEN has not graduated from Four.meme.")
  assert(getAddress(tokenOwner) === zeroAddress, "WOVEN ownership is not renounced.")

  const [version, singleton, owners, threshold, modulePage, guardWord, fallbackWord] =
    await Promise.all([
      client.readContract({ address: safeAddress, abi: safeAbi, functionName: "VERSION" }),
      client.readContract({ address: safeAddress, abi: safeAbi, functionName: "masterCopy" }),
      client.readContract({ address: safeAddress, abi: safeAbi, functionName: "getOwners" }),
      client.readContract({ address: safeAddress, abi: safeAbi, functionName: "getThreshold" }),
      client.readContract({
        address: safeAddress,
        abi: safeAbi,
        functionName: "getModulesPaginated",
        args: [safeProfile.sentinel, 1n],
      }),
      client.readContract({
        address: safeAddress,
        abi: safeAbi,
        functionName: "getStorageAt",
        args: [safeProfile.guardStorageSlot, 1n],
      }),
      client.readContract({
        address: safeAddress,
        abi: safeAbi,
        functionName: "getStorageAt",
        args: [safeProfile.fallbackHandlerStorageSlot, 1n],
      }),
    ])
  const [modules, nextModule] = modulePage
  const guard = storageWordAddress(guardWord, "Safe guard")
  const fallbackHandler = storageWordAddress(fallbackWord, "Safe fallback handler")

  assert(version === safeProfile.version, "Unexpected Safe version.")
  assert(getAddress(singleton) === safeProfile.singleton, "Unexpected Safe singleton.")
  assert(owners.length === 1 && getAddress(owners[0]) === owner, "Unexpected Safe owner set.")
  assert(threshold === 1n, "Unexpected Safe threshold.")
  assert(
    modules.length === 0 && getAddress(nextModule) === safeProfile.sentinel,
    "Safe modules are enabled.",
  )
  assert(guard === zeroAddress, "Safe guard is enabled.")
  assert(fallbackHandler === safeProfile.fallbackHandler, "Unexpected Safe fallback handler.")

  process.stdout.write(
    `${JSON.stringify(
      {
        schema: "woven-launch-preflight/v1",
        network: network.key,
        chainId,
        woven: {
          address: wovenAddress,
          name,
          symbol,
          decimals,
          totalSupply: totalSupply.toString(),
          fourMemeMode: mode.toString(),
          owner: getAddress(tokenOwner),
        },
        safe: {
          address: safeAddress,
          version,
          singleton: getAddress(singleton),
          singletonRuntimeCodehash,
          owners: owners.map((safeOwner) => getAddress(safeOwner)),
          threshold: threshold.toString(),
          modules,
          guard,
          fallbackHandler,
          fallbackHandlerRuntimeCodehash,
          runtimeCodehash: safeRuntimeCodehash,
          proxyFactory: safeProfile.proxyFactory,
          proxyFactoryRuntimeCodehash,
          creationEvidence,
        },
        treasury: safeAddress,
        result: "pass",
      },
      null,
      2,
    )}\n`,
  )
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Launch preflight failed: ${message}\n`)
  process.exitCode = 1
})
