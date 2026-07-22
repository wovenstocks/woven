import { wovenContracts } from "../config/contracts"
import { basketFactoryAbi, basketTokenAbi, erc20Abi } from "./abis"
import {
  requireReadContracts,
  requireWriteContracts,
  verifyFactoryWiring,
  verifyWriteContracts,
} from "./configuration"
import { ProtocolError, runProtocolAction, withCompletedTransactions } from "./errors"
import { mapWithConcurrency, readContract } from "./reads"
import { readScaledUiAmount } from "./scaled-ui"
import { executeContractWrite } from "./transactions"
import {
  MAX_UINT256,
  ZERO_ADDRESS,
  assertDecimals,
  formatTokenAmount,
  normalizeAddress,
  parseTokenAmount,
  sanitizeTokenSymbol,
  sanitizeTokenText,
} from "./validation"

function sanitizeConstituentMetadata(symbol, name) {
  return Object.freeze({
    symbol: sanitizeTokenSymbol(symbol),
    name: sanitizeTokenText(name, { label: "Constituent name", maxLength: 64 }),
  })
}

async function assertFactoryBasket(publicClient, factoryAddress, basketAddress) {
  const creator = await readContract(publicClient, {
    address: factoryAddress,
    abi: basketFactoryAbi,
    functionName: "creatorOf",
    args: [basketAddress],
  })
  if (typeof creator !== "string" || creator.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    throw new ProtocolError(
      "UNRECOGNIZED_BASKET",
      "This token was not created by the configured Woven factory.",
    )
  }
  return normalizeAddress(creator, "Basket creator")
}

async function verifyBasketWiring(publicClient, addresses, basketAddress) {
  const [guardian, feeRecipient] = await Promise.all([
    readContract(publicClient, {
      address: basketAddress,
      abi: basketTokenAbi,
      functionName: "guardian",
    }),
    readContract(publicClient, {
      address: basketAddress,
      abi: basketTokenAbi,
      functionName: "feeRecipient",
    }),
  ])
  if (
    normalizeAddress(guardian, "Basket guardian") !== addresses.curatorGuardian ||
    normalizeAddress(feeRecipient, "Basket fee recipient") !== addresses.feeSplitter
  ) {
    throw new ProtocolError(
      "CONTRACT_CONFIGURATION_MISMATCH",
      "The basket does not match the configured protocol controls.",
    )
  }
}

function validateRequiredUnits(result) {
  const [tokens, amounts] = Array.isArray(result) ? result : []
  if (
    !Array.isArray(tokens) ||
    !Array.isArray(amounts) ||
    tokens.length < 2 ||
    tokens.length !== amounts.length
  ) {
    throw new ProtocolError(
      "INVALID_BASKET_CONFIGURATION",
      "The basket returned an invalid constituent configuration.",
    )
  }

  const seen = new Set()
  return tokens.map((token, index) => {
    const address = normalizeAddress(token, `Constituent ${index + 1}`)
    const key = address.toLowerCase()
    const amount = amounts[index]
    if (seen.has(key) || typeof amount !== "bigint" || amount <= 0n) {
      throw new ProtocolError(
        "INVALID_BASKET_CONFIGURATION",
        "The basket returned an invalid constituent configuration.",
      )
    }
    seen.add(key)
    return { token: address, amount }
  })
}

async function readRequiredUnits(publicClient, basketAddress, basketAmount) {
  return validateRequiredUnits(
    await readContract(publicClient, {
      address: basketAddress,
      abi: basketTokenAbi,
      functionName: "getRequiredUnits",
      args: [basketAmount],
    }),
  )
}

function assertScaledReviewCurrent(current, review) {
  if (!review) return
  const reviewed = review.constituents || review.backing
  const currentItems = current.constituents || current.backing
  const fields = ["amount", "uiAmount", "uiMultiplier", "newUiMultiplier", "effectiveAt"]
  const matches =
    Array.isArray(reviewed) &&
    Array.isArray(currentItems) &&
    reviewed.length === currentItems.length &&
    currentItems.every((item, index) => {
      const expected = reviewed[index]
      return (
        normalizeAddress(expected?.token, `Reviewed constituent ${index + 1}`) === item.token &&
        fields.every(
          (field) => typeof item[field] === "bigint" && item[field] === expected?.[field],
        )
      )
    })

  if (!matches) {
    throw new ProtocolError(
      "REVIEW_STALE",
      "A constituent amount or corporate-action multiplier changed. Refresh the onchain review before signing.",
    )
  }
}

export async function verifyBasketRecipe(options) {
  return runProtocolAction("verify basket recipe", async () => {
    const basketAddress = normalizeAddress(options.basketAddress, "Basket address")
    const expectedBasket = options.expectedBasket || null
    const expectedRecipe = expectedBasket?.constituents || options.expectedRecipe
    if (!Array.isArray(expectedRecipe) || expectedRecipe.length < 2) {
      throw new ProtocolError(
        "BASKET_RECIPE_REQUIRED",
        "A verified basket recipe is required before enabling this action.",
      )
    }
    if (
      typeof expectedBasket?.name !== "string" ||
      typeof expectedBasket?.symbol !== "string" ||
      !Number.isInteger(expectedBasket?.mintFeeBps)
    ) {
      throw new ProtocolError(
        "BASKET_TERMS_REQUIRED",
        "Verified basket name, symbol and mint fee are required before enabling this action.",
      )
    }
    if (
      expectedBasket.address &&
      normalizeAddress(expectedBasket.address, "Expected basket address") !== basketAddress
    ) {
      throw new ProtocolError(
        "BASKET_RECIPE_MISMATCH",
        "The basket address does not match the configured product.",
      )
    }

    const [actualName, actualSymbol, actualMintFeeBps, actualTokens, actualUnits] =
      await Promise.all([
        readContract(options.publicClient, {
          address: basketAddress,
          abi: basketTokenAbi,
          functionName: "name",
        }),
        readContract(options.publicClient, {
          address: basketAddress,
          abi: basketTokenAbi,
          functionName: "symbol",
        }),
        readContract(options.publicClient, {
          address: basketAddress,
          abi: basketTokenAbi,
          functionName: "mintFeeBps",
        }),
        readContract(options.publicClient, {
          address: basketAddress,
          abi: basketTokenAbi,
          functionName: "constituents",
        }),
        readContract(options.publicClient, {
          address: basketAddress,
          abi: basketTokenAbi,
          functionName: "units",
        }),
      ])
    if (
      !Array.isArray(actualTokens) ||
      !Array.isArray(actualUnits) ||
      actualTokens.length !== expectedRecipe.length ||
      actualTokens.length !== actualUnits.length ||
      typeof actualName !== "string" ||
      typeof actualSymbol !== "string" ||
      !Number.isInteger(actualMintFeeBps) ||
      actualMintFeeBps < 0 ||
      actualMintFeeBps > 50
    ) {
      throw new ProtocolError(
        "BASKET_RECIPE_MISMATCH",
        "The basket contract does not match the configured recipe.",
      )
    }

    const expectedName = sanitizeTokenText(expectedBasket.name, {
      label: "Basket name",
      maxLength: 64,
    })
    const expectedSymbol = sanitizeTokenSymbol(expectedBasket.symbol)
    const sanitizedName = sanitizeTokenText(actualName, {
      label: "Basket name",
      maxLength: 64,
    })
    const sanitizedSymbol = sanitizeTokenSymbol(actualSymbol)

    const expected = await mapWithConcurrency(
      expectedRecipe,
      options.readConcurrency || 4,
      async (item, index) => {
        const token = normalizeAddress(
          item?.token || item?.address,
          `Expected constituent ${index + 1}`,
        )
        if (typeof item.unitsRaw !== "bigint") {
          throw new ProtocolError(
            "BASKET_RAW_RECIPE_REQUIRED",
            "The published basket recipe is missing its pinned raw constituent amounts.",
          )
        }
        return {
          token,
          units: parseTokenAmount(item.unitsRaw, 0, { label: "Expected raw constituent amount" }),
        }
      },
    )

    const matches =
      actualName === sanitizedName &&
      actualSymbol === sanitizedSymbol &&
      sanitizedName === expectedName &&
      sanitizedSymbol === expectedSymbol &&
      actualMintFeeBps === expectedBasket.mintFeeBps &&
      expected.every(
        (item, index) =>
          normalizeAddress(actualTokens[index], `Basket constituent ${index + 1}`) === item.token &&
          actualUnits[index] === item.units,
      )
    if (!matches) {
      throw new ProtocolError(
        "BASKET_RECIPE_MISMATCH",
        "The basket contract does not match the configured recipe.",
      )
    }

    return Object.freeze({
      basketAddress,
      name: sanitizedName,
      symbol: sanitizedSymbol,
      mintFeeBps: actualMintFeeBps,
      constituents: Object.freeze(expected),
    })
  })
}

export async function getBasketRequiredUnits(options) {
  return runProtocolAction("read basket requirements", async () => {
    const basketAddress = normalizeAddress(options.basketAddress, "Basket address")
    const decimals = assertDecimals(
      await readContract(options.publicClient, {
        address: basketAddress,
        abi: basketTokenAbi,
        functionName: "decimals",
      }),
      "Basket decimals",
    )
    const basketAmount = parseTokenAmount(options.amount, decimals, { label: "Basket amount" })
    const required = await readRequiredUnits(options.publicClient, basketAddress, basketAmount)
    const constituents =
      options.includeMetadata === false
        ? required
        : await mapWithConcurrency(required, options.readConcurrency || 4, async (item) => {
            const [scaled, symbol, name] = await Promise.all([
              readScaledUiAmount({
                publicClient: options.publicClient,
                token: item.token,
                rawAmount: item.amount,
              }),
              readContract(options.publicClient, {
                address: item.token,
                abi: erc20Abi,
                functionName: "symbol",
              }),
              readContract(options.publicClient, {
                address: item.token,
                abi: erc20Abi,
                functionName: "name",
              }),
            ])
            const metadata = sanitizeConstituentMetadata(symbol, name)
            return Object.freeze({
              ...item,
              decimals: scaled.decimals,
              ...metadata,
              amountRawFormatted: formatTokenAmount(item.amount, scaled.decimals),
              amountFormatted: scaled.amountFormatted,
              uiAmount: scaled.uiAmount,
              uiMultiplier: scaled.uiMultiplier,
              newUiMultiplier: scaled.newUiMultiplier,
              effectiveAt: scaled.effectiveAt,
            })
          })

    return Object.freeze({
      basketAddress,
      basketAmount,
      basketAmountFormatted: formatTokenAmount(basketAmount, decimals),
      decimals,
      constituents,
    })
  })
}

export async function getBasketMintReadiness(options) {
  return runProtocolAction("read basket mint requirements", async () => {
    const account = normalizeAddress(options.account, "Wallet account")
    const basketAddress = normalizeAddress(options.basketAddress, "Basket address")
    const requirements = await getBasketRequiredUnits({ ...options, basketAddress })

    const [mintPaused, isFullyBacked, totalSupply, supplyCap, mintFeeBps, basketBalance] =
      await Promise.all([
        readContract(options.publicClient, {
          address: basketAddress,
          abi: basketTokenAbi,
          functionName: "mintPaused",
        }),
        readContract(options.publicClient, {
          address: basketAddress,
          abi: basketTokenAbi,
          functionName: "isFullyBacked",
        }),
        readContract(options.publicClient, {
          address: basketAddress,
          abi: basketTokenAbi,
          functionName: "totalSupply",
        }),
        readContract(options.publicClient, {
          address: basketAddress,
          abi: basketTokenAbi,
          functionName: "supplyCap",
        }),
        readContract(options.publicClient, {
          address: basketAddress,
          abi: basketTokenAbi,
          functionName: "mintFeeBps",
        }),
        readContract(options.publicClient, {
          address: basketAddress,
          abi: basketTokenAbi,
          functionName: "balanceOf",
          args: [account],
        }),
      ])
    if (typeof isFullyBacked !== "boolean") {
      throw new ProtocolError("INVALID_BASKET_STATE", "The basket returned invalid backing data.")
    }
    if (
      typeof totalSupply !== "bigint" ||
      typeof supplyCap !== "bigint" ||
      typeof basketBalance !== "bigint" ||
      !Number.isInteger(mintFeeBps) ||
      mintFeeBps < 0 ||
      mintFeeBps > 50
    ) {
      throw new ProtocolError("INVALID_BASKET_STATE", "The basket returned invalid supply data.")
    }

    const constituents = await mapWithConcurrency(
      requirements.constituents,
      options.readConcurrency || 4,
      async (item) => {
        const [balance, allowance] = await Promise.all([
          readContract(options.publicClient, {
            address: item.token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [account],
          }),
          readContract(options.publicClient, {
            address: item.token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [account, basketAddress],
          }),
        ])
        if (typeof balance !== "bigint" || typeof allowance !== "bigint") {
          throw new ProtocolError(
            "INVALID_TOKEN_STATE",
            "A constituent returned invalid balance or allowance data.",
          )
        }
        return Object.freeze({
          ...item,
          balance,
          allowance,
          hasBalance: balance >= item.amount,
          hasAllowance: allowance >= item.amount,
        })
      },
    )

    const supplyAvailable = totalSupply + requirements.basketAmount <= supplyCap
    const feeAmount = (requirements.basketAmount * BigInt(mintFeeBps)) / 10_000n
    const netAmount = requirements.basketAmount - feeAmount
    const blockers = [
      ...(!isFullyBacked ? ["UNDERBACKED"] : []),
      ...(mintPaused ? ["MINT_PAUSED"] : []),
      ...(!supplyAvailable ? ["SUPPLY_CAP_EXCEEDED"] : []),
      ...(constituents.some((item) => !item.hasBalance) ? ["INSUFFICIENT_BALANCE"] : []),
      ...(constituents.some((item) => !item.hasAllowance) ? ["APPROVAL_REQUIRED"] : []),
    ]

    return Object.freeze({
      ...requirements,
      account,
      constituents,
      isFullyBacked,
      mintPaused: Boolean(mintPaused),
      totalSupply,
      supplyCap,
      supplyAvailable,
      mintFeeBps,
      feeAmount,
      feeAmountFormatted: formatTokenAmount(feeAmount, requirements.decimals),
      netAmount,
      netAmountFormatted: formatTokenAmount(netAmount, requirements.decimals),
      basketBalance,
      blockers,
      canMint: blockers.length === 0,
    })
  })
}

export async function getBasketRedemptionReadiness(options) {
  return runProtocolAction("read basket redemption", async () => {
    const { basketFactory } = requireReadContracts(
      ["basketFactory"],
      options.addresses || wovenContracts,
    )
    const account = normalizeAddress(options.account, "Wallet account")
    const basketAddress = normalizeAddress(options.basketAddress, "Basket address")
    const creator = await assertFactoryBasket(options.publicClient, basketFactory, basketAddress)
    if (options.expectedBasket || options.expectedRecipe) {
      await verifyBasketRecipe({ ...options, basketAddress })
    }

    const decimals = assertDecimals(
      await readContract(options.publicClient, {
        address: basketAddress,
        abi: basketTokenAbi,
        functionName: "decimals",
      }),
      "Basket decimals",
    )
    const basketAmount = parseTokenAmount(options.amount, decimals, { label: "Basket amount" })
    const [balance, backingResult] = await Promise.all([
      readContract(options.publicClient, {
        address: basketAddress,
        abi: basketTokenAbi,
        functionName: "balanceOf",
        args: [account],
      }),
      readContract(options.publicClient, {
        address: basketAddress,
        abi: basketTokenAbi,
        functionName: "backingOf",
        args: [basketAmount],
      }),
    ])
    if (typeof balance !== "bigint" || balance < 0n) {
      throw new ProtocolError("INVALID_BASKET_STATE", "The basket returned invalid balance data.")
    }

    const rawBacking = validateRequiredUnits(backingResult)
    const backing = await mapWithConcurrency(
      rawBacking,
      options.readConcurrency || 4,
      async (item) => {
        const [scaled, symbol, name] = await Promise.all([
          readScaledUiAmount({
            publicClient: options.publicClient,
            token: item.token,
            rawAmount: item.amount,
          }),
          readContract(options.publicClient, {
            address: item.token,
            abi: erc20Abi,
            functionName: "symbol",
          }),
          readContract(options.publicClient, {
            address: item.token,
            abi: erc20Abi,
            functionName: "name",
          }),
        ])
        const metadata = sanitizeConstituentMetadata(symbol, name)
        return Object.freeze({
          ...item,
          decimals: scaled.decimals,
          ...metadata,
          amountRawFormatted: formatTokenAmount(item.amount, scaled.decimals),
          amountFormatted: scaled.amountFormatted,
          uiAmount: scaled.uiAmount,
          uiMultiplier: scaled.uiMultiplier,
          newUiMultiplier: scaled.newUiMultiplier,
          effectiveAt: scaled.effectiveAt,
        })
      },
    )
    const canRedeem = balance >= basketAmount

    return Object.freeze({
      account,
      basketAddress,
      creator,
      decimals,
      basketAmount,
      basketAmountFormatted: formatTokenAmount(basketAmount, decimals),
      balance,
      balanceFormatted: formatTokenAmount(balance, decimals),
      backing: Object.freeze(backing),
      blockers: Object.freeze(canRedeem ? [] : ["INSUFFICIENT_BASKET_BALANCE"]),
      canRedeem,
    })
  })
}

function assertMintPreconditions(readiness, options = {}) {
  if (!readiness.isFullyBacked) {
    throw new ProtocolError(
      "UNDERBACKED",
      "This basket is not fully backed. Minting is disabled until backing is restored.",
    )
  }
  if (readiness.mintPaused) {
    throw new ProtocolError("MINT_PAUSED", "Minting is currently paused for this basket.")
  }
  if (!readiness.supplyAvailable) {
    throw new ProtocolError("SUPPLY_CAP_EXCEEDED", "This mint would exceed the basket supply cap.")
  }
  if (readiness.constituents.some((item) => !item.hasBalance)) {
    throw new ProtocolError(
      "INSUFFICIENT_CONSTITUENT_BALANCE",
      "This wallet does not hold every required constituent amount.",
    )
  }
  if (!options.allowMissingApprovals && readiness.constituents.some((item) => !item.hasAllowance)) {
    throw new ProtocolError(
      "CONSTITUENT_APPROVAL_REQUIRED",
      "Approve every required constituent before minting.",
    )
  }
}

export async function approveBasketConstituents(options) {
  return runProtocolAction("approve basket constituents", async () => {
    const addresses = requireWriteContracts(options.addresses || wovenContracts)
    await verifyWriteContracts(options.publicClient, addresses)
    await verifyFactoryWiring(options.publicClient, addresses)
    const basketAddress = normalizeAddress(options.basketAddress, "Basket address")
    await assertFactoryBasket(options.publicClient, addresses.basketFactory, basketAddress)
    await verifyBasketWiring(options.publicClient, addresses, basketAddress)
    await verifyBasketRecipe({ ...options, basketAddress })
    const readiness = await getBasketMintReadiness({ ...options, basketAddress })
    assertScaledReviewCurrent(readiness, options.review)
    assertMintPreconditions(readiness, { allowMissingApprovals: true })

    const transactions = []
    try {
      for (const constituent of readiness.constituents) {
        if (constituent.hasAllowance) continue

        if (constituent.allowance > 0n && options.resetExistingAllowance !== false) {
          transactions.push(
            await executeContractWrite({
              ...options,
              address: constituent.token,
              abi: erc20Abi,
              functionName: "approve",
              args: [basketAddress, 0n],
              action: `reset ${constituent.symbol || "constituent"} approval`,
            }),
          )
        }

        const approvalAmount = options.approvalAmount === "max" ? MAX_UINT256 : constituent.amount
        transactions.push(
          await executeContractWrite({
            ...options,
            address: constituent.token,
            abi: erc20Abi,
            functionName: "approve",
            args: [basketAddress, approvalAmount],
            action: `approve ${constituent.symbol || "constituent"}`,
          }),
        )

        const confirmedAllowance = await readContract(options.publicClient, {
          address: constituent.token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [readiness.account, basketAddress],
        })
        if (typeof confirmedAllowance !== "bigint" || confirmedAllowance < constituent.amount) {
          throw new ProtocolError(
            "APPROVAL_NOT_CONFIRMED",
            "A constituent approval confirmed, but the required allowance is not available.",
            { txHash: transactions.at(-1)?.hash },
          )
        }
      }

      const verified = await getBasketMintReadiness({ ...options, basketAddress })
      assertScaledReviewCurrent(verified, options.review)
      if (verified.constituents.some((item) => !item.hasAllowance)) {
        throw new ProtocolError(
          "APPROVAL_NOT_CONFIRMED",
          "Not every required constituent allowance could be verified.",
        )
      }
      return Object.freeze({ readiness: verified, transactions })
    } catch (error) {
      throw withCompletedTransactions(error, transactions)
    }
  })
}

export async function mintBasket(options) {
  return runProtocolAction("mint basket", async () => {
    const addresses = requireWriteContracts(options.addresses || wovenContracts)
    await verifyWriteContracts(options.publicClient, addresses)
    await verifyFactoryWiring(options.publicClient, addresses)
    const basketAddress = normalizeAddress(options.basketAddress, "Basket address")
    await assertFactoryBasket(options.publicClient, addresses.basketFactory, basketAddress)
    await verifyBasketWiring(options.publicClient, addresses, basketAddress)
    await verifyBasketRecipe({ ...options, basketAddress })

    let readiness = await getBasketMintReadiness({ ...options, basketAddress })
    assertScaledReviewCurrent(readiness, options.review)
    assertMintPreconditions(readiness, {
      allowMissingApprovals: options.approveConstituents !== false,
    })

    const approval = readiness.constituents.some((item) => !item.hasAllowance)
      ? await approveBasketConstituents({ ...options, addresses, basketAddress })
      : { readiness, transactions: [] }
    readiness = approval.readiness
    assertScaledReviewCurrent(readiness, options.review)
    assertMintPreconditions(readiness)

    const transaction = await executeContractWrite({
      ...options,
      account: readiness.account,
      address: basketAddress,
      abi: basketTokenAbi,
      functionName: "mint",
      args: [readiness.basketAmount, readiness.account],
      action: "mint basket",
    })

    return Object.freeze({
      basketAddress,
      readiness,
      approvalTransactions: approval.transactions,
      transaction,
    })
  })
}

export async function redeemBasket(options) {
  return runProtocolAction("redeem basket", async () => {
    const addresses = requireWriteContracts(options.addresses || wovenContracts)
    await verifyWriteContracts(options.publicClient, addresses)
    await verifyFactoryWiring(options.publicClient, addresses)
    const basketAddress = normalizeAddress(options.basketAddress, "Basket address")
    const account = normalizeAddress(options.account, "Wallet account")
    await assertFactoryBasket(options.publicClient, addresses.basketFactory, basketAddress)
    await verifyBasketWiring(options.publicClient, addresses, basketAddress)
    await verifyBasketRecipe({ ...options, basketAddress })

    const readiness = await getBasketRedemptionReadiness({ ...options, basketAddress, account })
    assertScaledReviewCurrent(readiness, options.review)
    if (!readiness.canRedeem) {
      throw new ProtocolError(
        "INSUFFICIENT_BASKET_BALANCE",
        "This wallet does not hold enough basket tokens to redeem that amount.",
      )
    }
    const expectedConstituents = readiness.backing.map(({ token, amount }) => ({ token, amount }))

    const transaction = await executeContractWrite({
      ...options,
      account,
      address: basketAddress,
      abi: basketTokenAbi,
      functionName: "redeem",
      args: [readiness.basketAmount, account],
      action: "redeem basket",
    })

    return Object.freeze({
      basketAddress,
      basketAmount: readiness.basketAmount,
      basketAmountFormatted: readiness.basketAmountFormatted,
      expectedConstituents,
      transaction,
    })
  })
}
