import { describe, expect, it } from "vitest"
import {
  bnbNetwork,
  bnbNetworkProfiles,
  bnbWalletParams,
  createBnbWalletParams,
  missingOneClickContractKeys,
  oneClickContractKeys,
  oneClickContractsConfigured,
  requireConfiguredContract,
  resolveBnbNetworkProfile,
  wovenContracts,
} from "./contracts"

describe("BNB build-time network profile", () => {
  it("defaults to the allowlisted BNB Smart Chain mainnet profile", () => {
    const profile = resolveBnbNetworkProfile()

    expect(profile).toBe(bnbNetworkProfiles.mainnet)
    expect(profile).toMatchObject({
      key: "mainnet",
      chainId: 56,
      chainIdHex: "0x38",
      rpcUrl: "https://bsc-dataseed.bnbchain.org",
      rpcUrls: ["https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed-public.bnbchain.org"],
      explorerBaseUrl: "https://bscscan.com",
      multicall3: {
        address: "0xca11bde05977b3631167028862be2a173976ca11",
        blockCreated: 15_921_452,
      },
      isTestnet: false,
    })
  })

  it("resolves the explicit testnet profile and its wallet parameters", () => {
    const profile = resolveBnbNetworkProfile("testnet")

    expect(profile).toBe(bnbNetworkProfiles.testnet)
    expect(profile).toMatchObject({
      key: "testnet",
      chainId: 97,
      chainIdHex: "0x61",
      rpcUrl: "https://bsc-testnet-dataseed.bnbchain.org",
      rpcUrls: ["https://bsc-testnet-dataseed.bnbchain.org", "https://bsc-testnet.bnbchain.org"],
      explorerBaseUrl: "https://testnet.bscscan.com",
      multicall3: {
        address: "0xca11bde05977b3631167028862be2a173976ca11",
        blockCreated: 17_422_483,
      },
      isTestnet: true,
    })
    expect(profile.nativeCurrency.symbol).toBe("tBNB")

    const params = createBnbWalletParams(profile)
    expect(params).toEqual({
      chainId: "0x61",
      chainName: "BNB Smart Chain Testnet",
      nativeCurrency: { name: "BNB", symbol: "tBNB", decimals: 18 },
      rpcUrls: ["https://bsc-testnet-dataseed.bnbchain.org", "https://bsc-testnet.bnbchain.org"],
      blockExplorerUrls: ["https://testnet.bscscan.com"],
    })
  })

  it("keeps selected wallet parameters aligned with the selected profile", () => {
    expect([bnbNetworkProfiles.mainnet, bnbNetworkProfiles.testnet]).toContain(bnbNetwork)
    expect(wovenContracts.network).toBe(bnbNetwork.key)
    expect(wovenContracts.chainId).toBe(bnbNetwork.chainId)
    expect(bnbWalletParams).toEqual({
      chainId: bnbNetwork.chainIdHex,
      chainName: bnbNetwork.chainName,
      nativeCurrency: bnbNetwork.nativeCurrency,
      rpcUrls: bnbNetwork.rpcUrls,
      blockExplorerUrls: [bnbNetwork.explorerBaseUrl],
    })
  })

  it("fails closed for every non-allowlisted profile", () => {
    for (const value of ["staging", "97", "mainnet,testnet", "local", " ", 97]) {
      expect(() => resolveBnbNetworkProfile(value)).toThrow(/mainnet.*testnet/i)
    }
    expect(() => createBnbWalletParams({ key: "testnet" })).toThrow(/allowlisted/i)
  })

  it("keeps the optional one-click path disabled until every address is configured", () => {
    expect(oneClickContractKeys).toEqual([
      "usdc",
      "oneClickRouter",
      "assetRegistry",
      "basketFactory",
    ])
    expect(oneClickContractsConfigured).toBe(false)
    expect(missingOneClickContractKeys).toContain("usdc")
    expect(missingOneClickContractKeys).toContain("oneClickRouter")

    const configured = {
      usdc: "0x1000000000000000000000000000000000000001",
      oneClickRouter: "0x1000000000000000000000000000000000000002",
    }
    expect(requireConfiguredContract("usdc", configured)).toBe(configured.usdc)
    expect(requireConfiguredContract("oneClickRouter", configured)).toBe(configured.oneClickRouter)
  })
})
