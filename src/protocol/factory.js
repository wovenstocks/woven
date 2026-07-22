import { wovenContracts } from "../config/contracts"
import {
  assetRegistryAbi,
  basketFactoryAbi,
  basketTokenAbi,
  creatorLicenseAbi,
  erc20Abi,
  feeSplitterAbi,
} from "./abis"
import {
  requireReadContracts,
  requireWriteContracts,
  verifyFactoryWiring,
  verifyWriteContracts,
} from "./configuration"
import { ProtocolError, runProtocolAction } from "./errors"
import { mapWithConcurrency, readContract } from "./reads"
import { convertScaledUiInput } from "./scaled-ui"
import { executeContractWrite } from "./transactions"
import {
  assertDecimals,
  normalizeAddress,
  parseBasisPoints,
  parseTokenAmount,
  sanitizeTokenSymbol,
  sanitizeTokenText,
} from "./validation"

const BASKET_DECIMALS = 18
const MIN_CONSTITUENTS = 2
const MAX_CONSTITUENTS = 20
const MAX_MINT_FEE_BPS = 50

function asErrorDetail(value) {
  if (typeof value === "bigint") return value.toString()
  if (Array.isArray(value)) return value.map(asErrorDetail)
  if (["string", "number", "boolean"].includes(typeof value) || value === null) return value
  return value === undefined ? null : String(value)
}

function addressesMatch(actual, expected) {
  try {
    return normalizeAddress(actual, "Created basket address") === expected
  } catch {
    return false
  }
}

function addressListsMatch(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => addressesMatch(value, expected[index]))
  )
}

function bigintListsMatch(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => typeof value === "bigint" && value === expected[index])
  )
}

function createdBasketMismatch(transaction, basketAddress, field, expected, actual) {
  throw new ProtocolError(
    "BASKET_POST_CONFIRMATION_MISMATCH",
    "The transaction confirmed, but the created basket does not match the reviewed configuration. Do not submit another creation transaction.",
    {
      txHash: transaction.hash,
      details: {
        basketAddress,
        field,
        expected: asErrorDetail(expected),
        actual: asErrorDetail(actual),
      },
    },
  )
}

function requireCreatedMatch(context, field, actual, expected, comparator = Object.is) {
  if (!comparator(actual, expected)) {
    createdBasketMismatch(context.transaction, context.basketAddress, field, expected, actual)
  }
}

async function verifyFactoryConfiguration(publicClient, addresses) {
  const [creatorLicense, assetRegistry, splitter, basketGuardian] = await Promise.all([
    readContract(publicClient, {
      address: addresses.basketFactory,
      abi: basketFactoryAbi,
      functionName: "creatorLicense",
    }),
    readContract(publicClient, {
      address: addresses.basketFactory,
      abi: basketFactoryAbi,
      functionName: "assetRegistry",
    }),
    addresses.feeSplitter
      ? readContract(publicClient, {
          address: addresses.basketFactory,
          abi: basketFactoryAbi,
          functionName: "splitter",
        })
      : Promise.resolve(null),
    addresses.curatorGuardian
      ? readContract(publicClient, {
          address: addresses.basketFactory,
          abi: basketFactoryAbi,
          functionName: "basketGuardian",
        })
      : Promise.resolve(null),
  ])

  const comparisons = [
    [creatorLicense, addresses.creatorLicense, "creator license"],
    [assetRegistry, addresses.assetRegistry, "asset registry"],
    ...(addresses.feeSplitter ? [[splitter, addresses.feeSplitter, "fee splitter"]] : []),
    ...(addresses.curatorGuardian
      ? [[basketGuardian, addresses.curatorGuardian, "basket guardian"]]
      : []),
  ]

  for (const [actual, expected, label] of comparisons) {
    if (normalizeAddress(actual, `Factory ${label}`) !== expected) {
      throw new ProtocolError(
        "CONTRACT_CONFIGURATION_MISMATCH",
        `The basket factory does not reference the configured ${label}.`,
      )
    }
  }
}

function validateConstituentInputs(constituents) {
  if (
    !Array.isArray(constituents) ||
    constituents.length < MIN_CONSTITUENTS ||
    constituents.length > MAX_CONSTITUENTS
  ) {
    throw new ProtocolError(
      "INVALID_CONSTITUENT_COUNT",
      `Choose between ${MIN_CONSTITUENTS} and ${MAX_CONSTITUENTS} constituents.`,
    )
  }

  const seen = new Set()
  return constituents.map((constituent, index) => {
    const token = normalizeAddress(
      constituent?.token || constituent?.address,
      `Constituent ${index + 1}`,
    )
    const key = token.toLowerCase()
    if (seen.has(key)) {
      throw new ProtocolError("DUPLICATE_CONSTITUENT", "Each constituent may appear only once.")
    }
    seen.add(key)
    return { token, units: constituent?.units }
  })
}

export async function prepareBasketCreation(options) {
  return runProtocolAction("prepare basket creation", async () => {
    const baseAddresses = requireReadContracts(
      ["creatorLicense", "assetRegistry", "basketFactory"],
      options.addresses || wovenContracts,
    )
    const addresses = {
      ...baseAddresses,
      ...(options.addresses?.feeSplitter
        ? requireReadContracts(["feeSplitter"], options.addresses)
        : {}),
      ...(options.addresses?.curatorGuardian
        ? requireReadContracts(["curatorGuardian"], options.addresses)
        : {}),
    }
    const account = options.account ? normalizeAddress(options.account, "Creator wallet") : null
    const name = sanitizeTokenText(options.name, { label: "Basket name", maxLength: 64 })
    const symbol = sanitizeTokenSymbol(options.symbol)
    const mintFeeBps = parseBasisPoints(options.mintFeeBps ?? 0, {
      label: "Mint fee",
      max: MAX_MINT_FEE_BPS,
    })
    const initialSupplyCap = parseTokenAmount(options.initialSupplyCap, BASKET_DECIMALS, {
      label: "Initial supply cap",
    })
    const inputs = validateConstituentInputs(options.constituents)

    await verifyFactoryConfiguration(options.publicClient, addresses)

    const [starterCap, ceiling, licensed] = await Promise.all([
      readContract(options.publicClient, {
        address: addresses.basketFactory,
        abi: basketFactoryAbi,
        functionName: "STARTER_CAP",
      }),
      readContract(options.publicClient, {
        address: addresses.basketFactory,
        abi: basketFactoryAbi,
        functionName: "CEILING",
      }),
      account
        ? readContract(options.publicClient, {
            address: addresses.creatorLicense,
            abi: creatorLicenseAbi,
            functionName: "isLicensed",
            args: [account],
          })
        : Promise.resolve(null),
    ])

    if (typeof starterCap !== "bigint" || starterCap <= 0n || initialSupplyCap > starterCap) {
      throw new ProtocolError(
        "SUPPLY_CAP_ABOVE_FACTORY_LIMIT",
        "The initial supply cap is above the current factory limit.",
      )
    }
    if (typeof ceiling !== "bigint" || ceiling < starterCap) {
      throw new ProtocolError(
        "CONTRACT_CONFIGURATION_MISMATCH",
        "The basket factory returned invalid supply limits.",
      )
    }
    if (account && !licensed) {
      throw new ProtocolError(
        "CREATOR_LICENSE_REQUIRED",
        "Activate creator access before publishing a basket.",
      )
    }

    const constituents = await mapWithConcurrency(
      inputs,
      options.readConcurrency || 4,
      async (item) => {
        const [supported, decimals] = await Promise.all([
          readContract(options.publicClient, {
            address: addresses.assetRegistry,
            abi: assetRegistryAbi,
            functionName: "isSupported",
            args: [item.token],
          }),
          readContract(options.publicClient, {
            address: item.token,
            abi: erc20Abi,
            functionName: "decimals",
          }),
        ])
        if (!supported) {
          throw new ProtocolError(
            "UNSUPPORTED_CONSTITUENT",
            "At least one constituent is not approved by the canonical registry.",
            { details: { token: item.token } },
          )
        }

        const parsedDecimals = assertDecimals(decimals)
        const converted = await convertScaledUiInput({
          publicClient: options.publicClient,
          token: item.token,
          amount: item.units,
          decimals: parsedDecimals,
          label: "Displayed constituent amount",
        })
        if (converted.rounded) {
          throw new ProtocolError(
            "SCALED_UI_ROUNDING_REVIEW_REQUIRED",
            "That displayed amount cannot be represented exactly by this bStock. Choose another amount.",
            {
              details: {
                token: item.token,
                requestedUiAmount: converted.requestedUiAmount.toString(),
                normalizedUiAmount: converted.uiAmount.toString(),
              },
            },
          )
        }
        return Object.freeze({
          token: item.token,
          decimals: parsedDecimals,
          units: converted.rawAmount,
          unitsUi: converted.uiAmount,
          unitsUiFormatted: converted.amountFormatted,
          requestedUnitsUi: converted.requestedUiAmount,
          uiMultiplier: converted.uiMultiplier,
          newUiMultiplier: converted.newUiMultiplier,
          effectiveAt: converted.effectiveAt,
          rounded: converted.rounded,
        })
      },
    )

    return Object.freeze({
      account,
      name,
      symbol,
      constituents,
      tokens: constituents.map((item) => item.token),
      unitsPerBasket: constituents.map((item) => item.units),
      mintFeeBps,
      initialSupplyCap,
      starterCap,
      ceiling,
    })
  })
}

async function decodeCreatedBasket(receipt, factoryAddress, creator, txHash) {
  const { decodeEventLog } = await import("./viem-codec")
  for (const log of receipt.logs || []) {
    if (
      typeof log.address !== "string" ||
      log.address.toLowerCase() !== factoryAddress.toLowerCase()
    ) {
      continue
    }
    try {
      const decoded = decodeEventLog({
        abi: basketFactoryAbi,
        eventName: "BasketCreated",
        data: log.data,
        topics: log.topics,
        strict: true,
      })
      if (
        decoded.eventName === "BasketCreated" &&
        normalizeAddress(decoded.args.creator, "Basket creator") === creator
      ) {
        return Object.freeze({
          basketAddress: normalizeAddress(decoded.args.basket, "Created basket"),
          creator,
          name: decoded.args.name,
          symbol: decoded.args.symbol,
          initialSupplyCap: decoded.args.initialSupplyCap,
        })
      }
    } catch {
      // Ignore unrelated logs emitted by calls made during basket creation.
    }
  }

  throw new ProtocolError(
    "BASKET_EVENT_NOT_FOUND",
    "The transaction confirmed, but the created basket address could not be verified.",
    { txHash },
  )
}

async function verifyCreatedBasket(options) {
  const { publicClient, addresses, prepared, createdEvent, transaction } = options
  const basketAddress = createdEvent.basketAddress
  const context = { basketAddress, transaction }
  const [
    bytecode,
    factoryCreator,
    splitterCreator,
    name,
    symbol,
    decimals,
    tokens,
    unitsPerBasket,
    mintFeeBps,
    supplyCap,
    maxSupplyCap,
    guardian,
    feeRecipient,
  ] = await Promise.all([
    publicClient.getBytecode({ address: basketAddress }),
    readContract(publicClient, {
      address: addresses.basketFactory,
      abi: basketFactoryAbi,
      functionName: "creatorOf",
      args: [basketAddress],
    }),
    readContract(publicClient, {
      address: addresses.feeSplitter,
      abi: feeSplitterAbi,
      functionName: "creatorOf",
      args: [basketAddress],
    }),
    readContract(publicClient, {
      address: basketAddress,
      abi: basketTokenAbi,
      functionName: "name",
    }),
    readContract(publicClient, {
      address: basketAddress,
      abi: basketTokenAbi,
      functionName: "symbol",
    }),
    readContract(publicClient, {
      address: basketAddress,
      abi: basketTokenAbi,
      functionName: "decimals",
    }),
    readContract(publicClient, {
      address: basketAddress,
      abi: basketTokenAbi,
      functionName: "constituents",
    }),
    readContract(publicClient, {
      address: basketAddress,
      abi: basketTokenAbi,
      functionName: "units",
    }),
    readContract(publicClient, {
      address: basketAddress,
      abi: basketTokenAbi,
      functionName: "mintFeeBps",
    }),
    readContract(publicClient, {
      address: basketAddress,
      abi: basketTokenAbi,
      functionName: "supplyCap",
    }),
    readContract(publicClient, {
      address: basketAddress,
      abi: basketTokenAbi,
      functionName: "maxSupplyCap",
    }),
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

  requireCreatedMatch(
    context,
    "bytecode",
    typeof bytecode === "string" && /^0x[0-9a-f]+$/i.test(bytecode) && bytecode !== "0x",
    true,
  )
  requireCreatedMatch(context, "event.name", createdEvent.name, prepared.name)
  requireCreatedMatch(context, "event.symbol", createdEvent.symbol, prepared.symbol)
  requireCreatedMatch(
    context,
    "event.initialSupplyCap",
    createdEvent.initialSupplyCap,
    prepared.initialSupplyCap,
  )
  requireCreatedMatch(
    context,
    "factory.creatorOf",
    factoryCreator,
    prepared.account,
    addressesMatch,
  )
  requireCreatedMatch(
    context,
    "feeSplitter.creatorOf",
    splitterCreator,
    prepared.account,
    addressesMatch,
  )
  requireCreatedMatch(context, "name", name, prepared.name)
  requireCreatedMatch(context, "symbol", symbol, prepared.symbol)
  requireCreatedMatch(context, "decimals", decimals, BASKET_DECIMALS)
  requireCreatedMatch(context, "constituents", tokens, prepared.tokens, addressListsMatch)
  requireCreatedMatch(
    context,
    "unitsPerBasket",
    unitsPerBasket,
    prepared.unitsPerBasket,
    bigintListsMatch,
  )
  requireCreatedMatch(context, "mintFeeBps", mintFeeBps, prepared.mintFeeBps)
  requireCreatedMatch(context, "supplyCap", supplyCap, prepared.initialSupplyCap)
  requireCreatedMatch(context, "maxSupplyCap", maxSupplyCap, prepared.ceiling)
  requireCreatedMatch(context, "guardian", guardian, addresses.curatorGuardian, addressesMatch)
  requireCreatedMatch(context, "feeRecipient", feeRecipient, addresses.feeSplitter, addressesMatch)

  return Object.freeze({
    basketAddress,
    creator: prepared.account,
    name,
    symbol,
    decimals,
    constituents: Object.freeze([...tokens]),
    unitsPerBasket: Object.freeze([...unitsPerBasket]),
    mintFeeBps,
    supplyCap,
    maxSupplyCap,
    guardian: addresses.curatorGuardian,
    feeRecipient: addresses.feeSplitter,
  })
}

export async function createBasket(options) {
  return runProtocolAction("create basket", async () => {
    const addresses = requireWriteContracts(options.addresses || wovenContracts)
    await verifyWriteContracts(options.publicClient, addresses)
    await verifyFactoryWiring(options.publicClient, addresses)
    const prepared = await prepareBasketCreation({ ...options, addresses })
    if (!prepared.account) {
      throw new ProtocolError("WALLET_REQUIRED", "Connect a creator wallet before publishing.")
    }

    const transaction = await executeContractWrite({
      ...options,
      account: prepared.account,
      address: addresses.basketFactory,
      abi: basketFactoryAbi,
      functionName: "createBasket",
      args: [
        prepared.name,
        prepared.symbol,
        prepared.tokens,
        prepared.unitsPerBasket,
        prepared.mintFeeBps,
        prepared.initialSupplyCap,
      ],
      action: "create basket",
    })
    const createdEvent = await decodeCreatedBasket(
      transaction.receipt,
      addresses.basketFactory,
      prepared.account,
      transaction.hash,
    )
    let verifiedBasket
    try {
      verifiedBasket = await verifyCreatedBasket({
        publicClient: options.publicClient,
        addresses,
        prepared,
        createdEvent,
        transaction,
      })
    } catch (error) {
      if (error instanceof ProtocolError && error.txHash) throw error
      throw new ProtocolError(
        "BASKET_POST_CONFIRMATION_UNVERIFIED",
        "The transaction confirmed, but the created basket state could not be verified. Do not submit another creation transaction.",
        {
          cause: error,
          txHash: transaction.hash,
          details: { basketAddress: createdEvent.basketAddress },
        },
      )
    }

    return Object.freeze({
      basketAddress: createdEvent.basketAddress,
      prepared,
      verifiedBasket,
      transaction,
    })
  })
}
