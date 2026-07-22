import { wovenContracts } from "../config/contracts"
import { basketFactoryAbi, basketTokenAbi } from "./abis"
import { requireReadContracts } from "./configuration"
import { ProtocolError, runProtocolAction, toProtocolError } from "./errors"
import { mapWithConcurrency, readContract } from "./reads"
import {
  assertDecimals,
  formatTokenAmount,
  normalizeAddress,
  sanitizeTokenSymbol,
  sanitizeTokenText,
} from "./validation"

const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 100

function invalidFactoryIndex(message = "The factory basket index could not be read safely.") {
  return new ProtocolError("INVALID_FACTORY_INDEX", message)
}

function parsePositiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || (maximum && value > maximum)) {
    throw invalidFactoryIndex(
      `${label} must be a whole number from 1 to ${maximum || Number.MAX_SAFE_INTEGER}.`,
    )
  }
  return value
}

function parseNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidFactoryIndex(`${label} must be a non-negative whole number.`)
  }
  return value
}

function basketFailure({ stage, index, address, creator, error }) {
  const protocolError = toProtocolError(error, { action: `read basket ${stage}` })
  return Object.freeze({
    stage,
    index,
    address,
    ...(creator ? { creator } : {}),
    code: protocolError.code,
    message: protocolError.userMessage,
  })
}

async function settleBasketReads(values, limit, mapper) {
  return mapWithConcurrency(values, limit, async (value, index) => {
    try {
      return Object.freeze({ ok: true, value: await mapper(value, index) })
    } catch (error) {
      return Object.freeze({ ok: false, error })
    }
  })
}

export async function listFactoryBasketAddresses(options) {
  return runProtocolAction("discover baskets", async () => {
    const { basketFactory } = requireReadContracts(
      ["basketFactory"],
      options.addresses || wovenContracts,
    )
    const pageSize =
      options.pageSize === undefined
        ? DEFAULT_PAGE_SIZE
        : parsePositiveInteger(options.pageSize, "Factory page size", MAX_PAGE_SIZE)
    const maxBaskets =
      options.maxBaskets === undefined
        ? null
        : parsePositiveInteger(options.maxBaskets, "Factory basket limit")
    const cursorMode = options.offset !== undefined || options.limit !== undefined
    if (cursorMode && options.limit === undefined) {
      throw invalidFactoryIndex("A bounded factory page requires a limit.")
    }
    const requestedOffset =
      options.offset === undefined
        ? 0
        : parseNonNegativeInteger(options.offset, "Factory page offset")
    const requestedLimit =
      options.limit === undefined
        ? null
        : parsePositiveInteger(options.limit, "Factory result page size", MAX_PAGE_SIZE)
    const reportedCount = await readContract(options.publicClient, {
      address: basketFactory,
      abi: basketFactoryAbi,
      functionName: "basketCount",
    })
    if (
      typeof reportedCount !== "bigint" ||
      reportedCount < 0n ||
      reportedCount > BigInt(Number.MAX_SAFE_INTEGER) ||
      (maxBaskets !== null && reportedCount > BigInt(maxBaskets))
    ) {
      throw invalidFactoryIndex()
    }

    const seen = new Set()
    const indexedAddresses = []
    const startOffset = BigInt(requestedOffset)
    const scanEnd =
      requestedLimit === null
        ? reportedCount
        : startOffset + BigInt(requestedLimit) < reportedCount
          ? startOffset + BigInt(requestedLimit)
          : reportedCount
    let offset = startOffset < reportedCount ? startOffset : reportedCount
    while (offset < scanEnd) {
      const remaining = scanEnd - offset
      const expectedLength = Number(remaining < BigInt(pageSize) ? remaining : BigInt(pageSize))
      const rawPage = await readContract(options.publicClient, {
        address: basketFactory,
        abi: basketFactoryAbi,
        functionName: "basketsPage",
        args: [offset, BigInt(expectedLength)],
      })
      if (!Array.isArray(rawPage) || rawPage.length !== expectedLength) {
        throw invalidFactoryIndex()
      }

      rawPage.forEach((address, pageIndex) => {
        const index = Number(offset) + pageIndex
        const normalized = normalizeAddress(address, `Factory basket ${index + 1}`)
        const key = normalized.toLowerCase()
        if (seen.has(key)) {
          throw invalidFactoryIndex("The factory basket index contains a duplicate address.")
        }
        seen.add(key)
        indexedAddresses.push(Object.freeze({ address: normalized, index }))
      })
      offset += BigInt(expectedLength)
    }

    const creatorReads = await settleBasketReads(
      indexedAddresses,
      options.readConcurrency || 6,
      (entry) =>
        readContract(options.publicClient, {
          address: basketFactory,
          abi: basketFactoryAbi,
          functionName: "creatorOf",
          args: [entry.address],
        }),
    )
    const entries = []
    const failures = []
    creatorReads.forEach((result, resultIndex) => {
      const entry = indexedAddresses[resultIndex]
      if (!result.ok) {
        failures.push(
          basketFailure({
            stage: "provenance",
            index: entry.index,
            address: entry.address,
            error: result.error,
          }),
        )
        return
      }
      try {
        entries.push(
          Object.freeze({
            address: entry.address,
            creator: normalizeAddress(result.value, `Creator of basket ${entry.index + 1}`),
            index: entry.index,
          }),
        )
      } catch (error) {
        failures.push(
          basketFailure({
            stage: "provenance",
            index: entry.index,
            address: entry.address,
            error,
          }),
        )
      }
    })

    return Object.freeze({
      factoryAddress: basketFactory,
      count: Number(reportedCount),
      offset: requestedOffset,
      scannedCount: indexedAddresses.length,
      hasMore: scanEnd < reportedCount,
      nextOffset: scanEnd < reportedCount ? Number(scanEnd) : null,
      validEntryCount: entries.length,
      entries: Object.freeze(entries.map(Object.freeze)),
      failures: Object.freeze(failures),
    })
  })
}

async function readBasketMetadata(publicClient, entry) {
  const [name, symbol, decimals, totalSupply, supplyCap, mintFeeBps, mintPaused, tokens, units] =
    await Promise.all([
      readContract(publicClient, {
        address: entry.address,
        abi: basketTokenAbi,
        functionName: "name",
      }),
      readContract(publicClient, {
        address: entry.address,
        abi: basketTokenAbi,
        functionName: "symbol",
      }),
      readContract(publicClient, {
        address: entry.address,
        abi: basketTokenAbi,
        functionName: "decimals",
      }),
      readContract(publicClient, {
        address: entry.address,
        abi: basketTokenAbi,
        functionName: "totalSupply",
      }),
      readContract(publicClient, {
        address: entry.address,
        abi: basketTokenAbi,
        functionName: "supplyCap",
      }),
      readContract(publicClient, {
        address: entry.address,
        abi: basketTokenAbi,
        functionName: "mintFeeBps",
      }),
      readContract(publicClient, {
        address: entry.address,
        abi: basketTokenAbi,
        functionName: "mintPaused",
      }),
      readContract(publicClient, {
        address: entry.address,
        abi: basketTokenAbi,
        functionName: "constituents",
      }),
      readContract(publicClient, {
        address: entry.address,
        abi: basketTokenAbi,
        functionName: "units",
      }),
    ])
  const parsedDecimals = assertDecimals(decimals, "Basket decimals")
  if (
    typeof name !== "string" ||
    typeof symbol !== "string" ||
    typeof totalSupply !== "bigint" ||
    typeof supplyCap !== "bigint" ||
    typeof mintFeeBps !== "number" ||
    !Array.isArray(tokens) ||
    !Array.isArray(units) ||
    tokens.length < 2 ||
    tokens.length !== units.length ||
    units.some((unit) => typeof unit !== "bigint" || unit <= 0n)
  ) {
    throw new ProtocolError(
      "INVALID_BASKET_CONFIGURATION",
      "A factory basket returned invalid contract data.",
    )
  }
  const sanitizedName = sanitizeTokenText(name, { label: "Basket name", maxLength: 64 })
  const sanitizedSymbol = sanitizeTokenSymbol(symbol)

  let isFullyBacked = null
  let backingStatusFailure = null
  try {
    const backingStatus = await readContract(publicClient, {
      address: entry.address,
      abi: basketTokenAbi,
      functionName: "isFullyBacked",
    })
    if (typeof backingStatus !== "boolean") {
      throw new ProtocolError(
        "INVALID_BASKET_STATE",
        "A factory basket returned an invalid backing status.",
      )
    }
    isFullyBacked = backingStatus
  } catch (error) {
    backingStatusFailure = basketFailure({
      stage: "backing-status",
      index: entry.index,
      address: entry.address,
      creator: entry.creator,
      error,
    })
  }

  return Object.freeze({
    basket: Object.freeze({
      ...entry,
      name: sanitizedName,
      symbol: sanitizedSymbol,
      decimals: parsedDecimals,
      totalSupply,
      totalSupplyFormatted: formatTokenAmount(totalSupply, parsedDecimals),
      supplyCap,
      mintFeeBps,
      mintPaused: Boolean(mintPaused),
      isFullyBacked,
      constituents: Object.freeze(
        tokens.map((token, index) =>
          Object.freeze({
            token: normalizeAddress(token, `Constituent ${index + 1}`),
            units: units[index],
          }),
        ),
      ),
    }),
    failures: Object.freeze(backingStatusFailure ? [backingStatusFailure] : []),
  })
}

export async function readFactoryBasket(options) {
  return runProtocolAction("read factory basket", async () => {
    const { basketFactory } = requireReadContracts(
      ["basketFactory"],
      options.addresses || wovenContracts,
    )
    const basketAddress = normalizeAddress(options.basketAddress, "Basket address")
    const creator = await readContract(options.publicClient, {
      address: basketFactory,
      abi: basketFactoryAbi,
      functionName: "creatorOf",
      args: [basketAddress],
    })
    let normalizedCreator
    try {
      normalizedCreator = normalizeAddress(creator, "Basket creator")
    } catch (error) {
      throw new ProtocolError(
        "UNRECOGNIZED_BASKET",
        "This token was not created by the configured Woven factory.",
        { cause: error },
      )
    }
    const result = await readBasketMetadata(options.publicClient, {
      address: basketAddress,
      creator: normalizedCreator,
      index: null,
    })
    return result.basket
  })
}

export async function discoverFactoryBaskets(options) {
  return runProtocolAction("discover baskets", async () => {
    const index = await listFactoryBasketAddresses(options)
    const metadataReads = await settleBasketReads(
      index.entries,
      options.readConcurrency || 4,
      (entry) => readBasketMetadata(options.publicClient, entry),
    )
    const baskets = []
    const failures = [...index.failures]
    metadataReads.forEach((result, resultIndex) => {
      const entry = index.entries[resultIndex]
      if (result.ok) {
        baskets.push(result.value.basket)
        failures.push(...result.value.failures)
        return
      }
      failures.push(
        basketFailure({
          stage: "metadata",
          index: entry.index,
          address: entry.address,
          creator: entry.creator,
          error: result.error,
        }),
      )
    })
    return Object.freeze({
      ...index,
      baskets: Object.freeze(baskets),
      failures: Object.freeze(failures),
    })
  })
}

export async function getPortfolioBalances(options) {
  return runProtocolAction("read portfolio", async () => {
    const account = normalizeAddress(options.account, "Wallet account")
    const index = await listFactoryBasketAddresses(options)
    const positionReads = await settleBasketReads(
      index.entries,
      options.readConcurrency || 6,
      async (entry) => {
        const [balance, name, symbol, decimals] = await Promise.all([
          readContract(options.publicClient, {
            address: entry.address,
            abi: basketTokenAbi,
            functionName: "balanceOf",
            args: [account],
          }),
          readContract(options.publicClient, {
            address: entry.address,
            abi: basketTokenAbi,
            functionName: "name",
          }),
          readContract(options.publicClient, {
            address: entry.address,
            abi: basketTokenAbi,
            functionName: "symbol",
          }),
          readContract(options.publicClient, {
            address: entry.address,
            abi: basketTokenAbi,
            functionName: "decimals",
          }),
        ])
        const parsedDecimals = assertDecimals(decimals, "Basket decimals")
        if (typeof balance !== "bigint" || typeof name !== "string" || typeof symbol !== "string") {
          throw new ProtocolError(
            "INVALID_BASKET_STATE",
            "A factory basket returned invalid portfolio data.",
          )
        }
        const sanitizedName = sanitizeTokenText(name, { label: "Basket name", maxLength: 64 })
        const sanitizedSymbol = sanitizeTokenSymbol(symbol)
        return Object.freeze({
          ...entry,
          name: sanitizedName,
          symbol: sanitizedSymbol,
          decimals: parsedDecimals,
          balance,
          balanceFormatted: formatTokenAmount(balance, parsedDecimals),
        })
      },
    )
    const positions = []
    const failures = [...index.failures]
    positionReads.forEach((result, resultIndex) => {
      const entry = index.entries[resultIndex]
      if (result.ok) {
        positions.push(result.value)
        return
      }
      failures.push(
        basketFailure({
          stage: "balance",
          index: entry.index,
          address: entry.address,
          creator: entry.creator,
          error: result.error,
        }),
      )
    })
    const visiblePositions = options.includeZeroBalances
      ? positions
      : positions.filter((position) => position.balance > 0n)

    return Object.freeze({
      account,
      factoryAddress: index.factoryAddress,
      indexedBasketCount: index.count,
      offset: index.offset,
      scannedCount: index.scannedCount,
      hasMore: index.hasMore,
      nextOffset: index.nextOffset,
      positions: Object.freeze(visiblePositions),
      failures: Object.freeze(failures),
    })
  })
}
