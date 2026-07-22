import { oneClickContractKeys, protocolContractKeys, wovenContracts } from "../config/contracts"
import { basketFactoryAbi, feeSplitterAbi } from "./abis"
import { ProtocolError } from "./errors"
import { readContract } from "./reads"
import { normalizeAddress, requireAddressMap } from "./validation"

export function requireReadContracts(keys, contracts = wovenContracts) {
  return requireAddressMap(contracts, keys)
}

export function requireWriteContracts(contracts = wovenContracts) {
  return requireAddressMap(contracts, protocolContractKeys)
}

export function requireOneClickContracts(contracts = wovenContracts) {
  return requireAddressMap(contracts, oneClickContractKeys)
}

const verifiedConfigurations = new WeakMap()

export async function verifyWriteContracts(publicClient, addresses) {
  if (!publicClient || typeof publicClient.getBytecode !== "function") {
    throw new ProtocolError("RPC_UNAVAILABLE", "BNB Chain contract verification is unavailable.")
  }

  const signature = protocolContractKeys.map((key) => addresses[key].toLowerCase()).join(":")
  let verified = verifiedConfigurations.get(publicClient)
  if (!verified) {
    verified = new Set()
    verifiedConfigurations.set(publicClient, verified)
  }
  if (verified.has(signature)) return addresses

  const bytecodes = await Promise.all(
    protocolContractKeys.map((key) => publicClient.getBytecode({ address: addresses[key] })),
  )
  const missingCodeIndex = bytecodes.findIndex(
    (bytecode) =>
      typeof bytecode !== "string" || !/^0x[0-9a-f]+$/i.test(bytecode) || bytecode === "0x",
  )
  if (missingCodeIndex >= 0) {
    throw new ProtocolError(
      "CONTRACT_CODE_MISSING",
      "At least one configured protocol address is not a contract on BNB Chain.",
      { details: { key: protocolContractKeys[missingCodeIndex] } },
    )
  }

  verified.add(signature)
  return addresses
}

export async function verifyOneClickContracts(publicClient, addresses) {
  if (!publicClient || typeof publicClient.getBytecode !== "function") {
    throw new ProtocolError("RPC_UNAVAILABLE", "BNB Chain contract verification is unavailable.")
  }

  const bytecodes = await Promise.all(
    oneClickContractKeys.map((key) => publicClient.getBytecode({ address: addresses[key] })),
  )
  const missingCodeIndex = bytecodes.findIndex(
    (bytecode) =>
      typeof bytecode !== "string" || !/^0x[0-9a-f]+$/i.test(bytecode) || bytecode === "0x",
  )
  if (missingCodeIndex >= 0) {
    throw new ProtocolError(
      "CONTRACT_CODE_MISSING",
      "At least one configured one-click address is not a contract on BNB Chain.",
      { details: { key: oneClickContractKeys[missingCodeIndex] } },
    )
  }

  return addresses
}

export async function verifyFactoryWiring(publicClient, addresses) {
  const [creatorLicense, assetRegistry, splitter, basketGuardian, splitterFactory] =
    await Promise.all([
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
      readContract(publicClient, {
        address: addresses.basketFactory,
        abi: basketFactoryAbi,
        functionName: "splitter",
      }),
      readContract(publicClient, {
        address: addresses.basketFactory,
        abi: basketFactoryAbi,
        functionName: "basketGuardian",
      }),
      readContract(publicClient, {
        address: addresses.feeSplitter,
        abi: feeSplitterAbi,
        functionName: "factory",
      }),
    ])
  const expected = [
    [creatorLicense, addresses.creatorLicense, "creator license"],
    [assetRegistry, addresses.assetRegistry, "asset registry"],
    [splitter, addresses.feeSplitter, "fee splitter"],
    [basketGuardian, addresses.curatorGuardian, "basket guardian"],
    [splitterFactory, addresses.basketFactory, "fee-splitter factory"],
  ]
  for (const [actual, configured, label] of expected) {
    if (normalizeAddress(actual, `Factory ${label}`) !== configured) {
      throw new ProtocolError(
        "CONTRACT_CONFIGURATION_MISMATCH",
        `The basket factory does not reference the configured ${label}.`,
      )
    }
  }
  return addresses
}
