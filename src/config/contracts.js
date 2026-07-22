import { bnbNetworkProfiles, createBnbWalletParams, resolveBnbNetworkProfile } from "./bnbNetworks"

const addressPattern = /^0x[a-fA-F0-9]{40}$/
const zeroAddressPattern = /^0x0{40}$/i

export { bnbNetworkProfiles, createBnbWalletParams, resolveBnbNetworkProfile }

export const bnbNetwork = resolveBnbNetworkProfile(import.meta.env.VITE_BNB_NETWORK)

export const protocolContractKeys = Object.freeze([
  "wovenToken",
  "creatorLicense",
  "assetRegistry",
  "feeSplitter",
  "curatorGuardian",
  "basketFactory",
])

export const oneClickContractKeys = Object.freeze([
  "usdc",
  "oneClickRouter",
  "assetRegistry",
  "basketFactory",
])

export const wovenContracts = Object.freeze({
  network: bnbNetwork.key,
  chainId: bnbNetwork.chainId,
  chainIdHex: bnbNetwork.chainIdHex,
  networkName: bnbNetwork.networkName,
  explorerBaseUrl: bnbNetwork.explorerBaseUrl,
  rpcUrl: bnbNetwork.rpcUrl,
  rpcUrls: bnbNetwork.rpcUrls,
  wovenToken: import.meta.env.VITE_WOVEN_TOKEN || "",
  creatorLicense: import.meta.env.VITE_CREATOR_LICENSE || "",
  assetRegistry: import.meta.env.VITE_ASSET_REGISTRY || "",
  feeSplitter: import.meta.env.VITE_FEE_SPLITTER || "",
  curatorGuardian: import.meta.env.VITE_CURATOR_GUARDIAN || "",
  basketFactory: import.meta.env.VITE_BASKET_FACTORY || "",
  usdc: import.meta.env.VITE_USDC || "",
  oneClickRouter: import.meta.env.VITE_ONE_CLICK_ROUTER || "",
})

export const bnbWalletParams = createBnbWalletParams(bnbNetwork)

export const isConfiguredAddress = (address) =>
  addressPattern.test(address) && !zeroAddressPattern.test(address)

const addressEntries = protocolContractKeys.map((key) => [key, wovenContracts[key]])

export const missingContractKeys = addressEntries
  .filter(([, address]) => !isConfiguredAddress(address))
  .map(([key]) => key)

export const contractAddressesConfigured = missingContractKeys.length === 0

const oneClickAddressEntries = oneClickContractKeys.map((key) => [key, wovenContracts[key]])

export const missingOneClickContractKeys = oneClickAddressEntries
  .filter(([, address]) => !isConfiguredAddress(address))
  .map(([key]) => key)

export const oneClickContractsConfigured = missingOneClickContractKeys.length === 0

export function requireConfiguredContract(key, contracts = wovenContracts) {
  if (!protocolContractKeys.includes(key) && !oneClickContractKeys.includes(key)) {
    throw new Error(`Unknown protocol contract key: ${key}`)
  }

  const address = contracts[key]
  if (!isConfiguredAddress(address)) {
    throw new Error(`Protocol contract is not configured: ${key}`)
  }

  return address
}
