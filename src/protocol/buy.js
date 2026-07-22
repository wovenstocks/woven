import { keccak256, stringToHex } from "viem"
import { wovenContracts } from "../config/contracts"
import {
  assetRegistryAbi,
  basketFactoryAbi,
  basketTokenAbi,
  erc20Abi,
  exactOutputAdapterAbi,
  oneClickBasketRouterAbi,
} from "./abis"
import { getBasketRequiredUnits, verifyBasketRecipe } from "./basket"
import { requireOneClickContracts, verifyOneClickContracts } from "./configuration"
import { ProtocolError, runProtocolAction, withCompletedTransactions } from "./errors"
import { mapWithConcurrency, readContract } from "./reads"
import { executeContractWrite } from "./transactions"
import {
  BNB_CONFIGURED_CHAIN_ID,
  MAX_UINT256,
  ZERO_ADDRESS,
  assertDecimals,
  formatTokenAmount,
  normalizeAddress,
  parseBasisPoints,
  parseTokenAmount,
  sanitizeTokenSymbol,
} from "./validation"

const bytes32Pattern = /^0x[a-fA-F0-9]{64}$/
const zeroBytes32Pattern = /^0x0{64}$/i
const MAX_SAFE_ROUTED_CONSTITUENTS = 20n
const MAX_SAFE_DEADLINE_WINDOW = 60n * 60n
const DEFAULT_SLIPPAGE_BPS = 100
const MAX_SLIPPAGE_BPS = 2_000
const DEFAULT_QUOTE_VALIDITY_SECONDS = 5n * 60n
const MAX_QUOTE_VALIDITY_SECONDS = 10n * 60n
const MAX_QUOTE_ADAPTERS = 8
const MAX_ROUTES_PER_ADAPTER = 32
const MAX_TOTAL_QUOTE_ROUTES = 128
const QUOTE_SOURCE_KIND = "onchain-constructor-bound-exact-output"
const QUOTE_SOURCE_VERSION = 1
const BSC_USDC_DECIMALS = 18

function requireUint256(value, label, { allowZero = false } = {}) {
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value > MAX_UINT256 ||
    (!allowZero && value === 0n)
  ) {
    throw new ProtocolError("INVALID_QUOTE", `${label} is not a valid raw token amount.`, {
      details: { label },
    })
  }
  return value
}

function requireBytes32(value, label, { allowZero = false } = {}) {
  if (
    typeof value !== "string" ||
    !bytes32Pattern.test(value) ||
    (!allowZero && zeroBytes32Pattern.test(value))
  ) {
    throw new ProtocolError("INVALID_QUOTE", `${label} is not a valid bytes32 value.`, {
      details: { label },
    })
  }
  return value.toLowerCase()
}

function requireAddressMatch(value, expected, label) {
  const address = normalizeAddress(value, label)
  if (address !== expected) {
    throw new ProtocolError(
      "QUOTE_CONTEXT_MISMATCH",
      "The USDC quote does not match the current wallet, chain, or product.",
      { details: { label, expected, actual: address } },
    )
  }
  return address
}

function requireQuoteEnvelope(options, addresses, account, basketAddress, recipient) {
  const quote = options.quote
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) {
    throw new ProtocolError(
      "QUOTE_REQUIRED",
      "A current, bounded USDC quote is required before enabling this action.",
    )
  }
  if (quote.chainId !== BNB_CONFIGURED_CHAIN_ID) {
    throw new ProtocolError(
      "QUOTE_CHAIN_MISMATCH",
      `Refresh the quote on ${wovenContracts.networkName} before continuing.`,
      {
        details: {
          expectedChainId: BNB_CONFIGURED_CHAIN_ID,
          actualChainId: quote.chainId ?? null,
        },
      },
    )
  }

  requireAddressMatch(quote.router, addresses.oneClickRouter, "Quote router")
  requireAddressMatch(quote.usdc, addresses.usdc, "Quote USDC")
  requireAddressMatch(quote.basket, basketAddress, "Quote basket")
  requireAddressMatch(quote.account, account, "Quote payer")
  requireAddressMatch(quote.recipient, recipient, "Quote recipient")

  if (quote.usdcDecimals !== BSC_USDC_DECIMALS || quote.usdcSymbol !== "USDC") {
    throw new ProtocolError(
      "QUOTE_USDC_MISMATCH",
      "The quote does not use the configured 18-decimal BSC USDC token.",
    )
  }

  if (!Array.isArray(quote.legs) || quote.legs.length === 0) {
    throw new ProtocolError("INVALID_QUOTE", "The USDC quote does not contain swap routes.")
  }

  return Object.freeze({
    ...quote,
    grossBasketAmount: requireUint256(quote.grossBasketAmount, "Gross basket amount"),
    expectedTotalUsdcIn: requireUint256(quote.expectedTotalUsdcIn, "Expected total USDC input"),
    maxTotalUsdcIn: requireUint256(quote.maxTotalUsdcIn, "Maximum total USDC input"),
    deadline: requireUint256(quote.deadline, "Quote deadline"),
    quoteBlockNumber: requireUint256(quote.quoteBlockNumber, "Quote block number", {
      allowZero: true,
    }),
    quoteBlockHash: requireBytes32(quote.quoteBlockHash, "Quote block hash"),
    quoteBlockTimestamp: requireUint256(quote.quoteBlockTimestamp, "Quote block timestamp", {
      allowZero: true,
    }),
    slippageBps: parseSlippageBps(quote.slippageBps),
    source: requireQuoteSource(quote.source),
  })
}

async function readChainContext(publicClient) {
  if (
    !publicClient ||
    typeof publicClient.getChainId !== "function" ||
    typeof publicClient.getBlock !== "function"
  ) {
    throw new ProtocolError("RPC_UNAVAILABLE", "BNB Chain quote verification is unavailable.")
  }

  let context
  try {
    context = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlock({ blockTag: "latest" }),
    ])
  } catch (error) {
    throw new ProtocolError("RPC_UNAVAILABLE", "BNB Chain quote verification is unavailable.", {
      cause: error,
      retryable: true,
    })
  }
  const [chainId, block] = context

  if (chainId !== BNB_CONFIGURED_CHAIN_ID) {
    throw new ProtocolError(
      "CHAIN_MISMATCH",
      `The quote RPC must use ${wovenContracts.networkName}.`,
      { details: { expectedChainId: BNB_CONFIGURED_CHAIN_ID, actualChainId: chainId } },
    )
  }
  if (
    typeof block?.number !== "bigint" ||
    block.number < 0n ||
    typeof block?.timestamp !== "bigint" ||
    block.timestamp < 0n ||
    typeof block?.hash !== "string" ||
    !bytes32Pattern.test(block.hash) ||
    zeroBytes32Pattern.test(block.hash)
  ) {
    throw new ProtocolError("INVALID_CHAIN_STATE", "BNB Chain returned invalid block metadata.")
  }

  return Object.freeze({
    chainId,
    number: block.number,
    hash: block.hash.toLowerCase(),
    timestamp: block.timestamp,
  })
}

function parseSlippageBps(value = DEFAULT_SLIPPAGE_BPS) {
  return parseBasisPoints(value, { label: "USDC slippage", max: MAX_SLIPPAGE_BPS })
}

function applySlippageCeil(amount, slippageBps) {
  const raw = requireUint256(amount, "Expected USDC input")
  const numerator = raw * BigInt(10_000 + slippageBps)
  const maximum = (numerator + 9_999n) / 10_000n
  if (maximum > MAX_UINT256) {
    throw new ProtocolError("INVALID_QUOTE", "The quoted USDC maximum is too large.")
  }
  return maximum
}

function requireQuoteValiditySeconds(value, maximumWindow) {
  const safeMaximum =
    maximumWindow < MAX_QUOTE_VALIDITY_SECONDS ? maximumWindow : MAX_QUOTE_VALIDITY_SECONDS
  const defaultValue =
    DEFAULT_QUOTE_VALIDITY_SECONDS < safeMaximum ? DEFAULT_QUOTE_VALIDITY_SECONDS : safeMaximum
  const parsed = value === undefined ? defaultValue : value
  const seconds =
    typeof parsed === "bigint"
      ? parsed
      : Number.isSafeInteger(parsed) && parsed > 0
        ? BigInt(parsed)
        : null
  if (seconds === null || seconds <= 0n || seconds > safeMaximum) {
    throw new ProtocolError(
      "INVALID_QUOTE_VALIDITY",
      `Quote validity must be between 1 and ${safeMaximum} seconds.`,
    )
  }
  return seconds
}

function requireQuoteSource(source) {
  if (
    !source ||
    typeof source !== "object" ||
    source.kind !== QUOTE_SOURCE_KIND ||
    source.version !== QUOTE_SOURCE_VERSION
  ) {
    throw new ProtocolError(
      "INVALID_QUOTE_SOURCE",
      "The USDC quote does not come from Woven's onchain route discovery.",
    )
  }
  return Object.freeze({ kind: QUOTE_SOURCE_KIND, version: QUOTE_SOURCE_VERSION })
}

function createPinnedPublicClient(publicClient, blockNumber) {
  return Object.freeze({
    getChainId: () => publicClient.getChainId(),
    getBlock: (parameters) => publicClient.getBlock(parameters),
    getBytecode: (parameters) => publicClient.getBytecode({ ...parameters, blockNumber }),
    readContract: (parameters) => publicClient.readContract({ ...parameters, blockNumber }),
    simulateContract: (parameters) => publicClient.simulateContract({ ...parameters, blockNumber }),
  })
}

async function assertQuoteBlockCanonical(publicClient, quote) {
  if (!publicClient || typeof publicClient.getBlock !== "function") {
    throw new ProtocolError("RPC_UNAVAILABLE", "BNB Chain block verification is unavailable.")
  }

  let block
  try {
    block = await publicClient.getBlock({ blockNumber: quote.quoteBlockNumber })
  } catch (error) {
    throw new ProtocolError(
      "QUOTE_BLOCK_UNAVAILABLE",
      "The block used for this USDC quote is no longer available.",
      { cause: error, retryable: true },
    )
  }
  if (
    typeof block?.number !== "bigint" ||
    block.number !== quote.quoteBlockNumber ||
    typeof block?.hash !== "string" ||
    block.hash.toLowerCase() !== quote.quoteBlockHash.toLowerCase() ||
    typeof block?.timestamp !== "bigint" ||
    block.timestamp !== quote.quoteBlockTimestamp
  ) {
    throw new ProtocolError(
      "QUOTE_BLOCK_REORGED",
      "The BNB Chain block used for this quote changed. Refresh the quote before signing.",
    )
  }
  return block
}

async function verifyRouterWiring(publicClient, addresses) {
  const [
    routerUsdc,
    routerFactory,
    routerRegistry,
    factoryRegistry,
    adapters,
    maxConstituents,
    maxWindow,
  ] = await Promise.all([
    readContract(publicClient, {
      address: addresses.oneClickRouter,
      abi: oneClickBasketRouterAbi,
      functionName: "usdc",
    }),
    readContract(publicClient, {
      address: addresses.oneClickRouter,
      abi: oneClickBasketRouterAbi,
      functionName: "basketFactory",
    }),
    readContract(publicClient, {
      address: addresses.oneClickRouter,
      abi: oneClickBasketRouterAbi,
      functionName: "assetRegistry",
    }),
    readContract(publicClient, {
      address: addresses.basketFactory,
      abi: basketFactoryAbi,
      functionName: "assetRegistry",
    }),
    readContract(publicClient, {
      address: addresses.oneClickRouter,
      abi: oneClickBasketRouterAbi,
      functionName: "adapters",
    }),
    readContract(publicClient, {
      address: addresses.oneClickRouter,
      abi: oneClickBasketRouterAbi,
      functionName: "MAX_ROUTED_CONSTITUENTS",
    }),
    readContract(publicClient, {
      address: addresses.oneClickRouter,
      abi: oneClickBasketRouterAbi,
      functionName: "MAX_DEADLINE_WINDOW",
    }),
  ])

  const mismatches = [
    [routerUsdc, addresses.usdc, "USDC"],
    [routerFactory, addresses.basketFactory, "basket factory"],
    [routerRegistry, addresses.assetRegistry, "asset registry"],
    [factoryRegistry, addresses.assetRegistry, "factory asset registry"],
  ]
  for (const [actual, expected, label] of mismatches) {
    if (normalizeAddress(actual, `Router ${label}`) !== expected) {
      throw new ProtocolError(
        "CONTRACT_CONFIGURATION_MISMATCH",
        `The one-click router does not reference the configured ${label}.`,
      )
    }
  }
  if (
    typeof maxConstituents !== "bigint" ||
    maxConstituents <= 0n ||
    maxConstituents > MAX_SAFE_ROUTED_CONSTITUENTS ||
    typeof maxWindow !== "bigint" ||
    maxWindow <= 0n ||
    maxWindow > MAX_SAFE_DEADLINE_WINDOW
  ) {
    throw new ProtocolError(
      "CONTRACT_CONFIGURATION_MISMATCH",
      "The one-click router returned unsafe route limits.",
    )
  }
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new ProtocolError(
      "CONTRACT_CONFIGURATION_MISMATCH",
      "The one-click router does not expose an approved adapter set.",
    )
  }

  const seen = new Set()
  const normalizedAdapters = adapters.map((adapter, index) => {
    const address = normalizeAddress(adapter, `Approved adapter ${index + 1}`)
    const key = address.toLowerCase()
    if (seen.has(key)) {
      throw new ProtocolError(
        "CONTRACT_CONFIGURATION_MISMATCH",
        "The one-click router returned a duplicate adapter.",
      )
    }
    seen.add(key)
    return address
  })

  return Object.freeze({
    adapters: Object.freeze(normalizedAdapters),
    maxConstituents,
    maxDeadlineWindow: maxWindow,
  })
}

function validateBasketState(state, grossBasketAmount) {
  if (typeof state.isFullyBacked !== "boolean" || typeof state.mintPaused !== "boolean") {
    throw new ProtocolError("INVALID_BASKET_STATE", "The basket returned invalid mint controls.")
  }
  if (
    typeof state.totalSupply !== "bigint" ||
    state.totalSupply < 0n ||
    typeof state.supplyCap !== "bigint" ||
    state.supplyCap <= 0n ||
    !Number.isInteger(state.mintFeeBps) ||
    state.mintFeeBps < 0 ||
    state.mintFeeBps > 50
  ) {
    throw new ProtocolError("INVALID_BASKET_STATE", "The basket returned invalid supply data.")
  }

  const feeAmount = (grossBasketAmount * BigInt(state.mintFeeBps)) / 10_000n
  const netBasketOut = grossBasketAmount - feeAmount
  if (netBasketOut <= 0n) {
    throw new ProtocolError("INVALID_BASKET_STATE", "The basket returned invalid mint terms.")
  }

  return Object.freeze({
    ...state,
    feeAmount,
    netBasketOut,
    supplyAvailable: state.totalSupply + grossBasketAmount <= state.supplyCap,
  })
}

function validateQuoteLeg(leg, constituent, index, slippageBps) {
  if (!leg || typeof leg !== "object" || Array.isArray(leg)) {
    throw new ProtocolError("INVALID_QUOTE", `Swap route ${index + 1} is invalid.`)
  }
  const expectedToken = normalizeAddress(leg.expectedToken, `Quote token ${index + 1}`)
  const expectedAmountOut = requireUint256(leg.expectedAmountOut, `Quote output ${index + 1}`)
  if (expectedToken !== constituent.token || expectedAmountOut !== constituent.amount) {
    throw new ProtocolError(
      "QUOTE_RECIPE_MISMATCH",
      "The USDC quote does not match the basket's current raw constituent requirements.",
      { details: { index } },
    )
  }

  const adapter = normalizeAddress(leg.adapter, `Quote adapter ${index + 1}`)
  const routeId = requireBytes32(leg.routeId, `Quote route ID ${index + 1}`)
  const expectedUsdcIn = requireUint256(leg.expectedUsdcIn, `Expected USDC input ${index + 1}`)
  const maxUsdcIn = requireUint256(leg.maxUsdcIn, `Maximum USDC input ${index + 1}`)
  if (maxUsdcIn !== applySlippageCeil(expectedUsdcIn, slippageBps)) {
    throw new ProtocolError(
      "QUOTE_SLIPPAGE_MISMATCH",
      "A route maximum does not match the reviewed USDC quote and slippage.",
      { details: { index } },
    )
  }
  if (
    !leg.source ||
    leg.source.kind !== QUOTE_SOURCE_KIND ||
    leg.source.version !== QUOTE_SOURCE_VERSION ||
    normalizeAddress(leg.source.adapter, `Quote source adapter ${index + 1}`) !== adapter ||
    requireBytes32(leg.source.routeId, `Quote source route ID ${index + 1}`) !== routeId
  ) {
    throw new ProtocolError(
      "INVALID_QUOTE_SOURCE",
      "A route does not match its constructor-bound onchain quote source.",
      { details: { index } },
    )
  }

  return Object.freeze({
    expectedToken,
    adapter,
    routeId,
    expectedAmountOut,
    expectedUsdcIn,
    maxUsdcIn,
    gasEstimate: requireUint256(leg.gasEstimate, `Route gas estimate ${index + 1}`, {
      allowZero: true,
    }),
    adapterCodehash: requireBytes32(leg.adapterCodehash, `Adapter code hash ${index + 1}`),
    routeHash: requireBytes32(leg.routeHash, `Adapter route hash ${index + 1}`),
    source: Object.freeze({
      kind: QUOTE_SOURCE_KIND,
      version: QUOTE_SOURCE_VERSION,
      adapter,
      routeId,
    }),
  })
}

async function verifyAdapterIdentity(publicClient, addresses, adapter, label) {
  const [pinnedCodehash, inputToken, bytecode] = await Promise.all([
    readContract(publicClient, {
      address: addresses.oneClickRouter,
      abi: oneClickBasketRouterAbi,
      functionName: "adapterCodehash",
      args: [adapter],
    }),
    readContract(publicClient, {
      address: adapter,
      abi: exactOutputAdapterAbi,
      functionName: "inputToken",
    }),
    publicClient.getBytecode({ address: adapter }),
  ])
  const adapterCodehash = requireBytes32(pinnedCodehash, `${label} code hash`)
  const currentCodehash =
    typeof bytecode === "string" && /^0x[0-9a-f]+$/i.test(bytecode) && bytecode !== "0x"
      ? keccak256(bytecode).toLowerCase()
      : null
  if (!currentCodehash || currentCodehash !== adapterCodehash) {
    throw new ProtocolError(
      "ADAPTER_CODE_CHANGED",
      "A swap adapter does not match the code pinned by the Woven router.",
      { details: { adapter } },
    )
  }
  if (normalizeAddress(inputToken, `${label} input`) !== addresses.usdc) {
    throw new ProtocolError(
      "ADAPTER_INPUT_MISMATCH",
      "A swap adapter does not use the configured USDC token.",
      { details: { adapter } },
    )
  }
  return Object.freeze({ adapter, adapterCodehash })
}

async function readBoundRoute(publicClient, identity, routeId, label) {
  const [routeOutput, routeHash] = await Promise.all([
    readContract(publicClient, {
      address: identity.adapter,
      abi: exactOutputAdapterAbi,
      functionName: "routeOutput",
      args: [routeId],
    }),
    readContract(publicClient, {
      address: identity.adapter,
      abi: exactOutputAdapterAbi,
      functionName: "routeHash",
      args: [routeId],
    }),
  ])
  return Object.freeze({
    ...identity,
    routeId,
    routeOutput: normalizeAddress(routeOutput, `${label} output`),
    routeHash: requireBytes32(routeHash, `${label} hash`),
  })
}

async function verifyBoundRoute(
  publicClient,
  addresses,
  approvedAdapters,
  leg,
  constituent,
  index,
) {
  if (!approvedAdapters.includes(leg.adapter)) {
    throw new ProtocolError(
      "UNAPPROVED_ROUTE_ADAPTER",
      "The USDC quote references an adapter that is not approved by the configured router.",
      { details: { index, adapter: leg.adapter } },
    )
  }

  const identity = await verifyAdapterIdentity(
    publicClient,
    addresses,
    leg.adapter,
    `Adapter ${index + 1}`,
  )
  const route = await readBoundRoute(
    publicClient,
    identity,
    leg.routeId,
    `Adapter route ${index + 1}`,
  )
  if (route.routeOutput !== constituent.token) {
    throw new ProtocolError(
      "ADAPTER_ROUTE_MISMATCH",
      "A constructor-bound route does not output the required basket constituent.",
      { details: { index, adapter: leg.adapter, routeId: leg.routeId } },
    )
  }
  if (route.adapterCodehash !== leg.adapterCodehash || route.routeHash !== leg.routeHash) {
    throw new ProtocolError(
      "QUOTE_SOURCE_CHANGED",
      "A constructor-bound quote source changed. Refresh the quote before signing.",
      { details: { index, adapter: leg.adapter, routeId: leg.routeId } },
    )
  }

  return Object.freeze({
    ...leg,
    uiMultiplier: constituent.uiMultiplier,
    newUiMultiplier: constituent.newUiMultiplier,
    effectiveAt: constituent.effectiveAt,
  })
}

async function enumerateBoundRoutes(publicClient, addresses, wiring, readConcurrency) {
  if (wiring.adapters.length > MAX_QUOTE_ADAPTERS) {
    throw new ProtocolError(
      "ROUTE_ENUMERATION_LIMIT",
      "The router exposes more adapters than Woven can quote safely.",
    )
  }

  const routeGroups = await mapWithConcurrency(
    wiring.adapters,
    readConcurrency,
    async (adapter, adapterIndex) => {
      const identity = await verifyAdapterIdentity(
        publicClient,
        addresses,
        adapter,
        `Approved adapter ${adapterIndex + 1}`,
      )
      const routeIds = await readContract(publicClient, {
        address: adapter,
        abi: exactOutputAdapterAbi,
        functionName: "routeIds",
      })
      if (
        !Array.isArray(routeIds) ||
        routeIds.length === 0 ||
        routeIds.length > MAX_ROUTES_PER_ADAPTER
      ) {
        throw new ProtocolError(
          "ROUTE_ENUMERATION_LIMIT",
          "An approved adapter exposes an invalid number of constructor-bound routes.",
          { details: { adapter } },
        )
      }
      const seen = new Set()
      const normalizedRouteIds = routeIds.map((routeId, routeIndex) => {
        const normalized = requireBytes32(
          routeId,
          `Adapter ${adapterIndex + 1} route ${routeIndex + 1}`,
        )
        if (seen.has(normalized)) {
          throw new ProtocolError(
            "CONTRACT_CONFIGURATION_MISMATCH",
            "An approved adapter exposes a duplicate route ID.",
            { details: { adapter, routeId: normalized } },
          )
        }
        seen.add(normalized)
        return normalized
      })
      return Object.freeze({ adapterIndex, identity, routeIds: Object.freeze(normalizedRouteIds) })
    },
  )
  const routeCount = routeGroups.reduce((total, group) => total + group.routeIds.length, 0)
  if (routeCount > MAX_TOTAL_QUOTE_ROUTES) {
    throw new ProtocolError(
      "ROUTE_ENUMERATION_LIMIT",
      "The router exposes more constructor-bound routes than Woven can quote safely.",
    )
  }

  const detailedGroups = await mapWithConcurrency(
    routeGroups,
    readConcurrency,
    ({ adapterIndex, identity, routeIds }) =>
      mapWithConcurrency(routeIds, readConcurrency, (routeId, routeIndex) =>
        readBoundRoute(
          publicClient,
          identity,
          routeId,
          `Adapter ${adapterIndex + 1} route ${routeIndex + 1}`,
        ),
      ),
  )
  const routes = detailedGroups.flat()
  return Object.freeze(routes)
}

async function selectBestRouteQuote(options) {
  const candidates = options.routes.filter(
    (route) => route.routeOutput === options.constituent.token,
  )
  if (candidates.length === 0) {
    throw new ProtocolError(
      "NO_CONSTRUCTOR_BOUND_ROUTE",
      "No approved onchain route exists for a required basket constituent.",
      { details: { token: options.constituent.token } },
    )
  }

  const quoted = await Promise.all(
    candidates.map(async (route) => {
      try {
        const simulation = await options.publicClient.simulateContract({
          account: options.account,
          address: route.adapter,
          abi: exactOutputAdapterAbi,
          functionName: "quoteExactOutput",
          args: [options.constituent.token, options.constituent.amount, route.routeId],
        })
        const [amountIn, gasEstimate] = Array.isArray(simulation?.result) ? simulation.result : []
        if (
          typeof amountIn !== "bigint" ||
          amountIn <= 0n ||
          typeof gasEstimate !== "bigint" ||
          gasEstimate < 0n
        ) {
          return null
        }
        return Object.freeze({ ...route, amountIn, gasEstimate })
      } catch {
        return null
      }
    }),
  )
  const executable = quoted.filter(Boolean).sort((left, right) => {
    if (left.amountIn !== right.amountIn) return left.amountIn < right.amountIn ? -1 : 1
    if (left.gasEstimate !== right.gasEstimate) {
      return left.gasEstimate < right.gasEstimate ? -1 : 1
    }
    const leftKey = `${left.adapter.toLowerCase()}:${left.routeId}`
    const rightKey = `${right.adapter.toLowerCase()}:${right.routeId}`
    return leftKey.localeCompare(rightKey)
  })
  const best = executable[0]
  if (!best) {
    throw new ProtocolError(
      "NO_EXECUTABLE_ROUTE",
      "No approved route can buy the exact required constituent amount at the quote block.",
      { details: { token: options.constituent.token, routesTried: candidates.length } },
    )
  }

  const maxUsdcIn = applySlippageCeil(best.amountIn, options.slippageBps)
  return Object.freeze({
    expectedToken: options.constituent.token,
    adapter: best.adapter,
    routeId: best.routeId,
    expectedAmountOut: options.constituent.amount,
    expectedUsdcIn: best.amountIn,
    maxUsdcIn,
    gasEstimate: best.gasEstimate,
    adapterCodehash: best.adapterCodehash,
    routeHash: best.routeHash,
    source: Object.freeze({
      kind: QUOTE_SOURCE_KIND,
      version: QUOTE_SOURCE_VERSION,
      adapter: best.adapter,
      routeId: best.routeId,
    }),
  })
}

async function verifyQuotedRouteAmounts(options) {
  await mapWithConcurrency(options.legs, options.readConcurrency, async (leg, index) => {
    let simulation
    try {
      simulation = await options.publicClient.simulateContract({
        account: options.account,
        address: leg.adapter,
        abi: exactOutputAdapterAbi,
        functionName: "quoteExactOutput",
        args: [leg.expectedToken, leg.expectedAmountOut, leg.routeId],
      })
    } catch (error) {
      throw new ProtocolError(
        "QUOTE_SOURCE_UNAVAILABLE",
        "A selected onchain route can no longer reproduce the reviewed quote.",
        { cause: error, details: { index, adapter: leg.adapter, routeId: leg.routeId } },
      )
    }
    const [amountIn, gasEstimate] = Array.isArray(simulation?.result) ? simulation.result : []
    if (amountIn !== leg.expectedUsdcIn || gasEstimate !== leg.gasEstimate) {
      throw new ProtocolError(
        "QUOTE_SOURCE_MISMATCH",
        "A selected onchain route does not reproduce the reviewed USDC amount.",
        { details: { index, adapter: leg.adapter, routeId: leg.routeId } },
      )
    }
  })
}

export async function createBasketBuyQuote(options) {
  return runProtocolAction("create onchain USDC quote", async () => {
    if (
      !options.publicClient ||
      typeof options.publicClient.simulateContract !== "function" ||
      typeof options.publicClient.readContract !== "function" ||
      typeof options.publicClient.getBytecode !== "function"
    ) {
      throw new ProtocolError("RPC_UNAVAILABLE", "Onchain USDC quoting is unavailable.")
    }

    const addresses = requireOneClickContracts(options.addresses || wovenContracts)
    const account = normalizeAddress(options.account, "Wallet account")
    const basketAddress = normalizeAddress(options.basketAddress, "Basket address")
    const recipient = normalizeAddress(options.recipient || account, "Basket recipient")
    const slippageBps = parseSlippageBps(options.slippageBps)
    const chain = await readChainContext(options.publicClient)
    const pinnedClient = createPinnedPublicClient(options.publicClient, chain.number)

    await verifyOneClickContracts(pinnedClient, addresses)
    const wiring = await verifyRouterWiring(pinnedClient, addresses)
    const validitySeconds = requireQuoteValiditySeconds(
      options.quoteValiditySeconds,
      wiring.maxDeadlineWindow,
    )
    await verifyBasketRecipe({ ...options, publicClient: pinnedClient, basketAddress })

    const [creator, requirements, usdcDecimals, usdcSymbol] = await Promise.all([
      readContract(pinnedClient, {
        address: addresses.basketFactory,
        abi: basketFactoryAbi,
        functionName: "creatorOf",
        args: [basketAddress],
      }),
      getBasketRequiredUnits({
        ...options,
        publicClient: pinnedClient,
        basketAddress,
        amount: options.amount,
        includeMetadata: true,
      }),
      readContract(pinnedClient, {
        address: addresses.usdc,
        abi: erc20Abi,
        functionName: "decimals",
      }),
      readContract(pinnedClient, {
        address: addresses.usdc,
        abi: erc20Abi,
        functionName: "symbol",
      }),
    ])
    if (typeof creator !== "string" || creator.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      throw new ProtocolError(
        "UNRECOGNIZED_BASKET",
        "This token was not created by the configured Woven factory.",
      )
    }
    if (requirements.constituents.length > Number(wiring.maxConstituents)) {
      throw new ProtocolError(
        "BASKET_TOO_LARGE_FOR_ROUTER",
        "This basket contains more constituents than the one-click router supports.",
      )
    }
    if (requirements.constituents.some((constituent) => constituent.token === addresses.usdc)) {
      throw new ProtocolError(
        "USDC_CONSTITUENT_UNSUPPORTED",
        "The one-click router does not support baskets that contain USDC directly.",
      )
    }
    const decimals = assertDecimals(usdcDecimals, "USDC decimals")
    const symbol = sanitizeTokenSymbol(usdcSymbol)
    if (decimals !== BSC_USDC_DECIMALS || symbol !== "USDC") {
      throw new ProtocolError(
        "UNSUPPORTED_USDC_CONFIGURATION",
        "The configured input token is not the expected 18-decimal BSC USDC.",
      )
    }

    const supported = await Promise.all(
      requirements.constituents.map((constituent) =>
        readContract(pinnedClient, {
          address: addresses.assetRegistry,
          abi: assetRegistryAbi,
          functionName: "isSupported",
          args: [constituent.token],
        }),
      ),
    )
    if (supported.some((value) => value !== true)) {
      throw new ProtocolError(
        "UNSUPPORTED_CONSTITUENT",
        "At least one basket constituent is no longer approved by the canonical registry.",
      )
    }

    const readConcurrency = options.readConcurrency || 4
    const routes = await enumerateBoundRoutes(pinnedClient, addresses, wiring, readConcurrency)
    const legs = await mapWithConcurrency(
      requirements.constituents,
      readConcurrency,
      (constituent) =>
        selectBestRouteQuote({
          publicClient: pinnedClient,
          account,
          constituent,
          routes,
          slippageBps,
        }),
    )
    const expectedTotalUsdcIn = legs.reduce((sum, leg) => sum + leg.expectedUsdcIn, 0n)
    const maxTotalUsdcIn = legs.reduce((sum, leg) => sum + leg.maxUsdcIn, 0n)
    if (
      expectedTotalUsdcIn <= 0n ||
      expectedTotalUsdcIn > MAX_UINT256 ||
      maxTotalUsdcIn < expectedTotalUsdcIn ||
      maxTotalUsdcIn > MAX_UINT256
    ) {
      throw new ProtocolError("INVALID_QUOTE", "The aggregate onchain USDC quote is invalid.")
    }

    const quote = Object.freeze({
      chainId: chain.chainId,
      router: addresses.oneClickRouter,
      usdc: addresses.usdc,
      usdcDecimals: decimals,
      usdcSymbol: symbol,
      basket: basketAddress,
      account,
      recipient,
      grossBasketAmount: requirements.basketAmount,
      basketAmountFormatted: requirements.basketAmountFormatted,
      slippageBps,
      expectedTotalUsdcIn,
      expectedTotalUsdcInFormatted: formatTokenAmount(expectedTotalUsdcIn, decimals),
      maxTotalUsdcIn,
      maxTotalUsdcInFormatted: formatTokenAmount(maxTotalUsdcIn, decimals),
      deadline: chain.timestamp + validitySeconds,
      quoteBlockNumber: chain.number,
      quoteBlockHash: chain.hash,
      quoteBlockTimestamp: chain.timestamp,
      source: Object.freeze({ kind: QUOTE_SOURCE_KIND, version: QUOTE_SOURCE_VERSION }),
      legs: Object.freeze(
        legs.map((leg) =>
          Object.freeze({
            ...leg,
            expectedUsdcInFormatted: formatTokenAmount(leg.expectedUsdcIn, decimals),
            maxUsdcInFormatted: formatTokenAmount(leg.maxUsdcIn, decimals),
          }),
        ),
      ),
    })
    await assertQuoteBlockCanonical(options.publicClient, quote)
    return quote
  })
}

function fingerprintBigint(value, label) {
  return requireUint256(value, label, { allowZero: true }).toString()
}

export function createBasketBuyQuoteFingerprint(snapshot) {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    snapshot.chainId !== BNB_CONFIGURED_CHAIN_ID ||
    snapshot.usdcDecimals !== BSC_USDC_DECIMALS ||
    snapshot.usdcSymbol !== "USDC" ||
    !Number.isInteger(snapshot.slippageBps) ||
    !Number.isInteger(snapshot.mintFeeBps) ||
    typeof snapshot.isFullyBacked !== "boolean" ||
    typeof snapshot.mintPaused !== "boolean" ||
    !Array.isArray(snapshot.legs) ||
    snapshot.legs.length === 0
  ) {
    throw new ProtocolError("INVALID_QUOTE", "The USDC quote snapshot is invalid.")
  }
  const source = requireQuoteSource(snapshot.source)
  const payload = [
    "WOVEN_ONE_CLICK_QUOTE_V2",
    String(snapshot.chainId),
    normalizeAddress(snapshot.account, "Quote payer").toLowerCase(),
    normalizeAddress(snapshot.router, "Quote router").toLowerCase(),
    normalizeAddress(snapshot.usdc, "Quote USDC").toLowerCase(),
    normalizeAddress(snapshot.basket, "Quote basket").toLowerCase(),
    normalizeAddress(snapshot.recipient, "Quote recipient").toLowerCase(),
    String(snapshot.usdcDecimals),
    snapshot.usdcSymbol,
    fingerprintBigint(snapshot.grossBasketAmount, "Gross basket amount"),
    fingerprintBigint(snapshot.minNetBasketOut, "Minimum basket output"),
    fingerprintBigint(snapshot.expectedTotalUsdcIn, "Expected total USDC input"),
    fingerprintBigint(snapshot.maxTotalUsdcIn, "Maximum total USDC input"),
    fingerprintBigint(snapshot.deadline, "Quote deadline"),
    fingerprintBigint(snapshot.quoteBlockNumber, "Quote block number"),
    requireBytes32(snapshot.quoteBlockHash, "Quote block hash"),
    fingerprintBigint(snapshot.quoteBlockTimestamp, "Quote block timestamp"),
    String(snapshot.slippageBps),
    source.kind,
    String(source.version),
    String(snapshot.mintFeeBps),
    fingerprintBigint(snapshot.supplyCap, "Basket supply cap"),
    Boolean(snapshot.isFullyBacked),
    Boolean(snapshot.mintPaused),
    snapshot.legs.map((leg, index) => [
      normalizeAddress(leg.expectedToken, `Quote token ${index + 1}`).toLowerCase(),
      normalizeAddress(leg.adapter, `Quote adapter ${index + 1}`).toLowerCase(),
      requireBytes32(leg.routeId, `Quote route ID ${index + 1}`),
      fingerprintBigint(leg.expectedAmountOut, `Quote output ${index + 1}`),
      fingerprintBigint(leg.expectedUsdcIn, `Expected USDC input ${index + 1}`),
      fingerprintBigint(leg.maxUsdcIn, `Maximum USDC input ${index + 1}`),
      fingerprintBigint(leg.gasEstimate, `Route gas estimate ${index + 1}`),
      requireBytes32(leg.adapterCodehash, `Adapter code hash ${index + 1}`),
      requireBytes32(leg.routeHash, `Adapter route hash ${index + 1}`),
      leg.source?.kind,
      String(leg.source?.version),
      normalizeAddress(leg.source?.adapter, `Quote source adapter ${index + 1}`).toLowerCase(),
      requireBytes32(leg.source?.routeId, `Quote source route ID ${index + 1}`),
      fingerprintBigint(leg.uiMultiplier, `UI multiplier ${index + 1}`),
      fingerprintBigint(leg.newUiMultiplier, `Pending UI multiplier ${index + 1}`),
      fingerprintBigint(leg.effectiveAt, `Multiplier effective time ${index + 1}`),
    ]),
  ]
  return keccak256(stringToHex(JSON.stringify(payload)))
}

function assertQuoteReviewCurrent(readiness, review) {
  if (!review || typeof review !== "object" || !bytes32Pattern.test(review.fingerprint || "")) {
    throw new ProtocolError(
      "QUOTE_REVIEW_REQUIRED",
      "Review a current USDC quote before opening the wallet.",
    )
  }
  if (review.fingerprint.toLowerCase() !== readiness.fingerprint.toLowerCase()) {
    throw new ProtocolError(
      "QUOTE_REVIEW_STALE",
      "The USDC quote, basket recipe, or corporate-action multiplier changed. Refresh the review before signing.",
    )
  }
}

function assertBuyPreconditions(readiness, { allowMissingApproval = false } = {}) {
  const disallowed = readiness.blockers.filter((blocker) =>
    allowMissingApproval && blocker === "APPROVAL_REQUIRED" ? false : true,
  )
  if (disallowed.length === 0) return

  const blocker = disallowed[0]
  const messages = {
    UNDERBACKED: "This basket is not fully backed. Buying is disabled until backing is restored.",
    MINT_PAUSED: "Minting is currently paused for this basket.",
    SUPPLY_CAP_EXCEEDED: "This purchase would exceed the basket supply cap.",
    INSUFFICIENT_USDC_BALANCE: "This wallet does not hold enough USDC for the reviewed maximum.",
    APPROVAL_REQUIRED: "Approve the reviewed USDC maximum before buying this basket.",
  }
  throw new ProtocolError(blocker, messages[blocker] || "The USDC purchase is not ready.")
}

export async function getBasketBuyReadiness(options) {
  return runProtocolAction("review USDC basket purchase", async () => {
    const addresses = requireOneClickContracts(options.addresses || wovenContracts)
    const account = normalizeAddress(options.account, "Wallet account")
    const basketAddress = normalizeAddress(options.basketAddress, "Basket address")
    const recipient = normalizeAddress(options.recipient || account, "Basket recipient")
    const quote = requireQuoteEnvelope(options, addresses, account, basketAddress, recipient)

    const chain = await readChainContext(options.publicClient)
    const pinnedClient = createPinnedPublicClient(options.publicClient, chain.number)
    await verifyOneClickContracts(pinnedClient, addresses)
    const wiring = await verifyRouterWiring(pinnedClient, addresses)
    if (chain.chainId !== quote.chainId) {
      throw new ProtocolError(
        "QUOTE_CHAIN_MISMATCH",
        "The USDC quote does not match the active BNB Chain network.",
      )
    }
    if (quote.quoteBlockNumber > chain.number || quote.quoteBlockTimestamp > chain.timestamp) {
      throw new ProtocolError(
        "QUOTE_BLOCK_INVALID",
        "The USDC quote references a future BNB Chain block.",
      )
    }
    await assertQuoteBlockCanonical(options.publicClient, quote)
    if (quote.deadline <= chain.timestamp) {
      throw new ProtocolError(
        "QUOTE_EXPIRED",
        "This USDC quote expired. Refresh it before signing.",
      )
    }
    if (quote.deadline > chain.timestamp + wiring.maxDeadlineWindow) {
      throw new ProtocolError(
        "QUOTE_DEADLINE_UNSAFE",
        "The USDC quote remains valid longer than the router permits.",
      )
    }
    if (
      quote.deadline > quote.quoteBlockTimestamp + wiring.maxDeadlineWindow ||
      quote.deadline > quote.quoteBlockTimestamp + MAX_QUOTE_VALIDITY_SECONDS
    ) {
      throw new ProtocolError(
        "QUOTE_DEADLINE_UNSAFE",
        "The USDC quote was created with an unsafe validity window.",
      )
    }

    const recipe = await verifyBasketRecipe({
      ...options,
      publicClient: pinnedClient,
      basketAddress,
    })
    const [creator, requirements] = await Promise.all([
      readContract(pinnedClient, {
        address: addresses.basketFactory,
        abi: basketFactoryAbi,
        functionName: "creatorOf",
        args: [basketAddress],
      }),
      getBasketRequiredUnits({
        ...options,
        publicClient: pinnedClient,
        basketAddress,
        amount: quote.grossBasketAmount,
        includeMetadata: true,
      }),
    ])
    if (typeof creator !== "string" || creator.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      throw new ProtocolError(
        "UNRECOGNIZED_BASKET",
        "This token was not created by the configured Woven factory.",
      )
    }
    if (requirements.constituents.length > Number(wiring.maxConstituents)) {
      throw new ProtocolError(
        "BASKET_TOO_LARGE_FOR_ROUTER",
        "This basket contains more constituents than the one-click router supports.",
      )
    }
    if (requirements.constituents.some((constituent) => constituent.token === addresses.usdc)) {
      throw new ProtocolError(
        "USDC_CONSTITUENT_UNSUPPORTED",
        "The one-click router does not support baskets that contain USDC directly.",
      )
    }
    if (options.amount !== undefined) {
      const requested = parseTokenAmount(options.amount, requirements.decimals, {
        label: "Basket amount",
      })
      if (requested !== quote.grossBasketAmount) {
        throw new ProtocolError(
          "QUOTE_AMOUNT_MISMATCH",
          "The USDC quote does not match the requested basket amount.",
        )
      }
    }
    if (quote.legs.length !== requirements.constituents.length) {
      throw new ProtocolError(
        "QUOTE_RECIPE_MISMATCH",
        "The USDC quote does not contain exactly one route per basket constituent.",
      )
    }

    const [
      isFullyBacked,
      mintPaused,
      totalSupply,
      supplyCap,
      mintFeeBps,
      usdcDecimals,
      usdcSymbol,
      usdcBalance,
      usdcAllowance,
      supported,
    ] = await Promise.all([
      readContract(pinnedClient, {
        address: basketAddress,
        abi: basketTokenAbi,
        functionName: "isFullyBacked",
      }),
      readContract(pinnedClient, {
        address: basketAddress,
        abi: basketTokenAbi,
        functionName: "mintPaused",
      }),
      readContract(pinnedClient, {
        address: basketAddress,
        abi: basketTokenAbi,
        functionName: "totalSupply",
      }),
      readContract(pinnedClient, {
        address: basketAddress,
        abi: basketTokenAbi,
        functionName: "supplyCap",
      }),
      readContract(pinnedClient, {
        address: basketAddress,
        abi: basketTokenAbi,
        functionName: "mintFeeBps",
      }),
      readContract(pinnedClient, {
        address: addresses.usdc,
        abi: erc20Abi,
        functionName: "decimals",
      }),
      readContract(pinnedClient, {
        address: addresses.usdc,
        abi: erc20Abi,
        functionName: "symbol",
      }),
      readContract(pinnedClient, {
        address: addresses.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      }),
      readContract(pinnedClient, {
        address: addresses.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, addresses.oneClickRouter],
      }),
      Promise.all(
        requirements.constituents.map((constituent) =>
          readContract(pinnedClient, {
            address: addresses.assetRegistry,
            abi: assetRegistryAbi,
            functionName: "isSupported",
            args: [constituent.token],
          }),
        ),
      ),
    ])
    if (supported.some((value) => value !== true)) {
      throw new ProtocolError(
        "UNSUPPORTED_CONSTITUENT",
        "At least one basket constituent is no longer approved by the canonical registry.",
      )
    }
    const basketState = validateBasketState(
      { isFullyBacked, mintPaused, totalSupply, supplyCap, mintFeeBps },
      quote.grossBasketAmount,
    )
    if (basketState.mintFeeBps !== recipe.mintFeeBps) {
      throw new ProtocolError(
        "BASKET_RECIPE_MISMATCH",
        "The basket mint fee does not match the reviewed recipe.",
      )
    }
    const decimals = assertDecimals(usdcDecimals, "USDC decimals")
    const symbol = sanitizeTokenSymbol(usdcSymbol)
    if (
      decimals !== BSC_USDC_DECIMALS ||
      symbol !== "USDC" ||
      quote.usdcDecimals !== decimals ||
      quote.usdcSymbol !== symbol
    ) {
      throw new ProtocolError(
        "UNSUPPORTED_USDC_CONFIGURATION",
        "The configured input token is not the expected 18-decimal BSC USDC.",
      )
    }
    if (
      typeof usdcBalance !== "bigint" ||
      usdcBalance < 0n ||
      typeof usdcAllowance !== "bigint" ||
      usdcAllowance < 0n
    ) {
      throw new ProtocolError("INVALID_TOKEN_STATE", "USDC returned invalid account data.")
    }

    const validatedLegs = requirements.constituents.map((constituent, index) =>
      validateQuoteLeg(quote.legs[index], constituent, index, quote.slippageBps),
    )
    const expectedSum = validatedLegs.reduce((sum, leg) => sum + leg.expectedUsdcIn, 0n)
    const maximumSum = validatedLegs.reduce((sum, leg) => sum + leg.maxUsdcIn, 0n)
    if (
      expectedSum > MAX_UINT256 ||
      expectedSum !== quote.expectedTotalUsdcIn ||
      maximumSum > MAX_UINT256 ||
      maximumSum !== quote.maxTotalUsdcIn
    ) {
      throw new ProtocolError(
        "QUOTE_TOTAL_MISMATCH",
        "The per-route USDC values do not equal the reviewed expected and maximum totals.",
      )
    }
    const legs = await mapWithConcurrency(
      validatedLegs,
      options.readConcurrency || 4,
      (leg, index) =>
        verifyBoundRoute(
          pinnedClient,
          addresses,
          wiring.adapters,
          leg,
          requirements.constituents[index],
          index,
        ),
    )
    await verifyQuotedRouteAmounts({
      publicClient: createPinnedPublicClient(options.publicClient, quote.quoteBlockNumber),
      account,
      legs,
      readConcurrency: options.readConcurrency || 4,
    })
    await assertQuoteBlockCanonical(options.publicClient, {
      quoteBlockNumber: chain.number,
      quoteBlockHash: chain.hash,
      quoteBlockTimestamp: chain.timestamp,
    })

    const displayLegs = Object.freeze(
      legs.map((leg) =>
        Object.freeze({
          ...leg,
          expectedUsdcInFormatted: formatTokenAmount(leg.expectedUsdcIn, decimals),
          maxUsdcInFormatted: formatTokenAmount(leg.maxUsdcIn, decimals),
        }),
      ),
    )
    const snapshot = Object.freeze({
      chainId: chain.chainId,
      account,
      router: addresses.oneClickRouter,
      usdc: addresses.usdc,
      usdcDecimals: decimals,
      usdcSymbol: symbol,
      basket: basketAddress,
      recipient,
      grossBasketAmount: quote.grossBasketAmount,
      minNetBasketOut: basketState.netBasketOut,
      expectedTotalUsdcIn: quote.expectedTotalUsdcIn,
      maxTotalUsdcIn: quote.maxTotalUsdcIn,
      deadline: quote.deadline,
      quoteBlockNumber: quote.quoteBlockNumber,
      quoteBlockHash: quote.quoteBlockHash,
      quoteBlockTimestamp: quote.quoteBlockTimestamp,
      slippageBps: quote.slippageBps,
      source: quote.source,
      mintFeeBps: basketState.mintFeeBps,
      totalSupply: basketState.totalSupply,
      supplyCap: basketState.supplyCap,
      isFullyBacked: basketState.isFullyBacked,
      mintPaused: basketState.mintPaused,
      legs: displayLegs,
    })
    const fingerprint = createBasketBuyQuoteFingerprint(snapshot)
    const hasBalance = usdcBalance >= quote.maxTotalUsdcIn
    const hasAllowance = usdcAllowance >= quote.maxTotalUsdcIn
    const blockers = Object.freeze([
      ...(!basketState.isFullyBacked ? ["UNDERBACKED"] : []),
      ...(basketState.mintPaused ? ["MINT_PAUSED"] : []),
      ...(!basketState.supplyAvailable ? ["SUPPLY_CAP_EXCEEDED"] : []),
      ...(!hasBalance ? ["INSUFFICIENT_USDC_BALANCE"] : []),
      ...(!hasAllowance ? ["APPROVAL_REQUIRED"] : []),
    ])

    return Object.freeze({
      ...snapshot,
      fingerprint,
      currentTimestamp: chain.timestamp,
      expiresIn: quote.deadline - chain.timestamp,
      basketDecimals: requirements.decimals,
      basketAmountFormatted: requirements.basketAmountFormatted,
      feeAmount: basketState.feeAmount,
      feeAmountFormatted: formatTokenAmount(basketState.feeAmount, requirements.decimals),
      netBasketOutFormatted: formatTokenAmount(basketState.netBasketOut, requirements.decimals),
      supplyAvailable: basketState.supplyAvailable,
      usdcDecimals: decimals,
      usdcSymbol: symbol,
      usdcBalance,
      usdcBalanceFormatted: formatTokenAmount(usdcBalance, decimals),
      usdcAllowance,
      expectedTotalUsdcInFormatted: formatTokenAmount(quote.expectedTotalUsdcIn, decimals),
      maxTotalUsdcInFormatted: formatTokenAmount(quote.maxTotalUsdcIn, decimals),
      hasBalance,
      hasAllowance,
      blockers,
      canApprove: hasBalance && blockers.every((blocker) => blocker === "APPROVAL_REQUIRED"),
      canBuy: blockers.length === 0,
      routerArgs: Object.freeze([
        basketAddress,
        quote.grossBasketAmount,
        basketState.netBasketOut,
        recipient,
        quote.maxTotalUsdcIn,
        quote.deadline,
        Object.freeze(
          legs.map(({ expectedToken, adapter, routeId, expectedAmountOut, maxUsdcIn }) =>
            Object.freeze({ expectedToken, adapter, routeId, expectedAmountOut, maxUsdcIn }),
          ),
        ),
      ]),
    })
  })
}

async function writeUsdcApproval(options, addresses, amount, action) {
  return executeContractWrite({
    ...options,
    address: addresses.usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [addresses.oneClickRouter, amount],
    action,
  })
}

export async function approveUsdcForBasketBuy(options) {
  return runProtocolAction("approve USDC for basket purchase", async () => {
    const addresses = requireOneClickContracts(options.addresses || wovenContracts)
    let readiness = await getBasketBuyReadiness({ ...options, addresses })
    assertQuoteReviewCurrent(readiness, options.review)
    assertBuyPreconditions(readiness, { allowMissingApproval: true })
    if (readiness.hasAllowance) {
      return Object.freeze({ readiness, transactions: [] })
    }

    const transactions = []
    try {
      if (readiness.usdcAllowance > 0n) {
        transactions.push(
          await writeUsdcApproval(options, addresses, 0n, "reset USDC router approval"),
        )
        readiness = await getBasketBuyReadiness({ ...options, addresses })
        assertQuoteReviewCurrent(readiness, options.review)
        assertBuyPreconditions(readiness, { allowMissingApproval: true })
      }
      transactions.push(
        await writeUsdcApproval(
          options,
          addresses,
          readiness.maxTotalUsdcIn,
          "approve USDC for basket purchase",
        ),
      )

      const confirmedAllowance = await readContract(options.publicClient, {
        address: addresses.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [readiness.account, addresses.oneClickRouter],
      })
      if (typeof confirmedAllowance !== "bigint" || confirmedAllowance < readiness.maxTotalUsdcIn) {
        throw new ProtocolError(
          "APPROVAL_NOT_CONFIRMED",
          "The USDC approval confirmed, but the reviewed allowance is not available.",
          { txHash: transactions.at(-1)?.hash },
        )
      }

      readiness = await getBasketBuyReadiness({ ...options, addresses })
      assertQuoteReviewCurrent(readiness, options.review)
      if (!readiness.hasAllowance) {
        throw new ProtocolError(
          "APPROVAL_NOT_CONFIRMED",
          "The USDC approval confirmed, but the reviewed allowance is not available.",
        )
      }
      return Object.freeze({ readiness, transactions: Object.freeze(transactions) })
    } catch (error) {
      throw withCompletedTransactions(error, transactions)
    }
  })
}

export async function mintBasketWithUsdc(options) {
  return runProtocolAction("buy basket with USDC", async () => {
    const addresses = requireOneClickContracts(options.addresses || wovenContracts)
    let readiness = await getBasketBuyReadiness({ ...options, addresses })
    assertQuoteReviewCurrent(readiness, options.review)
    assertBuyPreconditions(readiness, {
      allowMissingApproval: options.approveUsdc !== false,
    })

    let approval = { readiness, transactions: [] }
    try {
      approval = readiness.hasAllowance
        ? approval
        : await approveUsdcForBasketBuy({ ...options, addresses })
      readiness = await getBasketBuyReadiness({ ...options, addresses })
      assertQuoteReviewCurrent(readiness, options.review)
      assertBuyPreconditions(readiness)

      const transaction = await executeContractWrite({
        ...options,
        account: readiness.account,
        address: addresses.oneClickRouter,
        abi: oneClickBasketRouterAbi,
        functionName: "mintWithUsdc",
        args: readiness.routerArgs,
        action: "buy basket with USDC",
      })

      return Object.freeze({
        basketAddress: readiness.basket,
        readiness,
        approvalTransactions: Object.freeze(approval.transactions),
        transaction,
      })
    } catch (error) {
      throw withCompletedTransactions(error, approval.transactions)
    }
  })
}
