import { wovenContracts } from "../config/contracts"
import { basketFactoryAbi, erc20Abi, feeSplitterAbi } from "./abis"
import { requireWriteContracts, verifyFactoryWiring, verifyWriteContracts } from "./configuration"
import { ProtocolError, runProtocolAction } from "./errors"
import { readContract } from "./reads"
import { executeContractWrite } from "./transactions"
import { ZERO_ADDRESS, normalizeAddress } from "./validation"

async function readDistributionStatus(options, addresses) {
  const basketAddress = normalizeAddress(options.basketAddress, "Basket address")
  const [factoryCreator, splitterCreator, treasury, creatorShareBps, pendingBalance] =
    await Promise.all([
      readContract(options.publicClient, {
        address: addresses.basketFactory,
        abi: basketFactoryAbi,
        functionName: "creatorOf",
        args: [basketAddress],
      }),
      readContract(options.publicClient, {
        address: addresses.feeSplitter,
        abi: feeSplitterAbi,
        functionName: "creatorOf",
        args: [basketAddress],
      }),
      readContract(options.publicClient, {
        address: addresses.feeSplitter,
        abi: feeSplitterAbi,
        functionName: "treasury",
      }),
      readContract(options.publicClient, {
        address: addresses.feeSplitter,
        abi: feeSplitterAbi,
        functionName: "CREATOR_SHARE_BPS",
      }),
      readContract(options.publicClient, {
        address: basketAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [addresses.feeSplitter],
      }),
    ])

  if (
    typeof factoryCreator !== "string" ||
    factoryCreator.toLowerCase() === ZERO_ADDRESS.toLowerCase()
  ) {
    throw new ProtocolError(
      "UNRECOGNIZED_BASKET",
      "This token was not created by the configured Woven factory.",
    )
  }
  const creator = normalizeAddress(factoryCreator, "Factory basket creator")
  if (normalizeAddress(splitterCreator, "Fee-splitter basket creator") !== creator) {
    throw new ProtocolError(
      "CONTRACT_CONFIGURATION_MISMATCH",
      "The basket is not registered consistently with the configured fee splitter.",
    )
  }
  if (
    typeof creatorShareBps !== "bigint" ||
    creatorShareBps !== 6_000n ||
    typeof pendingBalance !== "bigint" ||
    pendingBalance < 0n
  ) {
    throw new ProtocolError(
      "INVALID_FEE_STATE",
      "The fee splitter returned invalid distribution data.",
    )
  }

  const creatorAmount = (pendingBalance * creatorShareBps) / 10_000n
  return Object.freeze({
    basketAddress,
    creator,
    treasury: normalizeAddress(treasury, "Fee treasury"),
    creatorShareBps: Number(creatorShareBps),
    pendingBalance,
    creatorAmount,
    treasuryAmount: pendingBalance - creatorAmount,
    canDistribute: pendingBalance > 0n,
  })
}

export async function getFeeDistributionStatus(options) {
  return runProtocolAction("read basket fees", async () => {
    const addresses = requireWriteContracts(options.addresses || wovenContracts)
    await verifyWriteContracts(options.publicClient, addresses)
    await verifyFactoryWiring(options.publicClient, addresses)
    return readDistributionStatus(options, addresses)
  })
}

async function decodeConfirmedDistribution(receipt, feeSplitterAddress, expectedStatus) {
  const { decodeEventLog } = await import("./viem-codec")
  const logs = Array.isArray(receipt?.logs) ? receipt.logs : []

  for (const log of logs) {
    if (
      typeof log.address !== "string" ||
      log.address.toLowerCase() !== feeSplitterAddress.toLowerCase()
    ) {
      continue
    }

    try {
      const decoded = decodeEventLog({
        abi: feeSplitterAbi,
        eventName: "Distributed",
        data: log.data,
        topics: log.topics,
        strict: true,
      })
      const basketAddress = normalizeAddress(decoded.args.basket, "Distributed basket")
      const creator = normalizeAddress(decoded.args.creator, "Distributed creator")
      const creatorAmount = decoded.args.toCreator
      const treasuryAmount = decoded.args.toTreasury
      const totalAmount = creatorAmount + treasuryAmount
      const expectedCreatorAmount = (totalAmount * BigInt(expectedStatus.creatorShareBps)) / 10_000n

      if (
        decoded.eventName !== "Distributed" ||
        basketAddress !== expectedStatus.basketAddress ||
        creator !== expectedStatus.creator ||
        typeof creatorAmount !== "bigint" ||
        typeof treasuryAmount !== "bigint" ||
        creatorAmount < 0n ||
        treasuryAmount < 0n ||
        totalAmount === 0n ||
        creatorAmount !== expectedCreatorAmount ||
        treasuryAmount !== totalAmount - expectedCreatorAmount
      ) {
        continue
      }

      return Object.freeze({
        basketAddress,
        creator,
        treasury: expectedStatus.treasury,
        creatorAmount,
        treasuryAmount,
        totalAmount,
      })
    } catch {
      // Ignore unrelated or malformed logs from the same transaction.
    }
  }

  throw new ProtocolError(
    "FEE_DISTRIBUTION_EVENT_NOT_FOUND",
    "The transaction confirmed, but this basket's fee distribution could not be verified.",
    { txHash: receipt?.transactionHash || null },
  )
}

export async function distributeBasketFees(options) {
  return runProtocolAction("distribute basket fees", async () => {
    const addresses = requireWriteContracts(options.addresses || wovenContracts)
    await verifyWriteContracts(options.publicClient, addresses)
    await verifyFactoryWiring(options.publicClient, addresses)
    const status = await readDistributionStatus(options, addresses)
    if (!status.canDistribute) {
      throw new ProtocolError("NO_FEES_TO_DISTRIBUTE", "This basket has no pending fees.")
    }

    const transaction = await executeContractWrite({
      ...options,
      address: addresses.feeSplitter,
      abi: feeSplitterAbi,
      functionName: "distribute",
      args: [status.basketAddress],
      action: "distribute basket fees",
    })
    const distribution = await decodeConfirmedDistribution(
      transaction.receipt,
      addresses.feeSplitter,
      status,
    )
    const confirmedStatus = Object.freeze({
      ...status,
      pendingBalance: distribution.totalAmount,
      creatorAmount: distribution.creatorAmount,
      treasuryAmount: distribution.treasuryAmount,
      canDistribute: true,
    })

    return Object.freeze({ status: confirmedStatus, distribution, transaction })
  })
}
