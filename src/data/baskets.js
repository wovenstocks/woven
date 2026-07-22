import {
  formatTokenAmount,
  hasUnsafeTokenTextCharacters,
  isUsableAddress,
} from "../protocol/validation"

export const stocks = [
  {
    symbol: "NVDAB",
    ticker: "NVDA",
    name: "NVIDIA",
    tone: "green",
    address: import.meta.env.VITE_BSTOCK_NVDAB || "",
  },
  {
    symbol: "MSFTB",
    ticker: "MSFT",
    name: "Microsoft",
    tone: "blue",
    address: import.meta.env.VITE_BSTOCK_MSFTB || "",
  },
  {
    symbol: "METAB",
    ticker: "META",
    name: "Meta",
    tone: "violet",
    address: import.meta.env.VITE_BSTOCK_METAB || "",
  },
  {
    symbol: "TSLAB",
    ticker: "TSLA",
    name: "Tesla",
    tone: "red",
    address: import.meta.env.VITE_BSTOCK_TSLAB || "",
  },
  {
    symbol: "QQQB",
    ticker: "QQQ",
    name: "Invesco QQQ",
    type: "ETF",
    tone: "navy",
    address: import.meta.env.VITE_BSTOCK_QQQB || "",
  },
  {
    symbol: "AAPLB",
    ticker: "AAPL",
    name: "Apple",
    tone: "slate",
    address: import.meta.env.VITE_BSTOCK_AAPLB || "",
  },
  {
    symbol: "GOOGLB",
    ticker: "GOOGL",
    name: "Alphabet",
    tone: "amber",
    address: import.meta.env.VITE_BSTOCK_GOOGLB || "",
  },
  {
    symbol: "AMZNB",
    ticker: "AMZN",
    name: "Amazon",
    tone: "orange",
    address: import.meta.env.VITE_BSTOCK_AMZNB || "",
  },
  {
    symbol: "AMDB",
    ticker: "AMD",
    name: "AMD",
    tone: "rose",
    address: import.meta.env.VITE_BSTOCK_AMDB || "",
  },
  {
    symbol: "PLTRB",
    ticker: "PLTR",
    name: "Palantir",
    tone: "ink",
    address: import.meta.env.VITE_BSTOCK_PLTRB || "",
  },
  {
    symbol: "ORCLB",
    ticker: "ORCL",
    name: "Oracle",
    tone: "crimson",
    address: import.meta.env.VITE_BSTOCK_ORCLB || "",
  },
  {
    symbol: "TSMB",
    ticker: "TSM",
    name: "TSMC",
    tone: "cyan",
    address: import.meta.env.VITE_BSTOCK_TSMB || "",
  },
].map((stock) => Object.freeze({ ...stock, amountModel: "erc8056" }))

export const stockBySymbol = Object.freeze(
  Object.fromEntries(stocks.map((stock) => [stock.symbol, stock])),
)

const addressKey = (address) => (typeof address === "string" ? address.toLowerCase() : "")
const initialOneClickAssets = new Set(["NVDAB", "MSFTB", "TSLAB", "QQQB"])

function verifiedDisplayText(value, { label, maxLength, symbol = false }) {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : ""
  if (
    !text ||
    text.length > maxLength ||
    hasUnsafeTokenTextCharacters(value) ||
    (symbol && !/^[A-Z0-9][A-Z0-9._-]{0,15}$/.test(text))
  ) {
    throw new Error(`The factory returned unsafe ${label} metadata.`)
  }
  return text
}

export function createDynamicBasketView(factoryBasket, catalog = stocks) {
  const catalogByAddress = new Map(
    catalog
      .filter((stock) => isUsableAddress(stock.address))
      .map((stock) => [addressKey(stock.address), stock]),
  )
  if (
    !factoryBasket ||
    !isUsableAddress(factoryBasket.address) ||
    !Array.isArray(factoryBasket.constituents) ||
    factoryBasket.constituents.length < 2
  ) {
    throw new Error("The factory returned an invalid basket recipe.")
  }

  const assets = []
  const unitsRaw = {}
  const seen = new Set()
  for (const constituent of factoryBasket.constituents) {
    const stock = catalogByAddress.get(addressKey(constituent.token))
    if (!stock || typeof constituent.units !== "bigint" || constituent.units <= 0n) {
      throw new Error("This basket contains an asset that is not in the approved bStock catalog.")
    }
    if (seen.has(stock.symbol)) {
      throw new Error("The basket contains the same configured asset more than once.")
    }
    seen.add(stock.symbol)
    assets.push(stock.symbol)
    unitsRaw[stock.symbol] = constituent.units
  }

  const name = verifiedDisplayText(factoryBasket.name, { label: "basket name", maxLength: 64 })
  const symbol = verifiedDisplayText(factoryBasket.symbol, {
    label: "basket symbol",
    maxLength: 16,
    symbol: true,
  })
  if (
    !Number.isInteger(factoryBasket.mintFeeBps) ||
    factoryBasket.mintFeeBps < 0 ||
    factoryBasket.mintFeeBps > 50
  ) {
    throw new Error("The factory returned an invalid basket fee.")
  }

  return Object.freeze({
    id: factoryBasket.address,
    address: factoryBasket.address,
    name,
    symbol,
    description: `${assets.length} approved token constituents held behind one transferable basket token.`,
    assets: Object.freeze(assets),
    unitsRaw: Object.freeze(unitsRaw),
    mintFeeBps: factoryBasket.mintFeeBps,
    oneClickRoute: assets.every((symbol) => initialOneClickAssets.has(symbol)),
    tint: "blue",
    factoryVerified: true,
  })
}

export function getMintQuote(readiness) {
  if (
    !readiness ||
    typeof readiness.basketAmount !== "bigint" ||
    !Number.isInteger(readiness.decimals) ||
    !Number.isInteger(readiness.mintFeeBps)
  ) {
    throw new Error("Mint quote is unavailable.")
  }
  const feeAmount = (readiness.basketAmount * BigInt(readiness.mintFeeBps)) / 10_000n
  const netAmount = readiness.basketAmount - feeAmount
  return Object.freeze({
    grossAmount: readiness.basketAmount,
    grossFormatted: formatTokenAmount(readiness.basketAmount, readiness.decimals),
    feeAmount,
    feeFormatted: formatTokenAmount(feeAmount, readiness.decimals),
    netAmount,
    netFormatted: formatTokenAmount(netAmount, readiness.decimals),
    feeBps: readiness.mintFeeBps,
  })
}

export function isTradeReviewCurrent(review, context) {
  if (!review || !context) return false
  return (
    review.reviewType === context.type &&
    review.requestedAmount === context.amount &&
    review.reviewChainId === context.chainId &&
    review.reviewProviderId === (context.providerId || "") &&
    addressKey(review.account) === addressKey(context.account) &&
    addressKey(review.basketAddress) === addressKey(context.basketAddress)
  )
}

function readPinnedRawUnits(value, assets) {
  if (typeof value !== "string" || !value.trim()) return Object.freeze({})
  const entries = value.split(",").map((item) => item.trim())
  if (entries.length !== assets.length || entries.some((item) => !/^[1-9]\d*$/.test(item))) {
    return Object.freeze({})
  }
  return Object.freeze(
    Object.fromEntries(assets.map((symbol, index) => [symbol, BigInt(entries[index])])),
  )
}

const tech5Assets = Object.freeze(["NVDAB", "MSFTB", "METAB", "TSLAB", "QQQB"])
const core4Assets = Object.freeze(["NVDAB", "MSFTB", "TSLAB", "QQQB"])
const mag7Assets = Object.freeze(["AAPLB", "MSFTB", "GOOGLB", "AMZNB", "METAB", "NVDAB", "TSLAB"])
const ai6Assets = Object.freeze(["NVDAB", "AMDB", "PLTRB", "GOOGLB", "ORCLB", "TSMB"])

export const baskets = [
  {
    id: "core4",
    name: "Woven Core Four",
    symbol: "CORE4",
    description: "Four bStock tokens referencing NVIDIA, Microsoft, Tesla and QQQ.",
    assets: core4Assets,
    units: Object.freeze({ NVDAB: "0.01", MSFTB: "0.01", TSLAB: "0.01", QQQB: "0.01" }),
    unitsRaw: readPinnedRawUnits(import.meta.env.VITE_BASKET_CORE4_UNITS_RAW, core4Assets),
    mintFeeBps: 30,
    address: import.meta.env.VITE_BASKET_CORE4 || "",
    oneClickRoute: true,
    tint: "blue",
  },
  {
    id: "tech5",
    name: "Technology Leaders Five",
    symbol: "TECH5",
    description: "Five bStock tokens referencing large-cap technology instruments.",
    assets: tech5Assets,
    units: Object.freeze({ NVDAB: "1", MSFTB: "1", METAB: "1", TSLAB: "1", QQQB: "1" }),
    unitsRaw: readPinnedRawUnits(import.meta.env.VITE_BASKET_TECH5_UNITS_RAW, tech5Assets),
    mintFeeBps: 30,
    address: import.meta.env.VITE_BASKET_TECH5 || "",
    oneClickRoute: false,
    tint: "blue",
  },
  {
    id: "mag7",
    name: "Magnificent Seven",
    symbol: "MAG7B",
    description: "Seven bStock tokens referencing large-cap companies.",
    assets: mag7Assets,
    units: Object.freeze({
      AAPLB: "1",
      MSFTB: "1",
      GOOGLB: "1",
      AMZNB: "1",
      METAB: "1",
      NVDAB: "1",
      TSLAB: "1",
    }),
    unitsRaw: readPinnedRawUnits(import.meta.env.VITE_BASKET_MAG7B_UNITS_RAW, mag7Assets),
    mintFeeBps: 30,
    address: import.meta.env.VITE_BASKET_MAG7B || "",
    oneClickRoute: false,
    tint: "green",
  },
  {
    id: "ai6",
    name: "AI Infrastructure Six",
    symbol: "AI6B",
    description: "Six bStock tokens spanning chips, cloud and data infrastructure.",
    assets: ai6Assets,
    units: Object.freeze({
      NVDAB: "1",
      AMDB: "1",
      PLTRB: "1",
      GOOGLB: "1",
      ORCLB: "1",
      TSMB: "1",
    }),
    unitsRaw: readPinnedRawUnits(import.meta.env.VITE_BASKET_AI6B_UNITS_RAW, ai6Assets),
    mintFeeBps: 30,
    address: import.meta.env.VITE_BASKET_AI6B || "",
    oneClickRoute: false,
    tint: "violet",
  },
]

// CORE4 is the launch basket. Additional editorial baskets become public only
// after their factory addresses are pinned into the selected production build.
export const marketedBaskets = Object.freeze(
  baskets.filter((basket) => basket.id === "core4" || Boolean(getConfiguredBasketRecipe(basket))),
)

export function getConfiguredBasketRecipe(basket, catalog = stocks) {
  if (!basket || !isUsableAddress(basket.address) || !Number.isInteger(basket.mintFeeBps))
    return null
  const configuredStocks = Object.fromEntries(catalog.map((stock) => [stock.symbol, stock]))
  const constituents = basket.assets.map((symbol) => {
    const stock = configuredStocks[symbol]
    const unitsRaw = basket.unitsRaw?.[symbol]
    if (!isUsableAddress(stock?.address) || typeof unitsRaw !== "bigint" || unitsRaw <= 0n) {
      return null
    }
    return Object.freeze({
      token: stock.address,
      unitsRaw,
      symbol,
    })
  })
  return constituents.every(Boolean)
    ? Object.freeze({
        address: basket.address,
        name: basket.name,
        symbol: basket.symbol,
        mintFeeBps: basket.mintFeeBps,
        constituents: Object.freeze(constituents),
      })
    : null
}
