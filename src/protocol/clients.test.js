import { describe, expect, it, vi } from "vitest"
import { bnbNetworkProfiles, wovenContracts } from "../config/contracts"
import { createBnbPublicClient, createInjectedWalletClient } from "./clients"

const ACCOUNT = "0x1111111111111111111111111111111111111111"

describe("BNB Chain clients", () => {
  it("creates a lazy public client with allowlisted endpoint failover", async () => {
    const client = await createBnbPublicClient()
    expect(client.chain.id).toBe(wovenContracts.chainId)
    expect(client.transport.type).toBe("fallback")

    const pinnedClient = await createBnbPublicClient({ rpcUrl: wovenContracts.rpcUrl })
    expect(pinnedClient.transport.type).toBe("http")
  })

  it("rejects RPC overrides that could mix networks and missing providers", async () => {
    await expect(createBnbPublicClient({ rpcUrl: "http://localhost:8545" })).rejects.toMatchObject({
      code: "INVALID_RPC_URL",
    })
    const otherRpcUrl =
      wovenContracts.network === "mainnet"
        ? bnbNetworkProfiles.testnet.rpcUrl
        : bnbNetworkProfiles.mainnet.rpcUrl
    await expect(createBnbPublicClient({ rpcUrl: otherRpcUrl })).rejects.toMatchObject({
      code: "INVALID_RPC_URL",
    })
    await expect(createInjectedWalletClient({ account: ACCOUNT })).rejects.toMatchObject({
      code: "WALLET_UNAVAILABLE",
    })
  })

  it("uses the injected EIP-1193 provider and verifies the selected chain", async () => {
    const provider = {
      request: vi.fn(async ({ method }) => {
        if (method === "eth_chainId") return wovenContracts.chainIdHex
        throw new Error(`Unexpected method ${method}`)
      }),
    }
    const client = await createInjectedWalletClient({ provider, account: ACCOUNT })
    expect(client.account.address).toBe(ACCOUNT)
    expect(await client.getChainId()).toBe(wovenContracts.chainId)
    expect(provider.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "eth_requestAccounts" }),
    )
  })

  it("fails closed when the injected provider is on another chain", async () => {
    const provider = { request: vi.fn(async () => "0x1") }
    await expect(createInjectedWalletClient({ provider, account: ACCOUNT })).rejects.toMatchObject({
      code: "CHAIN_MISMATCH",
    })
  })
})
