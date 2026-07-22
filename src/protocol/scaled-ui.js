import { erc20Abi, scaledUiAmountAbi } from "./abis"
import { ProtocolError } from "./errors"
import { readContract } from "./reads"
import {
  MAX_UINT256,
  assertDecimals,
  formatTokenAmount,
  normalizeAddress,
  parseTokenAmount,
} from "./validation"

export const SCALED_UI_MULTIPLIER_BASE = 10n ** 18n
export const SCALED_UI_INTERFACE_IDS = Object.freeze({
  core: "0xa60bf13d",
  conversion: "0x57854fc3",
  pending: "0x4bd27648",
})

function requireUint256(value, label, { allowZero = false } = {}) {
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value > MAX_UINT256 ||
    (!allowZero && value === 0n)
  ) {
    throw new ProtocolError(
      "INVALID_SCALED_UI_STATE",
      `${label} returned by the constituent token is invalid.`,
      { details: { label } },
    )
  }
  return value
}

async function readScaledUiState(publicClient, token) {
  const [
    supportsCore,
    supportsConversion,
    supportsPending,
    uiMultiplier,
    newUiMultiplier,
    effectiveAt,
  ] = await Promise.all([
    readContract(publicClient, {
      address: token,
      abi: scaledUiAmountAbi,
      functionName: "supportsInterface",
      args: [SCALED_UI_INTERFACE_IDS.core],
    }),
    readContract(publicClient, {
      address: token,
      abi: scaledUiAmountAbi,
      functionName: "supportsInterface",
      args: [SCALED_UI_INTERFACE_IDS.conversion],
    }),
    readContract(publicClient, {
      address: token,
      abi: scaledUiAmountAbi,
      functionName: "supportsInterface",
      args: [SCALED_UI_INTERFACE_IDS.pending],
    }),
    readContract(publicClient, {
      address: token,
      abi: scaledUiAmountAbi,
      functionName: "uiMultiplier",
    }),
    readContract(publicClient, {
      address: token,
      abi: scaledUiAmountAbi,
      functionName: "newUIMultiplier",
    }),
    readContract(publicClient, {
      address: token,
      abi: scaledUiAmountAbi,
      functionName: "effectiveAt",
    }),
  ])

  if (supportsCore !== true || supportsConversion !== true || supportsPending !== true) {
    throw new ProtocolError(
      "UNSUPPORTED_SCALED_UI_TOKEN",
      "A constituent does not expose the required bStock amount interface.",
      { details: { token } },
    )
  }

  return Object.freeze({
    uiMultiplier: requireUint256(uiMultiplier, "UI multiplier"),
    newUiMultiplier: requireUint256(newUiMultiplier, "Pending UI multiplier"),
    effectiveAt: requireUint256(effectiveAt, "Multiplier effective time", { allowZero: true }),
  })
}

export async function readScaledUiAmount(options) {
  const token = normalizeAddress(options.token, "Constituent token")
  const rawAmount = requireUint256(options.rawAmount, "Raw amount", { allowZero: true })
  const decimalsPromise = Number.isInteger(options.decimals)
    ? Promise.resolve(assertDecimals(options.decimals))
    : readContract(options.publicClient, {
        address: token,
        abi: erc20Abi,
        functionName: "decimals",
      }).then((value) => assertDecimals(value))

  const [decimals, state, uiAmount] = await Promise.all([
    decimalsPromise,
    readScaledUiState(options.publicClient, token),
    readContract(options.publicClient, {
      address: token,
      abi: scaledUiAmountAbi,
      functionName: "toUIAmount",
      args: [rawAmount],
    }),
  ])

  return Object.freeze({
    token,
    decimals,
    rawAmount,
    ...state,
    uiAmount: requireUint256(uiAmount, "Displayed amount", { allowZero: rawAmount === 0n }),
    amountFormatted: formatTokenAmount(uiAmount, decimals),
  })
}

export async function convertScaledUiInput(options) {
  const token = normalizeAddress(options.token, "Constituent token")
  const decimals = assertDecimals(
    options.decimals ??
      (await readContract(options.publicClient, {
        address: token,
        abi: erc20Abi,
        functionName: "decimals",
      })),
  )
  const requestedUiAmount = parseTokenAmount(options.amount, decimals, {
    label: options.label || "Displayed constituent amount",
  })

  const [state, rawAmount] = await Promise.all([
    readScaledUiState(options.publicClient, token),
    readContract(options.publicClient, {
      address: token,
      abi: scaledUiAmountAbi,
      functionName: "fromUIAmount",
      args: [requestedUiAmount],
    }),
  ])
  const validatedRawAmount = requireUint256(rawAmount, "Raw constituent amount")
  const uiAmount = requireUint256(
    await readContract(options.publicClient, {
      address: token,
      abi: scaledUiAmountAbi,
      functionName: "toUIAmount",
      args: [validatedRawAmount],
    }),
    "Displayed amount",
  )

  return Object.freeze({
    token,
    decimals,
    rawAmount: validatedRawAmount,
    requestedUiAmount,
    uiAmount,
    ...state,
    amountFormatted: formatTokenAmount(uiAmount, decimals),
    requestedAmountFormatted: formatTokenAmount(requestedUiAmount, decimals),
    rounded: uiAmount !== requestedUiAmount,
  })
}
