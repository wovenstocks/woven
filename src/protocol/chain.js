import { bnbNetwork } from "../config/contracts"

export const bnbChain = Object.freeze({
  id: bnbNetwork.chainId,
  name: bnbNetwork.chainName,
  nativeCurrency: bnbNetwork.nativeCurrency,
  rpcUrls: Object.freeze({
    default: Object.freeze({ http: bnbNetwork.rpcUrls }),
  }),
  blockExplorers: Object.freeze({
    default: Object.freeze({ name: "BscScan", url: bnbNetwork.explorerBaseUrl }),
  }),
  contracts: Object.freeze({
    multicall3: bnbNetwork.multicall3,
  }),
  testnet: bnbNetwork.isTestnet,
})
