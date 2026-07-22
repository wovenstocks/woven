import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { bnbWalletParams, wovenContracts } from "../config/contracts"

const CONNECTION_KEY = "woven.wallet.connected"
const PROVIDER_KEY = "woven.wallet.provider"
const LEGACY_PROVIDER_PREFIX = "legacy"
const DISCOVERY_POLL_INTERVAL_MS = 500
const MAX_ANNOUNCED_PROVIDERS = 32
const MAX_PROVIDER_ICON_LENGTH = 128_000
const MAX_PROVIDER_NAME_LENGTH = 80
const MAX_PROVIDER_UUID_LENGTH = 128
const MAX_PROVIDER_RDNS_LENGTH = 255
const unsafeProviderTextPattern = /[\p{Cc}\p{Cf}]/u
const providerIdentityPattern = /^[\x21-\x7e]+$/
const providerRdnsPattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function limitedString(value, maximumLength) {
  return typeof value === "string" ? value.slice(0, maximumLength) : ""
}

function safeProviderName(value) {
  if (typeof value !== "string") return "Browser wallet"
  const name = value.normalize("NFKC").trim().replace(/\s+/gu, " ")
  if (!name || name.length > MAX_PROVIDER_NAME_LENGTH || unsafeProviderTextPattern.test(name)) {
    return "Browser wallet"
  }
  return name
}

function safeProviderUuid(value) {
  if (typeof value !== "string") return ""
  const uuid = value.trim()
  if (
    !uuid ||
    uuid.length > MAX_PROVIDER_UUID_LENGTH ||
    unsafeProviderTextPattern.test(uuid) ||
    !providerIdentityPattern.test(uuid)
  ) {
    return ""
  }
  return uuid
}

function safeProviderRdns(value) {
  if (typeof value !== "string") return ""
  const rdns = value.trim().toLowerCase()
  if (
    !rdns ||
    rdns.length > MAX_PROVIDER_RDNS_LENGTH ||
    unsafeProviderTextPattern.test(rdns) ||
    !providerRdnsPattern.test(rdns)
  ) {
    return ""
  }
  return rdns
}

function getStorage() {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readStorage(key) {
  try {
    return getStorage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeStorage(key, value) {
  try {
    getStorage()?.setItem(key, value)
  } catch {
    // Wallet access must still work when storage is unavailable or full.
  }
}

function removeStorage(key) {
  try {
    getStorage()?.removeItem(key)
  } catch {
    // Wallet access must still work when storage is unavailable.
  }
}

function readPreferredProvider() {
  const stored = readStorage(PROVIDER_KEY)
  if (!stored) return null

  try {
    const value = JSON.parse(stored)
    if (!value || typeof value !== "object") return null
    const uuid = safeProviderUuid(value.uuid)
    const rdns = safeProviderRdns(value.rdns)
    return uuid || rdns ? { uuid, rdns } : null
  } catch {
    return null
  }
}

function rememberProvider(entry) {
  if (!entry) return
  writeStorage(
    PROVIDER_KEY,
    JSON.stringify({
      uuid: entry.info.uuid,
      rdns: entry.info.rdns,
    }),
  )
}

function normalizeChainId(value) {
  let parsed

  try {
    if (typeof value === "bigint") {
      parsed = value
    } else if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) return null
      parsed = BigInt(value)
    } else if (typeof value === "string") {
      if (/^0x[0-9a-f]+$/i.test(value) || /^(0|[1-9][0-9]*)$/.test(value)) {
        parsed = BigInt(value)
      } else {
        return null
      }
    } else {
      return null
    }
  } catch {
    return null
  }

  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(parsed)
}

function normalizeErrorCode(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value
  if (typeof value !== "string" || !/^-?[0-9]+$/.test(value.trim())) return null

  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) ? parsed : null
}

function findErrorCode(error) {
  const queue = [error]
  const visited = new Set()

  while (queue.length) {
    const current = queue.shift()
    const direct = normalizeErrorCode(current)
    if (direct !== null) return direct

    if (typeof current === "string") {
      try {
        queue.push(JSON.parse(current))
      } catch {
        // Ordinary error messages are not structured wallet errors.
      }
      continue
    }

    if (!current || typeof current !== "object" || visited.has(current)) continue
    visited.add(current)

    const code = normalizeErrorCode(current.code)
    if (code !== null) return code

    for (const key of ["error", "data", "cause", "originalError"]) {
      if (current[key] !== undefined) queue.push(current[key])
    }
  }

  return null
}

function walletError(error, fallback) {
  const code = findErrorCode(error)
  if (code === 4001) return "The wallet request was cancelled."
  if (code === -32002) return "A wallet request is already open. Check your wallet."
  return fallback
}

function getLegacyName(provider, index) {
  if (provider?.isMetaMask) return "MetaMask"
  if (provider?.isCoinbaseWallet) return "Coinbase Wallet"
  if (provider?.isBraveWallet) return "Brave Wallet"
  if (provider?.isRabby) return "Rabby Wallet"
  return index === 0 ? "Browser wallet" : `Browser wallet ${index + 1}`
}

function createProviderEntry(provider, info, fallbackKey, source = "eip6963") {
  if (!provider || typeof provider.request !== "function") return null

  const uuid = safeProviderUuid(info?.uuid) || fallbackKey
  const icon = limitedString(info?.icon, MAX_PROVIDER_ICON_LENGTH)
  return {
    provider,
    key: `${source}:${uuid}`,
    source,
    info: {
      uuid,
      name: safeProviderName(info?.name),
      icon: icon.startsWith("data:image/") ? icon : "",
      rdns: safeProviderRdns(info?.rdns),
    },
  }
}

function matchesPreferredProvider(entry, preferred) {
  if (!entry || !preferred) return false
  if (preferred.uuid && entry.info.uuid === preferred.uuid) return true
  return Boolean(preferred.rdns && entry.info.rdns && entry.info.rdns === preferred.rdns)
}

function providerStartsConnected(provider) {
  try {
    return provider.isConnected?.() !== false
  } catch {
    return true
  }
}

function firstAccount(accounts) {
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") return ""
  return accounts[0]
}

async function readChain(provider) {
  const value = await provider.request({ method: "eth_chainId" })
  const chainId = normalizeChainId(value)
  if (chainId === null) throw new Error("The wallet returned an invalid chain ID.")
  return chainId
}

export function useInjectedWallet() {
  const [account, setAccount] = useState("")
  const [chainId, setChainId] = useState(null)
  const [status, setStatus] = useState("checking")
  const [error, setError] = useState(null)
  const [isSwitching, setIsSwitching] = useState(false)
  const [providerEntry, setProviderEntry] = useState(null)
  const [providerEntries, setProviderEntries] = useState([])
  const [providerRefreshRevision, setProviderRefreshRevision] = useState(0)
  const [isProviderConnected, setIsProviderConnected] = useState(false)

  const mountedRef = useRef(true)
  const providerRef = useRef(null)
  const announcedProvidersRef = useRef(new Map())
  const preferredProviderRef = useRef(readPreferredProvider())
  const connectionIntentRef = useRef(readStorage(CONNECTION_KEY) === "true")
  const connectRequestedRef = useRef(false)
  const operationEpochRef = useRef(0)
  const accountRevisionRef = useRef(0)
  const chainRevisionRef = useRef(0)
  const transportRevisionRef = useRef(0)
  const accountRef = useRef("")
  const chainIdRef = useRef(null)
  const providerConnectedRef = useRef(false)
  const connectPromiseRef = useRef(null)
  const switchPromiseRef = useRef(null)
  const selectProviderImplRef = useRef(null)
  const forceAccountRefreshRef = useRef(null)

  const updateAccount = useCallback((nextAccount) => {
    accountRef.current = nextAccount
    if (mountedRef.current) setAccount(nextAccount)
  }, [])

  const updateChainId = useCallback((nextChainId) => {
    chainIdRef.current = nextChainId
    if (mountedRef.current) setChainId(nextChainId)
  }, [])

  const updateProviderConnection = useCallback((connected) => {
    providerConnectedRef.current = connected
    if (mountedRef.current) setIsProviderConnected(connected)
  }, [])

  const invalidateOperations = useCallback(() => {
    operationEpochRef.current += 1
    return operationEpochRef.current
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationEpochRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return undefined

    let active = true
    let pollTimer = null

    const publishProviders = () => {
      if (active) setProviderEntries([...announcedProvidersRef.current.values()])
    }

    const activateProvider = (entry, options = {}) => {
      if (!active || !entry) return
      const { persist = false, refreshAccount = false } = options
      const previous = providerRef.current
      const unchanged = previous?.provider === entry.provider && previous?.key === entry.key

      if (persist) {
        rememberProvider(entry)
        preferredProviderRef.current = {
          uuid: entry.info.uuid,
          rdns: entry.info.rdns,
        }
      }

      if (refreshAccount) {
        forceAccountRefreshRef.current = entry.provider
        setProviderRefreshRevision((revision) => revision + 1)
      }

      if (unchanged) {
        setError(null)
        if (refreshAccount) setStatus("checking")
        return
      }

      if (previous?.provider === entry.provider) {
        providerRef.current = entry
        setProviderEntry(entry)
        if (connectionIntentRef.current && !persist) {
          rememberProvider(entry)
          preferredProviderRef.current = {
            uuid: entry.info.uuid,
            rdns: entry.info.rdns,
          }
        }
        return
      }

      providerRef.current = entry
      connectPromiseRef.current = null
      switchPromiseRef.current = null
      connectRequestedRef.current = false
      invalidateOperations()
      accountRevisionRef.current += 1
      chainRevisionRef.current += 1
      transportRevisionRef.current += 1
      updateAccount("")
      updateChainId(null)
      setProviderEntry(entry)
      updateProviderConnection(providerStartsConnected(entry.provider))
      setStatus(connectionIntentRef.current || refreshAccount ? "checking" : "disconnected")
      setIsSwitching(false)
      setError(null)
      if (pollTimer !== null) {
        window.clearInterval(pollTimer)
        pollTimer = null
      }
    }

    selectProviderImplRef.current = (id, options = {}) => {
      const entry = announcedProvidersRef.current.get(id)
      if (!entry) {
        const message = "The selected wallet is no longer available."
        setError(message)
        return { ok: false, error: message }
      }

      activateProvider(entry, {
        persist: true,
        refreshAccount: options.refreshAccount !== false,
      })
      return { ok: true, id: entry.key }
    }

    const registerProvider = (provider, info, fallbackKey, source = "eip6963") => {
      const entry = createProviderEntry(provider, info, fallbackKey, source)
      if (!entry) return

      const existingForProvider = [...announcedProvidersRef.current.values()].find(
        (candidate) => candidate.provider === provider,
      )

      if (existingForProvider) {
        if (existingForProvider.source === "legacy" && entry.source === "eip6963") {
          announcedProvidersRef.current.delete(existingForProvider.key)
          announcedProvidersRef.current.set(entry.key, entry)
          publishProviders()
          if (providerRef.current?.provider === provider) activateProvider(entry)
        }
        return
      }

      if (announcedProvidersRef.current.has(entry.key)) return
      if (
        announcedProvidersRef.current.size >= MAX_ANNOUNCED_PROVIDERS &&
        !matchesPreferredProvider(entry, preferredProviderRef.current)
      )
        return
      announcedProvidersRef.current.set(entry.key, entry)
      publishProviders()

      if (matchesPreferredProvider(entry, preferredProviderRef.current)) {
        activateProvider(entry)
      } else if (!providerRef.current) {
        activateProvider(entry)
      }
    }

    const registerLegacyProviders = () => {
      let ethereum
      try {
        ethereum = window.ethereum
      } catch {
        return
      }
      if (!ethereum) return

      const providers =
        Array.isArray(ethereum.providers) && ethereum.providers.length
          ? ethereum.providers
          : [ethereum]

      providers.forEach((provider, index) => {
        registerProvider(
          provider,
          {
            uuid: `${LEGACY_PROVIDER_PREFIX}-${index}`,
            name: getLegacyName(provider, index),
            icon: "",
            rdns: "",
          },
          `${LEGACY_PROVIDER_PREFIX}-${index}`,
          "legacy",
        )
      })
    }

    const onAnnouncement = (event) => {
      const detail = event?.detail
      if (!detail?.provider || !detail?.info) return
      const fallbackKey = `eip6963-${announcedProvidersRef.current.size}`
      registerProvider(detail.provider, detail.info, fallbackKey)
    }

    const onLegacyInitialized = () => registerLegacyProviders()

    window.addEventListener("eip6963:announceProvider", onAnnouncement)
    window.addEventListener("ethereum#initialized", onLegacyInitialized, { once: true })

    try {
      window.dispatchEvent(new Event("eip6963:requestProvider"))
    } catch {
      // Older browsers still receive the legacy provider fallback below.
    }
    registerLegacyProviders()

    if (!providerRef.current) {
      pollTimer = window.setInterval(() => {
        registerLegacyProviders()
        if (providerRef.current && pollTimer !== null) {
          window.clearInterval(pollTimer)
          pollTimer = null
        }
      }, DISCOVERY_POLL_INTERVAL_MS)
    }

    queueMicrotask(() => {
      if (active && !providerRef.current) setStatus("disconnected")
    })

    return () => {
      active = false
      if (selectProviderImplRef.current) selectProviderImplRef.current = null
      if (pollTimer !== null) window.clearInterval(pollTimer)
      window.removeEventListener("eip6963:announceProvider", onAnnouncement)
      window.removeEventListener("ethereum#initialized", onLegacyInitialized)
    }
  }, [invalidateOperations, updateAccount, updateChainId, updateProviderConnection])

  const synchronizeProvider = useCallback(
    async (entry, transportRecovery = false, forceAccountRefresh = false) => {
      if (!entry?.provider?.request || providerRef.current?.provider !== entry.provider) return

      const provider = entry.provider
      const epoch = invalidateOperations()
      const hadConnectionIntent = connectionIntentRef.current
      const shouldReadAccount = hadConnectionIntent || forceAccountRefresh
      const accountRevision = shouldReadAccount
        ? ++accountRevisionRef.current
        : accountRevisionRef.current
      const chainRevision = ++chainRevisionRef.current
      const transportRevision = transportRevisionRef.current

      if (mountedRef.current && shouldReadAccount && !accountRef.current) {
        setStatus(transportRecovery ? "reconnecting" : "checking")
      }

      const chainWork = readChain(provider)
        .then((nextChainId) => {
          if (
            providerRef.current?.provider === provider &&
            chainRevisionRef.current === chainRevision
          ) {
            if (transportRevisionRef.current === transportRevision) updateProviderConnection(true)
            updateChainId(nextChainId)
          }
        })
        .catch(() => {
          // Account restoration is intentionally independent from chain detection.
        })

      const accountWork = shouldReadAccount
        ? Promise.resolve()
            .then(() => provider.request({ method: "eth_accounts" }))
            .then((accounts) => {
              if (
                providerRef.current?.provider !== provider ||
                accountRevisionRef.current !== accountRevision
              )
                return

              if (transportRevisionRef.current === transportRevision) updateProviderConnection(true)
              const nextAccount = firstAccount(accounts)
              updateAccount(nextAccount)
              if (nextAccount) {
                connectionIntentRef.current = true
                writeStorage(CONNECTION_KEY, "true")
                setStatus(providerConnectedRef.current ? "connected" : "reconnecting")
                rememberProvider(entry)
              } else {
                connectionIntentRef.current = false
                removeStorage(CONNECTION_KEY)
                setStatus("disconnected")
              }
            })
            .catch(() => {
              if (
                mountedRef.current &&
                providerRef.current?.provider === provider &&
                accountRevisionRef.current === accountRevision &&
                !accountRef.current
              ) {
                setStatus(hadConnectionIntent ? "reconnecting" : "disconnected")
              }
            })
        : Promise.resolve().then(() => {
            if (
              mountedRef.current &&
              providerRef.current?.provider === provider &&
              operationEpochRef.current === epoch &&
              !connectionIntentRef.current &&
              !connectRequestedRef.current
            )
              setStatus("disconnected")
          })

      await Promise.allSettled([chainWork, accountWork])
    },
    [invalidateOperations, updateAccount, updateChainId, updateProviderConnection],
  )

  useEffect(() => {
    const provider = providerEntry?.provider
    if (!provider?.request) return undefined

    let active = true

    const onAccountsChanged = (accounts) => {
      if (!active || providerRef.current?.provider !== provider) return
      invalidateOperations()
      accountRevisionRef.current += 1

      const nextAccount = firstAccount(accounts)
      if (!nextAccount) {
        connectionIntentRef.current = false
        connectRequestedRef.current = false
        removeStorage(CONNECTION_KEY)
        updateAccount("")
        setStatus("disconnected")
        return
      }

      if (!connectionIntentRef.current && !connectRequestedRef.current) return
      if (connectRequestedRef.current) {
        connectionIntentRef.current = true
        writeStorage(CONNECTION_KEY, "true")
        rememberProvider(providerEntry)
      }
      updateAccount(nextAccount)
      setStatus(providerConnectedRef.current ? "connected" : "reconnecting")
    }

    const onChainChanged = (nextChainId) => {
      if (!active || providerRef.current?.provider !== provider) return
      const normalized = normalizeChainId(nextChainId)
      if (normalized === null) return
      invalidateOperations()
      chainRevisionRef.current += 1
      updateChainId(normalized)
    }

    const onDisconnect = () => {
      if (!active || providerRef.current?.provider !== provider) return
      invalidateOperations()
      chainRevisionRef.current += 1
      transportRevisionRef.current += 1
      updateChainId(null)
      updateProviderConnection(false)
      setStatus(accountRef.current && connectionIntentRef.current ? "reconnecting" : "disconnected")
    }

    const onConnect = (connectInfo) => {
      if (!active || providerRef.current?.provider !== provider) return
      transportRevisionRef.current += 1
      updateProviderConnection(true)
      const connectedChainId = normalizeChainId(connectInfo?.chainId)
      if (connectedChainId !== null) {
        invalidateOperations()
        chainRevisionRef.current += 1
        updateChainId(connectedChainId)
      }
      void synchronizeProvider(providerEntry, true)
    }

    provider.on?.("accountsChanged", onAccountsChanged)
    provider.on?.("chainChanged", onChainChanged)
    provider.on?.("disconnect", onDisconnect)
    provider.on?.("connect", onConnect)
    const forceAccountRefresh = forceAccountRefreshRef.current === provider
    if (forceAccountRefresh) forceAccountRefreshRef.current = null
    void synchronizeProvider(providerEntry, false, forceAccountRefresh)

    return () => {
      active = false
      provider.removeListener?.("accountsChanged", onAccountsChanged)
      provider.removeListener?.("chainChanged", onChainChanged)
      provider.removeListener?.("disconnect", onDisconnect)
      provider.removeListener?.("connect", onConnect)
    }
  }, [
    invalidateOperations,
    providerEntry,
    providerRefreshRevision,
    synchronizeProvider,
    updateAccount,
    updateChainId,
    updateProviderConnection,
  ])

  const connect = useCallback(
    (providerId) => {
      let selectedForConnection = false
      if (providerId !== undefined) {
        if (typeof providerId !== "string" || !providerId) {
          const message = "Choose an available wallet."
          if (mountedRef.current) setError(message)
          return Promise.resolve({ ok: false, error: message })
        }

        const select = selectProviderImplRef.current
        if (!select) {
          const message = "Wallet discovery is not available in this browser."
          if (mountedRef.current) setError(message)
          return Promise.resolve({ ok: false, error: message })
        }

        const selection = select(providerId, { refreshAccount: false })
        if (!selection.ok) return Promise.resolve(selection)
        selectedForConnection = true
      }

      const entry = providerRef.current
      const provider = entry?.provider

      if (!provider?.request) {
        const message =
          "No browser wallet was found. Install or enable an EVM wallet and try again."
        if (mountedRef.current) {
          setStatus("disconnected")
          setError(message)
        }
        return Promise.resolve({ ok: false, error: message })
      }

      if (selectedForConnection || forceAccountRefreshRef.current === provider) {
        forceAccountRefreshRef.current = null
        connectionIntentRef.current = false
        removeStorage(CONNECTION_KEY)
      }

      if (connectPromiseRef.current?.provider === provider) {
        return connectPromiseRef.current.promise
      }

      setError(null)
      setStatus("connecting")
      connectRequestedRef.current = true
      invalidateOperations()
      const accountRevision = ++accountRevisionRef.current
      const chainRevision = ++chainRevisionRef.current
      const transportRevision = transportRevisionRef.current

      const task = (async () => {
        try {
          const accounts = await provider.request({ method: "eth_requestAccounts" })
          if (providerRef.current?.provider !== provider) {
            return { ok: false, error: "The selected wallet changed during connection." }
          }

          const returnedAccount = firstAccount(accounts)
          if (!returnedAccount) throw new Error("No wallet account returned")

          let connectedAccount
          if (accountRevisionRef.current === accountRevision) {
            connectedAccount = returnedAccount
            updateAccount(connectedAccount)
          } else {
            connectedAccount = accountRef.current
          }

          if (!connectedAccount) {
            return { ok: false, error: "The wallet connection was interrupted." }
          }

          connectionIntentRef.current = true
          if (transportRevisionRef.current === transportRevision) updateProviderConnection(true)
          writeStorage(CONNECTION_KEY, "true")
          rememberProvider(entry)
          preferredProviderRef.current = {
            uuid: entry.info.uuid,
            rdns: entry.info.rdns,
          }
          if (mountedRef.current) {
            setStatus(providerConnectedRef.current ? "connected" : "reconnecting")
          }

          let connectedChainId = chainIdRef.current
          try {
            const detectedChainId = await readChain(provider)
            if (
              providerRef.current?.provider === provider &&
              chainRevisionRef.current === chainRevision
            ) {
              updateChainId(detectedChainId)
              connectedChainId = detectedChainId
            } else {
              connectedChainId = chainIdRef.current
            }
          } catch {
            // A chain lookup failure does not invalidate an accepted account connection.
          }

          return { ok: true, account: connectedAccount, chainId: connectedChainId }
        } catch (caught) {
          if (
            providerRef.current?.provider !== provider ||
            accountRevisionRef.current !== accountRevision
          ) {
            if (accountRef.current && connectionIntentRef.current) {
              return { ok: true, account: accountRef.current, chainId: chainIdRef.current }
            }
            return { ok: false, error: "The wallet connection was interrupted." }
          }

          const message = walletError(
            caught,
            "The wallet could not be connected. Try again from your wallet extension.",
          )
          if (mountedRef.current) {
            setStatus("disconnected")
            setError(message)
          }
          return { ok: false, error: message }
        }
      })()

      let promise
      promise = task.finally(() => {
        if (connectPromiseRef.current?.promise === promise) {
          connectPromiseRef.current = null
          connectRequestedRef.current = false
        }
      })

      connectPromiseRef.current = { provider, promise }
      return promise
    },
    [invalidateOperations, updateAccount, updateChainId, updateProviderConnection],
  )

  const switchToBnbChain = useCallback(() => {
    const provider = providerRef.current?.provider
    if (!provider?.request) {
      const message = "No browser wallet was found. Install or enable an EVM wallet and try again."
      if (mountedRef.current) setError(message)
      return Promise.resolve({ ok: false, error: message })
    }

    if (switchPromiseRef.current?.provider === provider) {
      return switchPromiseRef.current.promise
    }

    setError(null)
    setIsSwitching(true)
    const epoch = invalidateOperations()
    const chainRevision = ++chainRevisionRef.current
    const transportRevision = transportRevisionRef.current

    const task = (async () => {
      let phase = "switch"
      try {
        try {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: wovenContracts.chainIdHex }],
          })
        } catch (caught) {
          if (findErrorCode(caught) !== 4902) throw caught
          phase = "add"
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [bnbWalletParams],
          })
          phase = "switch"
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: wovenContracts.chainIdHex }],
          })
        }

        const verifiedChainId = await readChain(provider)
        if (verifiedChainId !== wovenContracts.chainId) {
          throw new Error(`The wallet did not switch to ${wovenContracts.networkName}.`)
        }
        if (providerRef.current?.provider !== provider) {
          return { ok: false, error: "The selected wallet changed during the network switch." }
        }
        if (transportRevisionRef.current === transportRevision) updateProviderConnection(true)

        if (
          providerRef.current?.provider === provider &&
          chainRevisionRef.current === chainRevision
        )
          updateChainId(verifiedChainId)

        return { ok: true, chainId: verifiedChainId }
      } catch (caught) {
        const message = walletError(
          caught,
          phase === "add" || findErrorCode(caught) === 4902
            ? `${wovenContracts.networkName} could not be added to this wallet.`
            : `The wallet could not switch to ${wovenContracts.networkName}.`,
        )
        if (
          mountedRef.current &&
          providerRef.current?.provider === provider &&
          operationEpochRef.current === epoch
        )
          setError(message)
        return { ok: false, error: message }
      }
    })()

    let promise
    promise = task.finally(() => {
      if (switchPromiseRef.current?.promise === promise) {
        switchPromiseRef.current = null
        if (mountedRef.current) setIsSwitching(false)
      }
    })

    switchPromiseRef.current = { provider, promise }
    return promise
  }, [invalidateOperations, updateChainId, updateProviderConnection])

  const disconnect = useCallback(() => {
    const provider = providerRef.current?.provider
    invalidateOperations()
    accountRevisionRef.current += 1
    chainRevisionRef.current += 1
    connectionIntentRef.current = false
    connectRequestedRef.current = false
    removeStorage(CONNECTION_KEY)
    updateAccount("")
    updateChainId(null)
    setStatus("disconnected")
    setIsSwitching(false)
    setError(null)

    if (provider?.request) {
      void Promise.resolve()
        .then(() =>
          provider.request({
            method: "wallet_revokePermissions",
            params: [{ eth_accounts: {} }],
          }),
        )
        .catch(() => {
          // Permission revocation is optional and local disconnect is already complete.
        })
    }

    return { ok: true }
  }, [invalidateOperations, updateAccount, updateChainId])

  const selectProvider = useCallback((id) => {
    if (typeof id !== "string" || !id) {
      const message = "Choose an available wallet."
      if (mountedRef.current) setError(message)
      return { ok: false, error: message }
    }

    const select = selectProviderImplRef.current
    if (!select) {
      const message = "Wallet discovery is not available in this browser."
      if (mountedRef.current) setError(message)
      return { ok: false, error: message }
    }

    return select(id)
  }, [])

  const refreshNetwork = useCallback(async () => {
    const entry = providerRef.current
    if (!entry?.provider?.request) {
      const message = "No browser wallet was found. Install or enable an EVM wallet and try again."
      if (mountedRef.current) setError(message)
      return { ok: false, error: message }
    }

    setError(null)
    await synchronizeProvider(entry, true, Boolean(accountRef.current))
    if (chainIdRef.current === null) {
      const message = "The wallet network is still unavailable. Open the wallet and try again."
      if (mountedRef.current) setError(message)
      return { ok: false, error: message }
    }
    return { ok: true, chainId: chainIdRef.current }
  }, [synchronizeProvider])

  const captureContext = useCallback(
    () =>
      Object.freeze({
        revision: operationEpochRef.current,
        provider: providerRef.current?.provider ?? null,
        account: accountRef.current,
        chainId: chainIdRef.current,
      }),
    [],
  )

  const isContextCurrent = useCallback((snapshot) => {
    if (!snapshot || typeof snapshot !== "object") return false
    return (
      connectionIntentRef.current &&
      snapshot.revision === operationEpochRef.current &&
      snapshot.provider === (providerRef.current?.provider ?? null) &&
      snapshot.account === accountRef.current &&
      snapshot.chainId === chainIdRef.current &&
      Boolean(accountRef.current)
    )
  }, [])

  const clearError = useCallback(() => setError(null), [])
  const isBnbChain = chainId === wovenContracts.chainId
  const providers = useMemo(
    () =>
      providerEntries.map((entry) => ({
        id: entry.key,
        name: entry.info.name,
        icon: entry.info.icon,
        rdns: entry.info.rdns,
        source: entry.source,
      })),
    [providerEntries],
  )

  return useMemo(
    () => ({
      account,
      chainId,
      status,
      error,
      isSwitching,
      isBnbChain,
      hasProvider: Boolean(providerEntry),
      isProviderConnected,
      providers,
      selectedProviderId: providerEntry?.key ?? null,
      providerInfo: providerEntry?.info ?? null,
      provider: providerEntry?.provider ?? null,
      captureContext,
      isContextCurrent,
      selectProvider,
      connect,
      disconnect,
      refreshNetwork,
      switchToBnbChain,
      clearError,
    }),
    [
      account,
      captureContext,
      chainId,
      clearError,
      connect,
      disconnect,
      error,
      isBnbChain,
      isProviderConnected,
      isContextCurrent,
      isSwitching,
      providerEntry,
      providers,
      refreshNetwork,
      selectProvider,
      status,
      switchToBnbChain,
    ],
  )
}
