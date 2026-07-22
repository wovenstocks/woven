import { wovenContracts } from "../config/contracts"
import { creatorLicenseAbi, erc20Abi } from "./abis"
import {
  requireReadContracts,
  requireWriteContracts,
  verifyFactoryWiring,
  verifyWriteContracts,
} from "./configuration"
import { ProtocolError, runProtocolAction, withCompletedTransactions } from "./errors"
import { readContract } from "./reads"
import { executeContractWrite } from "./transactions"
import {
  assertDecimals,
  formatTokenAmount,
  normalizeAddress,
  sanitizeTokenSymbol,
} from "./validation"

async function readLicenseState(publicClient, account, addresses) {
  const creator = normalizeAddress(account, "Wallet account")
  const [licensed, burnAmount, burnSink, tokenFromLicense, decimals, symbol, balance, allowance] =
    await Promise.all([
      readContract(publicClient, {
        address: addresses.creatorLicense,
        abi: creatorLicenseAbi,
        functionName: "isLicensed",
        args: [creator],
      }),
      readContract(publicClient, {
        address: addresses.creatorLicense,
        abi: creatorLicenseAbi,
        functionName: "LICENSE_BURN_AMOUNT",
      }),
      readContract(publicClient, {
        address: addresses.creatorLicense,
        abi: creatorLicenseAbi,
        functionName: "BURN_SINK",
      }),
      readContract(publicClient, {
        address: addresses.creatorLicense,
        abi: creatorLicenseAbi,
        functionName: "wovenToken",
      }),
      readContract(publicClient, {
        address: addresses.wovenToken,
        abi: erc20Abi,
        functionName: "decimals",
      }),
      readContract(publicClient, {
        address: addresses.wovenToken,
        abi: erc20Abi,
        functionName: "symbol",
      }),
      readContract(publicClient, {
        address: addresses.wovenToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [creator],
      }),
      readContract(publicClient, {
        address: addresses.wovenToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [creator, addresses.creatorLicense],
      }),
    ])

  if (normalizeAddress(tokenFromLicense, "License WOVEN token") !== addresses.wovenToken) {
    throw new ProtocolError(
      "CONTRACT_CONFIGURATION_MISMATCH",
      "The creator-license contract does not reference the configured WOVEN token.",
    )
  }

  const tokenDecimals = assertDecimals(decimals, "WOVEN decimals")
  if (tokenDecimals !== 18) {
    throw new ProtocolError(
      "UNSUPPORTED_WOVEN_DECIMALS",
      "The creator-license contract requires an 18-decimal WOVEN token.",
    )
  }
  if (burnAmount !== 10_000n * 10n ** 18n) {
    throw new ProtocolError("INVALID_LICENSE_AMOUNT", "Creator access is not configured safely.")
  }
  if (
    normalizeAddress(burnSink, "License burn sink") !== "0x000000000000000000000000000000000000dEaD"
  ) {
    throw new ProtocolError("INVALID_BURN_SINK", "Creator access is not configured safely.")
  }
  if (
    typeof balance !== "bigint" ||
    balance < 0n ||
    typeof allowance !== "bigint" ||
    allowance < 0n
  ) {
    throw new ProtocolError("INVALID_TOKEN_STATE", "The WOVEN token returned invalid account data.")
  }

  return Object.freeze({
    account: creator,
    licensed: Boolean(licensed),
    burnAmount,
    burnAmountFormatted: formatTokenAmount(burnAmount, tokenDecimals),
    burnSink: normalizeAddress(burnSink, "License burn sink"),
    decimals: tokenDecimals,
    symbol: sanitizeTokenSymbol(symbol),
    balance,
    allowance,
    hasBalance: balance >= burnAmount,
    hasAllowance: allowance >= burnAmount,
  })
}

export async function getCreatorLicenseStatus(options) {
  return runProtocolAction("read creator access", async () => {
    const addresses = requireReadContracts(
      ["wovenToken", "creatorLicense"],
      options.addresses || wovenContracts,
    )
    return readLicenseState(options.publicClient, options.account, addresses)
  })
}

async function approveAmount(options, amount) {
  return executeContractWrite({
    ...options,
    address: options.addresses.wovenToken,
    abi: erc20Abi,
    functionName: "approve",
    args: [options.addresses.creatorLicense, amount],
    action: amount === 0n ? "reset WOVEN approval" : "approve WOVEN for creator access",
  })
}

export async function approveCreatorLicense(options) {
  return runProtocolAction("approve WOVEN for creator access", async () => {
    const addresses = requireWriteContracts(options.addresses || wovenContracts)
    await verifyWriteContracts(options.publicClient, addresses)
    await verifyFactoryWiring(options.publicClient, addresses)
    const state = await readLicenseState(options.publicClient, options.account, addresses)
    if (state.licensed || state.hasAllowance) {
      return Object.freeze({ status: state, transactions: [] })
    }
    if (!state.hasBalance) {
      throw new ProtocolError(
        "INSUFFICIENT_WOVEN_BALANCE",
        `This wallet needs ${state.burnAmountFormatted} ${state.symbol} for creator access.`,
      )
    }

    const transactions = []
    try {
      if (state.allowance > 0n) {
        transactions.push(await approveAmount({ ...options, addresses }, 0n))
      }
      transactions.push(await approveAmount({ ...options, addresses }, state.burnAmount))

      const verified = await readLicenseState(options.publicClient, options.account, addresses)
      if (!verified.hasAllowance) {
        throw new ProtocolError(
          "APPROVAL_NOT_CONFIRMED",
          "The WOVEN approval was confirmed, but the required allowance is not available.",
        )
      }

      return Object.freeze({ status: verified, transactions })
    } catch (error) {
      throw withCompletedTransactions(error, transactions)
    }
  })
}

export async function burnCreatorLicense(options) {
  return runProtocolAction("activate creator access", async () => {
    const addresses = requireWriteContracts(options.addresses || wovenContracts)
    await verifyWriteContracts(options.publicClient, addresses)
    await verifyFactoryWiring(options.publicClient, addresses)
    const state = await readLicenseState(options.publicClient, options.account, addresses)
    if (state.licensed) {
      return Object.freeze({ status: state, transaction: null, alreadyLicensed: true })
    }
    if (!state.hasBalance) {
      throw new ProtocolError(
        "INSUFFICIENT_WOVEN_BALANCE",
        `This wallet needs ${state.burnAmountFormatted} ${state.symbol} for creator access.`,
      )
    }
    if (!state.hasAllowance) {
      throw new ProtocolError(
        "LICENSE_APPROVAL_REQUIRED",
        "Approve the required WOVEN amount before activating creator access.",
      )
    }

    const transaction = await executeContractWrite({
      ...options,
      address: addresses.creatorLicense,
      abi: creatorLicenseAbi,
      functionName: "burnForLicense",
      action: "activate creator access",
    })
    const verified = await readLicenseState(options.publicClient, options.account, addresses)
    if (!verified.licensed) {
      throw new ProtocolError(
        "LICENSE_NOT_CONFIRMED",
        "The transaction confirmed, but creator access could not be verified.",
        { txHash: transaction.hash },
      )
    }

    return Object.freeze({ status: verified, transaction, alreadyLicensed: false })
  })
}

export async function activateCreatorLicense(options) {
  return runProtocolAction("activate creator access", async () => {
    const addresses = requireWriteContracts(options.addresses || wovenContracts)
    await verifyWriteContracts(options.publicClient, addresses)
    await verifyFactoryWiring(options.publicClient, addresses)
    const initial = await readLicenseState(options.publicClient, options.account, addresses)
    if (initial.licensed) {
      return Object.freeze({ status: initial, transactions: [], alreadyLicensed: true })
    }
    if (!initial.hasBalance) {
      throw new ProtocolError(
        "INSUFFICIENT_WOVEN_BALANCE",
        `This wallet needs ${initial.burnAmountFormatted} ${initial.symbol} for creator access.`,
      )
    }

    const approval = initial.hasAllowance
      ? { transactions: [] }
      : await approveCreatorLicense({ ...options, addresses })
    let activation
    try {
      activation = await burnCreatorLicense({ ...options, addresses })
    } catch (error) {
      throw withCompletedTransactions(error, approval.transactions)
    }

    return Object.freeze({
      status: activation.status,
      transactions: [...approval.transactions, activation.transaction].filter(Boolean),
      alreadyLicensed: activation.alreadyLicensed,
    })
  })
}
