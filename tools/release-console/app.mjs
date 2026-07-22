import {
  buildWalletTransaction,
  createReceiptRecord,
  createSubmittedRecord,
  exportReceiptBundle,
  isTransactionExpired,
  normalizeAddress,
  normalizeAndVerifyManifest,
  normalizeTransactionHash,
} from "./core.mjs"

const RECEIPT_TIMEOUT_MS = 10 * 60 * 1_000
const POLL_INTERVAL_MS = 2_000
const REQUIRED_CONFIRMATIONS = 2
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024

const elements = {
  originStatus: document.querySelector("#origin-status"),
  walletStatus: document.querySelector("#wallet-status"),
  accountStatus: document.querySelector("#account-status"),
  chainStatus: document.querySelector("#chain-status"),
  sessionMessage: document.querySelector("#session-message"),
  connectWallet: document.querySelector("#connect-wallet"),
  switchChain: document.querySelector("#switch-chain"),
  manifestFile: document.querySelector("#manifest-file"),
  manifestSummary: document.querySelector("#manifest-summary"),
  manifestMessage: document.querySelector("#manifest-message"),
  transactionList: document.querySelector("#transaction-list"),
  exportReceipts: document.querySelector("#export-receipts"),
  reviewDialog: document.querySelector("#review-dialog"),
  reviewFields: document.querySelector("#review-fields"),
  reviewConfirmation: document.querySelector("#review-confirmation"),
  reviewMessage: document.querySelector("#review-message"),
  sendTransaction: document.querySelector("#send-transaction"),
  closeReview: document.querySelector("#close-review"),
  cancelReview: document.querySelector("#cancel-review"),
}

const announcedProviders = new Map()
const observedProviders = new WeakSet()
const receiptRecords = new Map()
let provider = null
let account = null
let walletChainId = null
let manifest = null
let selectedTransaction = null
let requestInProgress = false

function isLocalOrigin() {
  const localHost = location.hostname === "127.0.0.1" || location.hostname === "localhost"
  return (
    window.isSecureContext &&
    location.protocol === "http:" &&
    localHost &&
    /^[0-9]{4,5}$/.test(location.port)
  )
}

function setMessage(element, message, tone = "neutral") {
  element.textContent = message
  element.dataset.tone = tone
}

function shortAddress(value) {
  return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "Not connected"
}

function parseChainId(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error("Wallet returned an invalid chain ID.")
  }
  const parsed = Number(BigInt(value))
  if (!Number.isSafeInteger(parsed)) throw new Error("Wallet chain ID exceeds the safe range.")
  return parsed
}

function appendDefinition(list, term, description, mono = false) {
  const dt = document.createElement("dt")
  dt.textContent = term
  const dd = document.createElement("dd")
  dd.textContent = description
  if (mono) dd.className = "mono"
  list.append(dt, dd)
}

function createStatusPill(status) {
  const pill = document.createElement("span")
  pill.className = "status-pill"
  pill.dataset.status = status
  pill.textContent = status
  return pill
}

function findMetaMaskProvider() {
  const exactProviders = [...announcedProviders.values()].filter(
    ({ info, provider: candidate }) => info.rdns === "io.metamask" && candidate?.request,
  )
  if (exactProviders.length > 1) {
    throw new Error(
      "Multiple MetaMask providers were announced; disable duplicates before signing.",
    )
  }
  if (exactProviders.length === 1) return exactProviders[0].provider

  const legacyProviders = Array.isArray(window.ethereum?.providers)
    ? window.ethereum.providers.filter((candidate) => candidate?.isMetaMask && candidate?.request)
    : window.ethereum?.isMetaMask && window.ethereum?.request
      ? [window.ethereum]
      : []
  const uniqueLegacyProviders = [...new Set(legacyProviders)]
  if (uniqueLegacyProviders.length > 1) {
    throw new Error(
      "Multiple legacy MetaMask providers were detected; disable duplicates before signing.",
    )
  }
  return uniqueLegacyProviders[0] ?? null
}

function observeProvider(candidate) {
  if (observedProviders.has(candidate) || typeof candidate?.on !== "function") return
  observedProviders.add(candidate)
  candidate.on("accountsChanged", (accounts) => {
    account = Array.isArray(accounts) && accounts[0] ? normalizeAddress(accounts[0]) : null
    invalidateReview("Wallet account changed. Review the transaction again.")
    render()
  })
  candidate.on("chainChanged", (chainId) => {
    try {
      walletChainId = parseChainId(chainId)
    } catch {
      walletChainId = null
    }
    invalidateReview("Wallet network changed. Review the transaction again.")
    render()
  })
  candidate.on("disconnect", () => {
    account = null
    walletChainId = null
    invalidateReview("Wallet disconnected.")
    render()
  })
}

async function refreshWalletState({ requestAccounts = false } = {}) {
  provider = findMetaMaskProvider()
  if (!provider) throw new Error("A unique MetaMask provider was not detected.")
  observeProvider(provider)
  const method = requestAccounts ? "eth_requestAccounts" : "eth_accounts"
  const accounts = await provider.request({ method })
  if (!Array.isArray(accounts)) throw new Error("MetaMask returned an invalid account list.")
  account = accounts[0] ? normalizeAddress(accounts[0]) : null
  walletChainId = parseChainId(await provider.request({ method: "eth_chainId" }))
  return { account, walletChainId }
}

function invalidateReview(message) {
  selectedTransaction = null
  elements.reviewConfirmation.checked = false
  elements.sendTransaction.disabled = true
  if (elements.reviewDialog.open && !requestInProgress) elements.reviewDialog.close()
  if (message) setMessage(elements.sessionMessage, message, "error")
}

function gateFailure(transaction, { allowRequestInProgress = false } = {}) {
  if (!isLocalOrigin()) return "Unsafe origin"
  if (!manifest) return "Load manifest"
  if (!provider) return "Connect MetaMask"
  if (!account) return "Connect account"
  if (walletChainId !== manifest.network.chainId) return "Wrong network"
  if (account !== transaction.from) return "Wrong account"
  if (isTransactionExpired(transaction)) return "Expired"
  if (requestInProgress && !allowRequestInProgress) return "Request in progress"
  if (receiptRecords.has(transaction.id)) return "Already submitted"
  return null
}

function renderSession() {
  const originSafe = isLocalOrigin()
  elements.originStatus.textContent = originSafe ? location.origin : "Blocked"
  elements.walletStatus.textContent = provider ? "MetaMask detected" : "Not connected"
  elements.accountStatus.textContent = shortAddress(account)
  elements.accountStatus.title = account ?? ""
  elements.chainStatus.textContent = walletChainId ? `Chain ${walletChainId}` : "Not connected"
  elements.connectWallet.disabled = !originSafe || requestInProgress
  elements.connectWallet.textContent = account ? "Reconnect MetaMask" : "Connect MetaMask"
  elements.switchChain.hidden = !(
    manifest &&
    provider &&
    walletChainId !== null &&
    walletChainId !== manifest.network.chainId
  )
  elements.switchChain.disabled = requestInProgress
  if (!originSafe) {
    setMessage(
      elements.sessionMessage,
      "Blocked: use the bundled server on http://127.0.0.1 or http://localhost.",
      "error",
    )
  }
}

function renderManifest() {
  elements.manifestSummary.replaceChildren()
  elements.manifestSummary.hidden = !manifest
  elements.manifestFile.disabled = requestInProgress || receiptRecords.size > 0
  if (!manifest) return

  const entries = [
    ["Release", manifest.releaseId],
    ["Attempt", manifest.attemptId],
    ["Network", `${manifest.network.name} · ${manifest.network.chainId}`],
    ["Transactions", String(manifest.transactions.length)],
    ["Manifest hash", manifest.manifestSha256],
    ["Launch record hash", manifest.source.launchRecordSha256],
    ["Prepared plan hash", manifest.source.preparedPlanSha256],
    ["Generated", manifest.generatedAtUtc],
  ]
  for (const [term, value] of entries) {
    const item = document.createElement("div")
    const list = document.createElement("dl")
    appendDefinition(list, term, value, term.includes("hash"))
    item.append(list)
    elements.manifestSummary.append(item)
  }
}

function renderTransaction(transaction) {
  const record = receiptRecords.get(transaction.id)
  const card = document.createElement("article")
  card.className = "transaction-card"

  const heading = document.createElement("div")
  heading.className = "transaction-heading"
  const title = document.createElement("h3")
  title.textContent = transaction.id
  heading.append(title, createStatusPill(record?.status ?? "unsigned"))

  const description = document.createElement("p")
  description.className = "transaction-description"
  description.textContent = transaction.description

  const fields = document.createElement("dl")
  fields.className = "transaction-fields"
  appendDefinition(fields, "Chain ID", String(manifest.network.chainId))
  appendDefinition(fields, "From", transaction.from, true)
  appendDefinition(fields, "To", transaction.to ?? "Contract creation", true)
  appendDefinition(fields, "Value (wei)", transaction.valueWei, true)
  appendDefinition(fields, "Intent hash", transaction.intentSha256, true)
  appendDefinition(fields, "Signing surface", transaction.signingSurface)
  appendDefinition(fields, "Expires", transaction.expiresAtUtc ?? "No manifest expiry")

  const details = document.createElement("details")
  const summary = document.createElement("summary")
  summary.textContent = `Calldata · ${(transaction.data.length - 2) / 2} bytes`
  const data = document.createElement("pre")
  data.className = "calldata"
  data.textContent = transaction.data
  details.append(summary, data)

  const actions = document.createElement("div")
  actions.className = "transaction-actions"
  if (record) {
    const link = document.createElement("a")
    link.className = "receipt-link"
    link.href = record.explorerUrl
    link.target = "_blank"
    link.rel = "noopener noreferrer"
    link.textContent = shortAddress(record.transactionHash)
    actions.append(link)
    if (record.status === "submitted") {
      const checkButton = document.createElement("button")
      checkButton.type = "button"
      checkButton.className = "secondary"
      checkButton.textContent = "Check receipt"
      checkButton.disabled = requestInProgress || walletChainId !== manifest.network.chainId
      checkButton.addEventListener("click", () => checkSubmittedReceipt(transaction))
      actions.append(checkButton)
    }
  } else {
    const sendButton = document.createElement("button")
    sendButton.type = "button"
    const failure = gateFailure(transaction)
    sendButton.disabled = Boolean(failure)
    sendButton.textContent = failure ?? "Review transaction"
    sendButton.addEventListener("click", () => openReview(transaction))
    actions.append(sendButton)
  }

  card.append(heading, description, fields, details, actions)
  return card
}

function renderTransactions() {
  elements.transactionList.replaceChildren()
  if (!manifest) {
    const empty = document.createElement("div")
    empty.className = "empty-state"
    empty.textContent = "A verified manifest will appear here."
    elements.transactionList.append(empty)
    return
  }
  for (const transaction of manifest.transactions) {
    elements.transactionList.append(renderTransaction(transaction))
  }
}

function render() {
  renderSession()
  renderManifest()
  renderTransactions()
  elements.exportReceipts.disabled = receiptRecords.size === 0 || requestInProgress
}

async function connectWallet() {
  if (!isLocalOrigin()) return
  requestInProgress = true
  render()
  try {
    await refreshWalletState({ requestAccounts: true })
    setMessage(
      elements.sessionMessage,
      "MetaMask connected. Transaction gates are rechecked per row.",
      "success",
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setMessage(elements.sessionMessage, message, "error")
  } finally {
    requestInProgress = false
    render()
  }
}

async function switchNetwork() {
  if (!manifest || !provider || requestInProgress) return
  requestInProgress = true
  render()
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${manifest.network.chainId.toString(16)}` }],
    })
    await refreshWalletState()
    setMessage(
      elements.sessionMessage,
      `MetaMask is on chain ${manifest.network.chainId}.`,
      "success",
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setMessage(
      elements.sessionMessage,
      `Network switch was not completed: ${message}. Add the reviewed BNB network in MetaMask first if needed.`,
      "error",
    )
  } finally {
    requestInProgress = false
    render()
  }
}

async function loadManifest(file) {
  if (!file || requestInProgress || receiptRecords.size > 0) return
  setMessage(elements.manifestMessage, "Verifying manifest hashes…")
  try {
    if (file.size > MAX_MANIFEST_BYTES) throw new Error("Manifest exceeds the 5 MiB file limit.")
    const text = await file.text()
    const parsed = JSON.parse(text)
    manifest = await normalizeAndVerifyManifest(parsed)
    setMessage(
      elements.manifestMessage,
      `${manifest.transactions.length} transaction${manifest.transactions.length === 1 ? "" : "s"} verified. No transaction was sent.`,
      "success",
    )
  } catch (error) {
    manifest = null
    const message = error instanceof Error ? error.message : String(error)
    setMessage(elements.manifestMessage, `Manifest rejected: ${message}`, "error")
  } finally {
    elements.manifestFile.value = ""
    render()
  }
}

function openReview(transaction) {
  const failure = gateFailure(transaction)
  if (failure) {
    setMessage(elements.sessionMessage, `Transaction remains blocked: ${failure}.`, "error")
    return
  }
  selectedTransaction = transaction
  elements.reviewFields.replaceChildren()
  appendDefinition(elements.reviewFields, "Description", transaction.description)
  appendDefinition(elements.reviewFields, "Chain ID", String(manifest.network.chainId))
  appendDefinition(elements.reviewFields, "From", transaction.from, true)
  appendDefinition(elements.reviewFields, "To", transaction.to ?? "Contract creation", true)
  appendDefinition(elements.reviewFields, "Value (wei)", transaction.valueWei, true)
  appendDefinition(elements.reviewFields, "Calldata", transaction.data, true)
  appendDefinition(elements.reviewFields, "Intent hash", transaction.intentSha256, true)
  appendDefinition(elements.reviewFields, "Manifest hash", manifest.manifestSha256, true)
  appendDefinition(
    elements.reviewFields,
    "Expires",
    transaction.expiresAtUtc ?? "No manifest expiry",
  )
  elements.reviewConfirmation.checked = false
  elements.sendTransaction.disabled = true
  setMessage(elements.reviewMessage, "No wallet request has been made.")
  elements.reviewDialog.showModal()
}

async function ensureCurrentSigningGates(transaction) {
  await refreshWalletState()
  const failure = gateFailure(transaction, { allowRequestInProgress: true })
  if (failure) throw new Error(`Signing gate failed: ${failure}.`)
}

function replaceRecord(record) {
  receiptRecords.set(record.id, Object.freeze(record))
  render()
}

const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds))

async function waitForReceipt(transaction, transactionHash) {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS
  let receipt = null
  let confirmationsObserved = 0

  while (Date.now() < deadline) {
    const activeChainId = parseChainId(await provider.request({ method: "eth_chainId" }))
    if (activeChainId !== manifest.network.chainId) {
      throw new Error(
        `Switch MetaMask back to chain ${manifest.network.chainId} to continue receipt checks.`,
      )
    }
    receipt = await provider.request({
      method: "eth_getTransactionReceipt",
      params: [transactionHash],
    })
    if (receipt) {
      const receiptBlock = BigInt(receipt.blockNumber)
      const latestBlock = BigInt(await provider.request({ method: "eth_blockNumber" }))
      confirmationsObserved = Number(latestBlock - receiptBlock + 1n)
      if (confirmationsObserved >= REQUIRED_CONFIRMATIONS) {
        const rechecked = await provider.request({
          method: "eth_getTransactionReceipt",
          params: [transactionHash],
        })
        if (rechecked?.blockHash === receipt.blockHash && rechecked?.status === receipt.status) {
          receipt = rechecked
          break
        }
        receipt = null
      }
    }
    await wait(POLL_INTERVAL_MS)
  }
  if (!receipt)
    throw new Error(
      "Receipt was not confirmed within ten minutes. Check it again; do not resubmit.",
    )

  const observedTransaction = await provider.request({
    method: "eth_getTransactionByHash",
    params: [transactionHash],
  })
  if (!observedTransaction) throw new Error("Confirmed transaction details could not be read back.")

  return createReceiptRecord({
    manifest,
    transaction,
    transactionHash,
    submittedAtUtc: receiptRecords.get(transaction.id).submittedAtUtc,
    confirmedAtUtc: new Date().toISOString(),
    observedTransaction,
    receipt,
    confirmationsObserved,
  })
}

async function submitSelectedTransaction() {
  const transaction = selectedTransaction
  if (!transaction || !elements.reviewConfirmation.checked || requestInProgress) return
  requestInProgress = true
  elements.closeReview.disabled = true
  elements.cancelReview.disabled = true
  elements.reviewConfirmation.disabled = true
  elements.sendTransaction.disabled = true
  setMessage(elements.reviewMessage, "Rechecking account, chain and expiry…")
  render()

  let submitted = false
  try {
    await ensureCurrentSigningGates(transaction)
    setMessage(elements.reviewMessage, "Waiting for the explicit MetaMask transaction approval…")
    const transactionHash = normalizeTransactionHash(
      await provider.request({
        method: "eth_sendTransaction",
        params: [buildWalletTransaction(transaction)],
      }),
    )
    submitted = true
    replaceRecord(
      createSubmittedRecord({
        manifest,
        transaction,
        transactionHash,
        submittedAtUtc: new Date().toISOString(),
      }),
    )
    setMessage(
      elements.reviewMessage,
      `Submitted ${shortAddress(transactionHash)}. Waiting for ${REQUIRED_CONFIRMATIONS} confirmations. Do not resubmit.`,
    )
    const record = await waitForReceipt(transaction, transactionHash)
    replaceRecord(record)
    const tone = record.status === "confirmed" ? "success" : "error"
    setMessage(elements.reviewMessage, `Receipt status: ${record.status}.`, tone)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setMessage(elements.reviewMessage, message, "error")
  } finally {
    requestInProgress = false
    elements.closeReview.disabled = false
    elements.cancelReview.disabled = false
    elements.reviewConfirmation.disabled = submitted
    elements.sendTransaction.disabled = true
    render()
  }
}

async function checkSubmittedReceipt(transaction) {
  const existing = receiptRecords.get(transaction.id)
  if (!existing || existing.status !== "submitted" || requestInProgress) return
  requestInProgress = true
  render()
  try {
    await refreshWalletState()
    if (walletChainId !== manifest.network.chainId) {
      throw new Error(
        `Switch MetaMask to chain ${manifest.network.chainId} before checking the receipt.`,
      )
    }
    const record = await waitForReceipt(transaction, existing.transactionHash)
    replaceRecord(record)
    setMessage(
      elements.sessionMessage,
      `Receipt for ${transaction.id}: ${record.status}.`,
      record.status === "confirmed" ? "success" : "error",
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setMessage(elements.sessionMessage, message, "error")
  } finally {
    requestInProgress = false
    render()
  }
}

function exportReceipts() {
  if (!manifest || receiptRecords.size === 0 || requestInProgress) return
  const records = manifest.transactions
    .map((transaction) => receiptRecords.get(transaction.id))
    .filter(Boolean)
  const bundle = exportReceiptBundle(manifest, records)
  const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `${manifest.releaseId}-${manifest.attemptId}-receipts.json`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

window.addEventListener("eip6963:announceProvider", (event) => {
  const detail = event.detail
  if (!detail?.info?.uuid || !detail?.provider) return
  announcedProviders.set(detail.info.uuid, detail)
  try {
    const candidate = findMetaMaskProvider()
    if (candidate) {
      provider = candidate
      observeProvider(provider)
    }
  } catch (error) {
    provider = null
    setMessage(
      elements.sessionMessage,
      error instanceof Error ? error.message : String(error),
      "error",
    )
  }
  render()
})
window.dispatchEvent(new Event("eip6963:requestProvider"))

elements.connectWallet.addEventListener("click", connectWallet)
elements.switchChain.addEventListener("click", switchNetwork)
elements.manifestFile.addEventListener("change", (event) => loadManifest(event.target.files?.[0]))
elements.exportReceipts.addEventListener("click", exportReceipts)
elements.reviewConfirmation.addEventListener("change", () => {
  elements.sendTransaction.disabled = !elements.reviewConfirmation.checked || requestInProgress
})
elements.sendTransaction.addEventListener("click", submitSelectedTransaction)
elements.reviewDialog.addEventListener("close", () => {
  if (!requestInProgress) selectedTransaction = null
})
elements.reviewDialog.addEventListener("cancel", (event) => {
  if (requestInProgress) event.preventDefault()
})

try {
  provider = findMetaMaskProvider()
  if (provider) observeProvider(provider)
} catch (error) {
  setMessage(
    elements.sessionMessage,
    error instanceof Error ? error.message : String(error),
    "error",
  )
}
render()
