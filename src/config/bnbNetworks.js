const multicall3Address = "0xca11bde05977b3631167028862be2a173976ca11"

function createNetworkProfile({
  key,
  chainId,
  chainName,
  networkName,
  nativeCurrency,
  rpcUrls,
  explorerBaseUrl,
  multicall3BlockCreated,
}) {
  return Object.freeze({
    key,
    chainId,
    chainIdHex: `0x${chainId.toString(16)}`,
    chainName,
    networkName,
    nativeCurrency: Object.freeze(nativeCurrency),
    rpcUrl: rpcUrls[0],
    rpcUrls: Object.freeze(rpcUrls),
    explorerBaseUrl,
    multicall3: Object.freeze({
      address: multicall3Address,
      blockCreated: multicall3BlockCreated,
    }),
    isTestnet: key === "testnet",
  })
}

export const bnbNetworkProfiles = Object.freeze({
  mainnet: createNetworkProfile({
    key: "mainnet",
    chainId: 56,
    chainName: "BNB Smart Chain",
    networkName: "BNB Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: ["https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed-public.bnbchain.org"],
    explorerBaseUrl: "https://bscscan.com",
    multicall3BlockCreated: 15_921_452,
  }),
  testnet: createNetworkProfile({
    key: "testnet",
    chainId: 97,
    chainName: "BNB Smart Chain Testnet",
    networkName: "BNB Chain Testnet",
    nativeCurrency: { name: "BNB", symbol: "tBNB", decimals: 18 },
    rpcUrls: ["https://bsc-testnet-dataseed.bnbchain.org", "https://bsc-testnet.bnbchain.org"],
    explorerBaseUrl: "https://testnet.bscscan.com",
    multicall3BlockCreated: 17_422_483,
  }),
})

export function resolveBnbNetworkProfile(value) {
  if (value === undefined || value === null || value === "") return bnbNetworkProfiles.mainnet

  const key = typeof value === "string" ? value.trim().toLowerCase() : ""

  const profile = bnbNetworkProfiles[key]
  if (!profile) {
    throw new Error('VITE_BNB_NETWORK must be either "mainnet" or "testnet".')
  }
  return profile
}

export function createBnbWalletParams(profile) {
  if (!profile || !Object.values(bnbNetworkProfiles).includes(profile)) {
    throw new Error("Wallet parameters require an allowlisted BNB network profile.")
  }

  return Object.freeze({
    chainId: profile.chainIdHex,
    chainName: profile.chainName,
    nativeCurrency: profile.nativeCurrency,
    rpcUrls: profile.rpcUrls,
    blockExplorerUrls: Object.freeze([profile.explorerBaseUrl]),
  })
}
