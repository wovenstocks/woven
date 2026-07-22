const fn = (name, stateMutability, inputs = [], outputs = []) => ({
  type: "function",
  name,
  stateMutability,
  inputs,
  outputs,
})

const input = (name, type, components) => ({
  name,
  type,
  ...(components ? { components } : {}),
})
const customError = (name, inputs = []) => ({ type: "error", name, inputs })

export const erc20Abi = Object.freeze([
  fn("name", "view", [], [input("", "string")]),
  fn("symbol", "view", [], [input("", "string")]),
  fn("decimals", "view", [], [input("", "uint8")]),
  fn("totalSupply", "view", [], [input("", "uint256")]),
  fn("balanceOf", "view", [input("account", "address")], [input("", "uint256")]),
  fn(
    "allowance",
    "view",
    [input("owner", "address"), input("spender", "address")],
    [input("", "uint256")],
  ),
  fn(
    "approve",
    "nonpayable",
    [input("spender", "address"), input("value", "uint256")],
    [input("", "bool")],
  ),
])

// BNB Chain's ERC-8056 scaled UI amount extension. bStocks keep balances and
// transfers in raw ERC-20 units while corporate actions change the displayed
// amount through this multiplier-aware interface.
export const scaledUiAmountAbi = Object.freeze([
  fn("supportsInterface", "view", [input("interfaceId", "bytes4")], [input("", "bool")]),
  fn("uiMultiplier", "view", [], [input("", "uint256")]),
  fn("newUIMultiplier", "view", [], [input("", "uint256")]),
  fn("effectiveAt", "view", [], [input("", "uint256")]),
  fn("toUIAmount", "view", [input("rawAmount", "uint256")], [input("", "uint256")]),
  fn("fromUIAmount", "view", [input("uiAmount", "uint256")], [input("", "uint256")]),
])

export const creatorLicenseAbi = Object.freeze([
  fn("LICENSE_BURN_AMOUNT", "view", [], [input("", "uint256")]),
  fn("BURN_SINK", "view", [], [input("", "address")]),
  fn("wovenToken", "view", [], [input("", "address")]),
  fn("isLicensed", "view", [input("creator", "address")], [input("", "bool")]),
  fn("burnForLicense", "nonpayable"),
])

export const assetRegistryAbi = Object.freeze([
  fn("isSupported", "view", [input("asset", "address")], [input("", "bool")]),
])

export const feeSplitterAbi = Object.freeze([
  fn("factory", "view", [], [input("", "address")]),
  fn("treasury", "view", [], [input("", "address")]),
  fn("CREATOR_SHARE_BPS", "view", [], [input("", "uint256")]),
  fn("creatorOf", "view", [input("basket", "address")], [input("", "address")]),
  fn("distribute", "nonpayable", [input("basket", "address")]),
  {
    type: "event",
    name: "Distributed",
    anonymous: false,
    inputs: [
      { indexed: true, name: "basket", type: "address" },
      { indexed: true, name: "creator", type: "address" },
      { indexed: false, name: "toCreator", type: "uint256" },
      { indexed: false, name: "toTreasury", type: "uint256" },
    ],
  },
])

export const basketFactoryAbi = Object.freeze([
  fn("STARTER_CAP", "view", [], [input("", "uint256")]),
  fn("CEILING", "view", [], [input("", "uint256")]),
  fn("creatorLicense", "view", [], [input("", "address")]),
  fn("assetRegistry", "view", [], [input("", "address")]),
  fn("splitter", "view", [], [input("", "address")]),
  fn("basketGuardian", "view", [], [input("", "address")]),
  fn("basketCount", "view", [], [input("", "uint256")]),
  fn("MAX_PAGE_SIZE", "view", [], [input("", "uint256")]),
  fn(
    "basketsPage",
    "view",
    [input("offset", "uint256"), input("limit", "uint256")],
    [input("page", "address[]")],
  ),
  fn("creatorOf", "view", [input("basket", "address")], [input("", "address")]),
  fn(
    "createBasket",
    "nonpayable",
    [
      input("name", "string"),
      input("symbol", "string"),
      input("tokens", "address[]"),
      input("unitsPerBasket", "uint256[]"),
      input("mintFeeBps", "uint16"),
      input("initialSupplyCap", "uint256"),
    ],
    [input("basket", "address")],
  ),
  {
    type: "event",
    name: "BasketCreated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "basket", type: "address" },
      { indexed: true, name: "creator", type: "address" },
      { indexed: false, name: "name", type: "string" },
      { indexed: false, name: "symbol", type: "string" },
      { indexed: false, name: "initialSupplyCap", type: "uint256" },
    ],
  },
])

export const basketTokenAbi = Object.freeze([
  ...erc20Abi,
  customError("ExistingBackingDeficit", [
    input("token", "address"),
    input("balance", "uint256"),
    input("required", "uint256"),
  ]),
  customError("InexactRedemption", [
    input("token", "address"),
    input("expected", "uint256"),
    input("basketDecrease", "uint256"),
    input("recipientIncrease", "uint256"),
  ]),
  customError("InvalidRedemptionRecipient"),
  customError("ZeroRedemptionOutput", [input("token", "address")]),
  fn("constituents", "view", [], [input("", "address[]")]),
  fn("units", "view", [], [input("", "uint256[]")]),
  fn(
    "getRequiredUnits",
    "view",
    [input("basketAmount", "uint256")],
    [input("tokens", "address[]"), input("amounts", "uint256[]")],
  ),
  fn(
    "backingOf",
    "view",
    [input("basketAmount", "uint256")],
    [input("tokens", "address[]"), input("amounts", "uint256[]")],
  ),
  fn("mintFeeBps", "view", [], [input("", "uint16")]),
  fn("guardian", "view", [], [input("", "address")]),
  fn("feeRecipient", "view", [], [input("", "address")]),
  fn("supplyCap", "view", [], [input("", "uint256")]),
  fn("maxSupplyCap", "view", [], [input("", "uint256")]),
  fn("mintPaused", "view", [], [input("", "bool")]),
  fn("isFullyBacked", "view", [], [input("", "bool")]),
  fn("mint", "nonpayable", [input("basketAmount", "uint256"), input("to", "address")]),
  fn("redeem", "nonpayable", [input("basketAmount", "uint256"), input("to", "address")]),
])

export const exactOutputAdapterAbi = Object.freeze([
  fn("inputToken", "view", [], [input("", "address")]),
  fn("routeIds", "view", [], [input("", "bytes32[]")]),
  fn("routeOutput", "view", [input("routeId", "bytes32")], [input("", "address")]),
  fn("routeHash", "view", [input("routeId", "bytes32")], [input("", "bytes32")]),
  fn(
    "quoteExactOutput",
    "nonpayable",
    [input("tokenOut", "address"), input("exactAmountOut", "uint256"), input("routeId", "bytes32")],
    [input("amountIn", "uint256"), input("gasEstimate", "uint256")],
  ),
])

const oneClickSwapLegComponents = Object.freeze([
  input("expectedToken", "address"),
  input("adapter", "address"),
  input("routeId", "bytes32"),
  input("expectedAmountOut", "uint256"),
  input("maxUsdcIn", "uint256"),
])

export const oneClickBasketRouterAbi = Object.freeze([
  customError("ZeroAddress"),
  customError("NotAContract", [input("target", "address")]),
  customError("ReentrancyGuardReentrantCall"),
  customError("SafeERC20FailedOperation", [input("token", "address")]),
  customError("ZeroAmount"),
  customError("InvalidRecipient"),
  customError("Expired"),
  customError("DeadlineTooFar", [input("deadline", "uint256"), input("maximum", "uint256")]),
  customError("UnknownBasket", [input("basket", "address")]),
  customError("InvalidConstituentCount", [input("count", "uint256")]),
  customError("LegCountMismatch", [input("expected", "uint256"), input("actual", "uint256")]),
  customError("UnsupportedAsset", [input("asset", "address")]),
  customError("UsdcConstituentUnsupported"),
  customError("LegTokenMismatch", [
    input("index", "uint256"),
    input("expected", "address"),
    input("actual", "address"),
  ]),
  customError("LegAmountMismatch", [
    input("index", "uint256"),
    input("expected", "uint256"),
    input("actual", "uint256"),
  ]),
  customError("ZeroLegMaximum", [input("index", "uint256")]),
  customError("TotalMaximumMismatch", [input("expected", "uint256"), input("actual", "uint256")]),
  customError("UnapprovedAdapter", [input("adapter", "address")]),
  customError("AdapterCodeChanged", [
    input("adapter", "address"),
    input("expected", "bytes32"),
    input("actual", "bytes32"),
  ]),
  customError("AdapterRouteMismatch", [
    input("adapter", "address"),
    input("routeId", "bytes32"),
    input("expected", "address"),
    input("actual", "address"),
  ]),
  customError("LegSpendExceeded", [
    input("index", "uint256"),
    input("spent", "uint256"),
    input("maximum", "uint256"),
  ]),
  customError("InexactUsdcTransfer", [input("expected", "uint256"), input("received", "uint256")]),
  customError("InexactUsdcDebit", [input("expected", "uint256"), input("debited", "uint256")]),
  customError("InexactUsdcRefund", [input("expected", "uint256"), input("received", "uint256")]),
  customError("AdapterSpendMismatch", [
    input("index", "uint256"),
    input("reported", "uint256"),
    input("measured", "uint256"),
  ]),
  customError("ConstituentOutputMismatch", [
    input("index", "uint256"),
    input("expected", "uint256"),
    input("received", "uint256"),
  ]),
  customError("BasketOutputBelowMinimum", [
    input("minimum", "uint256"),
    input("received", "uint256"),
  ]),
  customError("ConstituentBalanceNotRestored", [
    input("token", "address"),
    input("expected", "uint256"),
    input("actual", "uint256"),
  ]),
  customError("UsdcBalanceNotRestored", [input("expected", "uint256"), input("actual", "uint256")]),
  // Adapter and BasketToken errors can bubble through mintWithUsdc. They are
  // included here so wallet simulation can decode the actual failing guard.
  customError("RouteNotFound", [input("routeId", "bytes32")]),
  customError("RouteOutputMismatch", [input("expected", "address"), input("actual", "address")]),
  customError("InexactInputTransfer", [input("expected", "uint256"), input("received", "uint256")]),
  customError("InexactCallerDebit", [input("expected", "uint256"), input("debited", "uint256")]),
  customError("InexactRefund", [input("expected", "uint256"), input("received", "uint256")]),
  customError("InvalidSwapResult"),
  customError("InputSpendMismatch", [input("reported", "uint256"), input("measured", "uint256")]),
  customError("OutputAmountMismatch", [input("expected", "uint256"), input("received", "uint256")]),
  customError("ResidualInput", [input("expected", "uint256"), input("actual", "uint256")]),
  customError("ResidualOutput", [input("expected", "uint256"), input("actual", "uint256")]),
  customError("DexCodeChanged", [input("expected", "bytes32"), input("actual", "bytes32")]),
  customError("DependencyCodeChanged", [
    input("dependency", "address"),
    input("expected", "bytes32"),
    input("actual", "bytes32"),
  ]),
  customError("AllowanceNotCleared", [input("spender", "address"), input("remaining", "uint256")]),
  customError("AmountTooLarge"),
  customError("DeadlineOverflow"),
  customError("ExistingBackingDeficit", [
    input("token", "address"),
    input("balance", "uint256"),
    input("required", "uint256"),
  ]),
  customError("MintingPaused"),
  customError("SupplyCapExceeded"),
  customError("InsufficientDeposit", [input("token", "address")]),
  fn("usdc", "view", [], [input("", "address")]),
  fn("basketFactory", "view", [], [input("", "address")]),
  fn("assetRegistry", "view", [], [input("", "address")]),
  fn("adapters", "view", [], [input("", "address[]")]),
  fn("adapterCodehash", "view", [input("adapter", "address")], [input("", "bytes32")]),
  fn("MAX_ROUTED_CONSTITUENTS", "view", [], [input("", "uint256")]),
  fn("MAX_DEADLINE_WINDOW", "view", [], [input("", "uint256")]),
  fn(
    "mintWithUsdc",
    "nonpayable",
    [
      input("basket", "address"),
      input("grossBasketAmount", "uint256"),
      input("minNetBasketOut", "uint256"),
      input("recipient", "address"),
      input("maxTotalUsdcIn", "uint256"),
      input("deadline", "uint256"),
      input("legs", "tuple[]", oneClickSwapLegComponents),
    ],
    [input("netBasketOut", "uint256"), input("usdcSpent", "uint256")],
  ),
  {
    type: "event",
    name: "BasketMintedWithUsdc",
    anonymous: false,
    inputs: [
      { indexed: true, name: "payer", type: "address" },
      { indexed: true, name: "basket", type: "address" },
      { indexed: true, name: "recipient", type: "address" },
      { indexed: false, name: "grossBasketAmount", type: "uint256" },
      { indexed: false, name: "netBasketOut", type: "uint256" },
      { indexed: false, name: "usdcSpent", type: "uint256" },
      { indexed: false, name: "usdcRefunded", type: "uint256" },
    ],
  },
])
