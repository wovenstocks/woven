// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { wovenContracts } from "../config/contracts"
import { useInjectedWallet } from "./useInjectedWallet"

const ACCOUNT_A = "0x1111111111111111111111111111111111111111"
const ACCOUNT_B = "0x2222222222222222222222222222222222222222"
const CONNECTION_KEY = "woven.wallet.connected"
const PROVIDER_KEY = "woven.wallet.provider"
const CONFIGURED_CHAIN_ID = wovenContracts.chainId
const CONFIGURED_CHAIN_HEX = wovenContracts.chainIdHex
const originalStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage")

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class MockProvider {
  constructor({ accounts = [], chainId = "0x1", handlers = {} } = {}) {
    this.accounts = accounts
    this.chainId = chainId
    this.handlers = handlers
    this.connected = true
    this.listeners = new Map()
    this.request = vi.fn(this.handleRequest.bind(this))
  }

  async handleRequest(payload) {
    const handler = this.handlers[payload.method]
    if (handler) return handler(payload, this)
    if (payload.method === "eth_accounts") return this.accounts
    if (payload.method === "eth_requestAccounts") return this.accounts
    if (payload.method === "eth_chainId") return this.chainId
    return null
  }

  isConnected() {
    return this.connected
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  removeListener(event, listener) {
    this.listeners.get(event)?.delete(listener)
  }

  emit(event, payload) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }
}

function installLegacyProvider(provider) {
  Object.defineProperty(window, "ethereum", {
    configurable: true,
    value: provider,
    writable: true,
  })
}

function announceProvider(provider, overrides = {}) {
  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: {
        info: {
          uuid: "wallet-uuid",
          name: "Test Wallet",
          icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
          rdns: "org.example.wallet",
          ...overrides,
        },
        provider,
      },
    }),
  )
}

beforeEach(() => {
  if (originalStorageDescriptor) {
    Object.defineProperty(window, "localStorage", originalStorageDescriptor)
  }
  window.localStorage.clear()
  delete window.ethereum
})

afterEach(() => {
  cleanup()
  delete window.ethereum
  if (originalStorageDescriptor) {
    Object.defineProperty(window, "localStorage", originalStorageDescriptor)
  }
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe("useInjectedWallet", () => {
  it("discovers a delayed EIP-6963 provider and restores account independently from chain", async () => {
    window.localStorage.setItem(CONNECTION_KEY, "true")
    const provider = new MockProvider({
      accounts: [ACCOUNT_A],
      handlers: {
        eth_chainId: () => Promise.reject(new Error("RPC unavailable")),
      },
    })
    const { result } = renderHook(() => useInjectedWallet())

    expect(result.current.hasProvider).toBe(false)
    act(() => announceProvider(provider))

    await waitFor(() => expect(result.current.account).toBe(ACCOUNT_A))
    expect(result.current.chainId).toBeNull()
    expect(result.current.status).toBe("connected")
    expect(result.current.providerInfo).toMatchObject({
      uuid: "wallet-uuid",
      name: "Test Wallet",
      rdns: "org.example.wallet",
    })
  })

  it("retries an unavailable network without requesting wallet permissions", async () => {
    window.localStorage.setItem(CONNECTION_KEY, "true")
    let networkAvailable = false
    const provider = new MockProvider({
      accounts: [ACCOUNT_A],
      handlers: {
        eth_chainId: () =>
          networkAvailable
            ? Promise.resolve(CONFIGURED_CHAIN_HEX)
            : Promise.reject(new Error("RPC unavailable")),
      },
    })
    installLegacyProvider(provider)
    const { result } = renderHook(() => useInjectedWallet())

    await waitFor(() => expect(result.current.account).toBe(ACCOUNT_A))
    expect(result.current.chainId).toBeNull()

    let response
    networkAvailable = true
    await act(async () => {
      response = await result.current.refreshNetwork()
    })

    expect(response).toEqual({ ok: true, chainId: CONFIGURED_CHAIN_ID })
    expect(result.current.chainId).toBe(CONFIGURED_CHAIN_ID)
    expect(
      provider.request.mock.calls.some(([request]) => request.method === "eth_requestAccounts"),
    ).toBe(false)
  })

  it("replaces unsafe EIP-6963 display metadata and identity fields with safe values", async () => {
    const provider = new MockProvider({ chainId: CONFIGURED_CHAIN_HEX })
    const { result } = renderHook(() => useInjectedWallet())

    act(() =>
      announceProvider(provider, {
        uuid: "wallet\u2066-uuid",
        name: "Meta\u202eMask\u200b",
        rdns: "io.meta\u200bmask",
      }),
    )

    await waitFor(() => expect(result.current.providers).toHaveLength(1))
    expect(result.current.providers[0]).toEqual({
      id: "eip6963:eip6963-0",
      name: "Browser wallet",
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
      rdns: "",
      source: "eip6963",
    })
    expect(JSON.stringify(result.current.providers)).not.toMatch(/[\u200b\u202e\u2066]/u)
  })

  it("supports a legacy provider injected after the hook mounts", async () => {
    const { result } = renderHook(() => useInjectedWallet())
    const provider = new MockProvider({ chainId: CONFIGURED_CHAIN_HEX })

    installLegacyProvider(provider)
    act(() => window.dispatchEvent(new Event("ethereum#initialized")))

    await waitFor(() => expect(result.current.hasProvider).toBe(true))
    await waitFor(() => expect(result.current.chainId).toBe(CONFIGURED_CHAIN_ID))
    expect(result.current.providerInfo.name).toBe("Browser wallet")
    expect(result.current.provider).toBe(provider)
  })

  it("prefers the previously selected provider over the first announcement", async () => {
    window.localStorage.setItem(
      PROVIDER_KEY,
      JSON.stringify({
        uuid: "preferred-uuid",
        rdns: "org.preferred.wallet",
      }),
    )
    const first = new MockProvider()
    const preferred = new MockProvider({ chainId: CONFIGURED_CHAIN_HEX })
    const { result } = renderHook(() => useInjectedWallet())

    act(() => {
      announceProvider(first, {
        uuid: "first-uuid",
        name: "First Wallet",
        rdns: "org.first.wallet",
      })
      announceProvider(preferred, {
        uuid: "preferred-uuid",
        name: "Preferred Wallet",
        rdns: "org.preferred.wallet",
      })
    })

    await waitFor(() => expect(result.current.providerInfo?.name).toBe("Preferred Wallet"))
    await waitFor(() => expect(result.current.chainId).toBe(CONFIGURED_CHAIN_ID))
  })

  it("exposes safe multi-wallet choices and refreshes a persisted selection without requesting permissions", async () => {
    const first = new MockProvider({ chainId: "0x1" })
    const second = new MockProvider({ accounts: [ACCOUNT_B], chainId: CONFIGURED_CHAIN_HEX })
    const { result } = renderHook(() => useInjectedWallet())

    act(() => {
      announceProvider(first, {
        uuid: "first-uuid",
        name: "First Wallet",
        rdns: "org.first.wallet",
      })
      announceProvider(second, {
        uuid: "second-uuid",
        name: "Second Wallet",
        rdns: "org.second.wallet",
      })
    })

    await waitFor(() => expect(result.current.providers).toHaveLength(2))
    expect(result.current.providers).toEqual([
      {
        id: "eip6963:first-uuid",
        name: "First Wallet",
        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
        rdns: "org.first.wallet",
        source: "eip6963",
      },
      {
        id: "eip6963:second-uuid",
        name: "Second Wallet",
        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
        rdns: "org.second.wallet",
        source: "eip6963",
      },
    ])
    expect(result.current.providers[0]).not.toHaveProperty("provider")
    const stableProviderList = result.current.providers

    let response
    act(() => {
      response = result.current.selectProvider("eip6963:second-uuid")
    })

    expect(response).toEqual({ ok: true, id: "eip6963:second-uuid" })
    await waitFor(() => expect(result.current.account).toBe(ACCOUNT_B))
    expect(result.current.chainId).toBe(CONFIGURED_CHAIN_ID)
    expect(result.current.selectedProviderId).toBe("eip6963:second-uuid")
    expect(result.current.providers).toBe(stableProviderList)
    expect(
      second.request.mock.calls.some(([request]) => request.method === "eth_requestAccounts"),
    ).toBe(false)
    expect(JSON.parse(window.localStorage.getItem(PROVIDER_KEY))).toEqual({
      uuid: "second-uuid",
      rdns: "org.second.wallet",
    })
  })

  it("selects and connects a requested provider atomically while its permission prompt is pending", async () => {
    const requestedAccounts = deferred()
    const first = new MockProvider({ chainId: "0x1" })
    const second = new MockProvider({
      chainId: CONFIGURED_CHAIN_HEX,
      handlers: {
        eth_requestAccounts: () => requestedAccounts.promise,
      },
    })
    const { result } = renderHook(() => useInjectedWallet())

    act(() => {
      announceProvider(first, {
        uuid: "first-uuid",
        name: "First Wallet",
        rdns: "org.first.wallet",
      })
      announceProvider(second, {
        uuid: "second-uuid",
        name: "Second Wallet",
        rdns: "org.second.wallet",
      })
    })
    await waitFor(() => expect(result.current.providers).toHaveLength(2))

    let pendingConnection
    act(() => {
      pendingConnection = result.current.connect("eip6963:second-uuid")
    })
    await waitFor(() =>
      expect(second.request).toHaveBeenCalledWith({ method: "eth_requestAccounts" }),
    )
    expect(second.request.mock.calls.some(([request]) => request.method === "eth_accounts")).toBe(
      false,
    )
    expect(first.request).not.toHaveBeenCalledWith({ method: "eth_requestAccounts" })
    expect(result.current.status).toBe("connecting")

    let response
    await act(async () => {
      requestedAccounts.resolve([ACCOUNT_B])
      response = await pendingConnection
    })

    expect(response).toEqual({ ok: true, account: ACCOUNT_B, chainId: CONFIGURED_CHAIN_ID })
    expect(result.current.selectedProviderId).toBe("eip6963:second-uuid")
    expect(result.current.account).toBe(ACCOUNT_B)
  })

  it("cancels a queued silent refresh when selection is immediately followed by connect", async () => {
    const requestedAccounts = deferred()
    const first = new MockProvider({ chainId: "0x1" })
    const second = new MockProvider({
      chainId: CONFIGURED_CHAIN_HEX,
      handlers: {
        eth_requestAccounts: () => requestedAccounts.promise,
      },
    })
    const { result } = renderHook(() => useInjectedWallet())

    act(() => {
      announceProvider(first, { uuid: "first-uuid", rdns: "org.first.wallet" })
      announceProvider(second, { uuid: "second-uuid", rdns: "org.second.wallet" })
    })
    await waitFor(() => expect(result.current.providers).toHaveLength(2))

    let pendingConnection
    act(() => {
      result.current.selectProvider("eip6963:second-uuid")
      pendingConnection = result.current.connect()
    })
    await waitFor(() =>
      expect(second.request).toHaveBeenCalledWith({ method: "eth_requestAccounts" }),
    )
    expect(second.request.mock.calls.some(([request]) => request.method === "eth_accounts")).toBe(
      false,
    )
    expect(result.current.status).toBe("connecting")

    let response
    await act(async () => {
      requestedAccounts.resolve([ACCOUNT_B])
      response = await pendingConnection
    })

    expect(response).toMatchObject({ ok: true, account: ACCOUNT_B })
    expect(result.current.account).toBe(ACCOUNT_B)
  })

  it("prevents a pending connection on the previous wallet from winning a provider-selection race", async () => {
    const pendingAccounts = deferred()
    const first = new MockProvider({
      chainId: "0x1",
      handlers: {
        eth_requestAccounts: () => pendingAccounts.promise,
      },
    })
    const second = new MockProvider({ accounts: [ACCOUNT_B], chainId: CONFIGURED_CHAIN_HEX })
    const { result } = renderHook(() => useInjectedWallet())

    act(() => {
      announceProvider(first, {
        uuid: "first-uuid",
        name: "First Wallet",
        rdns: "org.first.wallet",
      })
      announceProvider(second, {
        uuid: "second-uuid",
        name: "Second Wallet",
        rdns: "org.second.wallet",
      })
    })
    await waitFor(() => expect(result.current.selectedProviderId).toBe("eip6963:first-uuid"))

    let pendingConnection
    act(() => {
      pendingConnection = result.current.connect()
    })
    act(() => {
      first.emit("accountsChanged", [ACCOUNT_A])
      result.current.selectProvider("eip6963:second-uuid")
    })

    await waitFor(() => expect(result.current.account).toBe(ACCOUNT_B))

    let response
    await act(async () => {
      pendingAccounts.resolve([ACCOUNT_A])
      response = await pendingConnection
    })

    expect(response).toEqual({
      ok: false,
      error: "The selected wallet changed during connection.",
    })
    expect(result.current.account).toBe(ACCOUNT_B)
    expect(result.current.chainId).toBe(CONFIGURED_CHAIN_ID)
    expect(result.current.provider).toBe(second)
    expect(
      second.request.mock.calls.some(([request]) => request.method === "eth_requestAccounts"),
    ).toBe(false)
  })

  it("deduplicates connect requests and does not overwrite a newer account event", async () => {
    const requestAccounts = deferred()
    const provider = new MockProvider({
      chainId: CONFIGURED_CHAIN_HEX,
      handlers: {
        eth_requestAccounts: () => requestAccounts.promise,
      },
    })
    installLegacyProvider(provider)
    const { result } = renderHook(() => useInjectedWallet())
    await waitFor(() => expect(result.current.hasProvider).toBe(true))

    let firstConnect
    let secondConnect
    act(() => {
      firstConnect = result.current.connect()
      secondConnect = result.current.connect()
    })
    expect(firstConnect).toBe(secondConnect)

    let response
    await act(async () => {
      provider.emit("accountsChanged", [ACCOUNT_B])
      requestAccounts.resolve([ACCOUNT_A])
      response = await firstConnect
    })

    expect(response).toMatchObject({ ok: true, account: ACCOUNT_B })
    expect(result.current.account).toBe(ACCOUNT_B)
    expect(window.localStorage.getItem(CONNECTION_KEY)).toBe("true")
    expect(
      provider.request.mock.calls.filter(([call]) => call.method === "eth_requestAccounts"),
    ).toHaveLength(1)
  })

  it("treats provider disconnect as recoverable transport state without erasing intent", async () => {
    window.localStorage.setItem(CONNECTION_KEY, "true")
    const provider = new MockProvider({ accounts: [ACCOUNT_A], chainId: CONFIGURED_CHAIN_HEX })
    installLegacyProvider(provider)
    const { result } = renderHook(() => useInjectedWallet())
    await waitFor(() => expect(result.current.account).toBe(ACCOUNT_A))

    act(() => {
      provider.connected = false
      provider.emit("disconnect", { code: 4900 })
    })

    expect(result.current.account).toBe(ACCOUNT_A)
    expect(result.current.chainId).toBeNull()
    expect(result.current.status).toBe("reconnecting")
    expect(result.current.isProviderConnected).toBe(false)
    expect(window.localStorage.getItem(CONNECTION_KEY)).toBe("true")

    act(() => {
      provider.connected = true
      provider.emit("connect", { chainId: CONFIGURED_CHAIN_HEX })
    })

    await waitFor(() => expect(result.current.status).toBe("connected"))
    expect(result.current.account).toBe(ACCOUNT_A)
    expect(result.current.chainId).toBe(CONFIGURED_CHAIN_ID)
    expect(result.current.isProviderConnected).toBe(true)
  })

  it("disconnects locally before optional permission revocation settles", async () => {
    window.localStorage.setItem(CONNECTION_KEY, "true")
    const revoke = deferred()
    const provider = new MockProvider({
      accounts: [ACCOUNT_A],
      chainId: CONFIGURED_CHAIN_HEX,
      handlers: {
        wallet_revokePermissions: () => revoke.promise,
      },
    })
    installLegacyProvider(provider)
    const { result } = renderHook(() => useInjectedWallet())
    await waitFor(() => expect(result.current.account).toBe(ACCOUNT_A))

    act(() => {
      result.current.disconnect()
    })

    expect(result.current.account).toBe("")
    expect(result.current.chainId).toBeNull()
    expect(result.current.status).toBe("disconnected")
    expect(window.localStorage.getItem(CONNECTION_KEY)).toBeNull()
    await waitFor(() =>
      expect(provider.request).toHaveBeenCalledWith({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      }),
    )
  })

  it("invalidates a captured execution context on disconnect", async () => {
    window.localStorage.setItem(CONNECTION_KEY, "true")
    const provider = new MockProvider({ accounts: [ACCOUNT_A], chainId: CONFIGURED_CHAIN_HEX })
    installLegacyProvider(provider)
    const { result } = renderHook(() => useInjectedWallet())
    await waitFor(() => expect(result.current.account).toBe(ACCOUNT_A))

    const snapshot = result.current.captureContext()
    expect(result.current.isContextCurrent(snapshot)).toBe(true)

    act(() => result.current.disconnect())
    expect(result.current.isContextCurrent(snapshot)).toBe(false)
  })

  it("does not let a pending connection restore state after a local disconnect", async () => {
    const requestAccounts = deferred()
    const provider = new MockProvider({
      chainId: CONFIGURED_CHAIN_HEX,
      handlers: {
        eth_requestAccounts: () => requestAccounts.promise,
      },
    })
    installLegacyProvider(provider)
    const { result } = renderHook(() => useInjectedWallet())
    await waitFor(() => expect(result.current.hasProvider).toBe(true))

    let pendingConnection
    act(() => {
      pendingConnection = result.current.connect()
    })
    act(() => {
      result.current.disconnect()
    })

    let response
    await act(async () => {
      requestAccounts.resolve([ACCOUNT_A])
      response = await pendingConnection
    })

    expect(response.ok).toBe(false)
    expect(result.current.account).toBe("")
    expect(result.current.status).toBe("disconnected")
    expect(window.localStorage.getItem(CONNECTION_KEY)).toBeNull()
  })

  it("handles nested string 4902 errors, deduplicates switching, and verifies the final chain", async () => {
    let switchAttempts = 0
    const firstSwitch = deferred()
    const provider = new MockProvider({
      chainId: "0x1",
      handlers: {
        wallet_switchEthereumChain: async (_payload, instance) => {
          switchAttempts += 1
          if (switchAttempts === 1) return firstSwitch.promise
          instance.chainId = CONFIGURED_CHAIN_HEX
          return null
        },
      },
    })
    installLegacyProvider(provider)
    const { result } = renderHook(() => useInjectedWallet())
    await waitFor(() => expect(result.current.hasProvider).toBe(true))

    let firstRequest
    let secondRequest
    act(() => {
      firstRequest = result.current.switchToBnbChain()
      secondRequest = result.current.switchToBnbChain()
    })
    expect(firstRequest).toBe(secondRequest)

    let response
    await act(async () => {
      firstSwitch.reject({ data: JSON.stringify({ originalError: { code: "4902" } }) })
      response = await firstRequest
    })

    expect(response).toEqual({ ok: true, chainId: CONFIGURED_CHAIN_ID })
    expect(result.current.chainId).toBe(CONFIGURED_CHAIN_ID)
    expect(result.current.isBnbChain).toBe(true)
    expect(switchAttempts).toBe(2)
    expect(
      provider.request.mock.calls.filter(([call]) => call.method === "wallet_addEthereumChain"),
    ).toHaveLength(1)
  })

  it("does not report a successful switch until eth_chainId confirms the configured chain", async () => {
    const provider = new MockProvider({ chainId: "0x1" })
    installLegacyProvider(provider)
    const { result } = renderHook(() => useInjectedWallet())
    await waitFor(() => expect(result.current.chainId).toBe(1))

    let response
    await act(async () => {
      response = await result.current.switchToBnbChain()
    })

    expect(response.ok).toBe(false)
    expect(result.current.isBnbChain).toBe(false)
    expect(result.current.error).toBe(
      `The wallet could not switch to ${wovenContracts.networkName}.`,
    )
  })

  it("rejects malformed chain IDs and unwraps nested string cancellation codes", async () => {
    const provider = new MockProvider({
      chainId: `${CONFIGURED_CHAIN_HEX}junk`,
      handlers: {
        eth_requestAccounts: () =>
          Promise.reject({
            data: JSON.stringify({ error: { code: "4001" } }),
          }),
      },
    })
    installLegacyProvider(provider)
    const { result } = renderHook(() => useInjectedWallet())
    await waitFor(() => expect(result.current.hasProvider).toBe(true))

    let response
    await act(async () => {
      response = await result.current.connect()
    })

    expect(result.current.chainId).toBeNull()
    expect(response).toEqual({ ok: false, error: "The wallet request was cancelled." })
    expect(result.current.error).toBe("The wallet request was cancelled.")
  })

  it("continues to work when localStorage access is denied", async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage disabled", "SecurityError")
      },
    })
    const provider = new MockProvider({ accounts: [ACCOUNT_A], chainId: CONFIGURED_CHAIN_HEX })
    installLegacyProvider(provider)

    const { result } = renderHook(() => useInjectedWallet())
    await waitFor(() => expect(result.current.hasProvider).toBe(true))

    let response
    await act(async () => {
      response = await result.current.connect()
    })

    expect(response.ok).toBe(true)
    expect(result.current.account).toBe(ACCOUNT_A)
  })
})
