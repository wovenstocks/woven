import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ExternalLink, LoaderCircle } from "lucide-react"
import { Modal } from "../components/Modal"
import {
  contractAddressesConfigured,
  oneClickContractsConfigured,
  wovenContracts,
} from "../config/contracts"
import { WOVEN_TOKENOMICS } from "../config/tokenomics"
import {
  baskets,
  createDynamicBasketView,
  getConfiguredBasketRecipe,
  getMintQuote,
  isTradeReviewCurrent,
} from "../data/baskets"
import { BasketDetail } from "../features/baskets/BasketDetail"
import { BasketIndex } from "../features/baskets/BasketIndex"
import { Portfolio } from "../features/portfolio/Portfolio"
import { BasketRouteStatus, NotFound } from "../features/RouteStates"
import {
  addressKey,
  compactAddress,
  latestTransactionHash,
  stockBySymbol,
} from "../features/shared"
import { CreatorStudio } from "../features/studio/CreatorStudio"
import { AppHeader } from "../features/wallet/AppHeader"
import { useInjectedWallet } from "../hooks/useInjectedWallet"
import { getBrowserLockManager, runWithExclusiveWriteLock } from "../protocol/browser-write-lock"
import { createPendingTransactionLifecycle } from "../protocol/pending-lifecycle"
import {
  activateCreatorLicense,
  createBasket,
  createBasketBuyQuote,
  createBnbPublicClient as createDefaultBnbPublicClient,
  createInjectedWalletClient,
  distributeBasketFees,
  formatProtocolError,
  formatTokenAmount,
  getBasketBuyReadiness,
  getBasketMintReadiness,
  getBasketRedemptionReadiness,
  isUsableAddress,
  mintBasket,
  mintBasketWithUsdc,
  createPendingTransactionGuard,
  readFactoryBasket,
  redeemBasket,
  verifyBasketRecipe,
} from "../protocol"

export { BasketComposition } from "../features/baskets/BasketComposition"
export { BasketFeeDistribution } from "../features/baskets/BasketFeeDistribution"
export { TradeReview } from "../features/baskets/TradeReview"
export { UsdcBuyReview } from "../features/baskets/UsdcBuyReview"

function pendingTransactionNotice(state) {
  const transaction = state?.transaction || null
  if (state?.status === "resolved") {
    if (state.outcome === "cancelled") {
      return {
        title: "Previous transaction cancelled",
        body: "The wallet cancellation reached two confirmations. The original Woven action was not executed, and no new wallet request was sent.",
        txHash: transaction?.hash || null,
      }
    }
    if (state.outcome === "replaced-different") {
      return {
        title: "Previous transaction replaced",
        body: "A different replacement transaction reached two confirmations. The original Woven action was not confirmed. Review the replacement on BscScan before continuing.",
        txHash: transaction?.hash || null,
      }
    }
    return {
      title:
        state.outcome === "success"
          ? "Previous transaction confirmed"
          : "Previous transaction reverted",
      body:
        state.outcome === "success"
          ? "The previously submitted transaction reached two confirmations. No new wallet request was sent; refresh the affected balances before continuing."
          : "The previously submitted transaction reverted. No new wallet request was sent; prepare a fresh onchain review before trying again.",
      txHash: transaction?.hash || null,
    }
  }

  if (state?.status === "pending") {
    return {
      title: "Transaction submitted — confirmation pending",
      body: "Woven cannot verify the final receipt yet. Do not submit this action again. Check the transaction on BscScan and return after it has reached two confirmations.",
      txHash: transaction?.hash || null,
    }
  }

  const submittedButUntracked = Boolean(transaction?.hash)
  return {
    title: submittedButUntracked
      ? "Transaction submitted — tracking unavailable"
      : "Transaction safety check unavailable",
    body: submittedButUntracked
      ? "The wallet submitted this transaction, but Woven cannot safely retain its local status. Do not retry. Check the transaction on BscScan before clearing site storage or using another browser."
      : state?.reason === "storage-corrupt"
        ? "Saved transaction state is damaged. Clear this site's storage only after checking your recent Woven transactions on BscScan. No wallet request was sent."
        : "This browser cannot safely retain pending transaction state. Enable site storage or use a compatible browser before sending an onchain request.",
    txHash: transaction?.hash || null,
  }
}

export function ProductApp({
  initialView,
  basketId,
  onNavigate,
  createPublicClient = createDefaultBnbPublicClient,
  pendingTransactionGuard: pendingGuardOverride = null,
}) {
  const wallet = useInjectedWallet()
  const [pendingGuard] = useState(() => pendingGuardOverride || createPendingTransactionGuard())
  const [actionNotice, setActionNotice] = useState(() => {
    const state = pendingGuard.read()
    return state.status === "empty" ? null : pendingTransactionNotice(state)
  })
  const [busyAction, setBusyAction] = useState(null)
  const [walletPanelRequest, setWalletPanelRequest] = useState(0)
  const [basketActivityRevision, setBasketActivityRevision] = useState(0)
  const publicClientRef = useRef(null)
  const actionLockRef = useRef(false)
  const reviewLockRef = useRef(false)
  const initialPendingCheckRef = useRef(false)
  const pendingReconciliationRef = useRef(null)
  const featuredBasket = useMemo(() => baskets.find((item) => item.id === basketId), [basketId])
  const requestedBasketAddress = useMemo(
    () => (!featuredBasket && isUsableAddress(basketId) ? basketId : null),
    [basketId, featuredBasket],
  )
  const [dynamicBasket, setDynamicBasket] = useState({
    requestKey: "",
    status: "idle",
    basket: null,
    error: "",
  })

  const getPublicClient = useCallback(async () => {
    if (!publicClientRef.current) {
      publicClientRef.current = createPublicClient().catch((error) => {
        publicClientRef.current = null
        throw error
      })
    }
    return publicClientRef.current
  }, [createPublicClient])

  const reconcilePendingTransaction = useCallback(async () => {
    if (pendingReconciliationRef.current) return pendingReconciliationRef.current

    const operation = (async () => {
      const stored = pendingGuard.read()
      if (stored.status === "empty") return { allowAction: true, state: stored }
      if (stored.status === "blocked") {
        setActionNotice(pendingTransactionNotice(stored))
        return { allowAction: false, state: stored }
      }

      let reconciled
      try {
        reconciled = await pendingGuard.reconcile(await getPublicClient())
      } catch {
        reconciled = stored
      }
      setActionNotice(pendingTransactionNotice(reconciled))
      if (reconciled.status === "resolved") {
        setBasketActivityRevision((value) => value + 1)
      }
      return { allowAction: false, state: reconciled }
    })()
    pendingReconciliationRef.current = operation
    try {
      return await operation
    } finally {
      if (pendingReconciliationRef.current === operation) {
        pendingReconciliationRef.current = null
      }
    }
  }, [getPublicClient, pendingGuard])

  useEffect(() => {
    if (initialPendingCheckRef.current) return
    const state = pendingGuard.read()
    if (state.status === "empty") return
    initialPendingCheckRef.current = true
    if (state.status === "pending") {
      void reconcilePendingTransaction()
    }
  }, [pendingGuard, reconcilePendingTransaction])

  const requestWalletConnection = useCallback(async () => {
    if (wallet.account) {
      return { ok: true, account: wallet.account, chainId: wallet.chainId }
    }
    if (wallet.providers.length > 1) {
      setWalletPanelRequest((value) => value + 1)
      return { ok: false, requiresProviderSelection: true }
    }
    return wallet.connect()
  }, [wallet])

  useEffect(() => {
    if (initialView !== "basket" || !requestedBasketAddress) return undefined
    const requestKey = addressKey(requestedBasketAddress)
    if (!contractAddressesConfigured) return undefined

    let active = true
    void getPublicClient()
      .then((publicClient) =>
        readFactoryBasket({ publicClient, basketAddress: requestedBasketAddress }),
      )
      .then((factoryBasket) => createDynamicBasketView(factoryBasket))
      .then((verifiedBasket) => {
        if (active) {
          setDynamicBasket({
            requestKey,
            status: "ready",
            basket: verifiedBasket,
            error: "",
          })
        }
      })
      .catch((error) => {
        if (active) {
          setDynamicBasket({
            requestKey,
            status: "error",
            basket: null,
            error: formatProtocolError(error),
          })
        }
      })

    return () => {
      active = false
    }
  }, [getPublicClient, initialView, requestedBasketAddress])

  const currentDynamicBasket =
    dynamicBasket.requestKey === addressKey(requestedBasketAddress) ? dynamicBasket : null
  const basket = featuredBasket || currentDynamicBasket?.basket || null
  const basketRouteLoading = Boolean(
    requestedBasketAddress &&
    contractAddressesConfigured &&
    (!currentDynamicBasket ||
      currentDynamicBasket.status === "idle" ||
      currentDynamicBasket.status === "loading"),
  )

  useEffect(() => {
    const title =
      initialView === "basket" && basket
        ? `${basket.name} · Woven Stocks`
        : initialView === "portfolio"
          ? "Portfolio · Woven Stocks"
          : initialView === "studio"
            ? "Create a Basket · Woven Stocks"
            : initialView === "app"
              ? "Baskets · Woven Stocks"
              : "Not Found · Woven Stocks"
    document.title = title
    const frame = window.requestAnimationFrame(() => {
      document.querySelector(".route-stage main")?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [basket, basketId, initialView])

  const requestTradeReview = async (action) => {
    if (reviewLockRef.current || actionLockRef.current) return null

    if (!contractAddressesConfigured) {
      setActionNotice({
        title: "Action unavailable",
        body: "Woven is not connected to its verified contracts on this network. No wallet request or transaction was sent.",
      })
      return null
    }
    if (action.type === "buy" && action.basket?.oneClickRoute !== true) {
      setActionNotice({
        title: "USDC purchase unavailable",
        body: "This basket does not have a reviewed route for every constituent. No wallet request or transaction was sent.",
      })
      return null
    }
    if (action.type === "buy" && !oneClickContractsConfigured) {
      setActionNotice({
        title: "USDC purchase unavailable",
        body: "The USDC router and its bStock routes are not configured. No wallet request or transaction was sent.",
      })
      return null
    }

    const expectedBasket = getConfiguredBasketRecipe(action.basket)
    if (!expectedBasket) {
      setActionNotice({
        title: "Basket unavailable",
        body: "The factory basket and every constituent must match the approved bStock catalog before a review can be prepared.",
      })
      return null
    }

    reviewLockRef.current = true
    try {
      let account = wallet.account
      let connectedChain = wallet.chainId
      if (!account) {
        const result = await requestWalletConnection()
        if (!result?.ok) return null
        account = result.account
        connectedChain = result.chainId
      }
      if (connectedChain !== wovenContracts.chainId) {
        const result = await wallet.switchToBnbChain()
        if (!result?.ok) return null
      }

      const publicClient = await getPublicClient()
      await readFactoryBasket({ publicClient, basketAddress: expectedBasket.address })
      await verifyBasketRecipe({
        publicClient,
        basketAddress: expectedBasket.address,
        expectedBasket,
      })

      let readiness
      if (action.type === "buy") {
        const quote = await createBasketBuyQuote({
          publicClient,
          account,
          basketAddress: expectedBasket.address,
          expectedBasket,
          amount: action.amount,
        })
        readiness = await getBasketBuyReadiness({
          publicClient,
          account,
          basketAddress: expectedBasket.address,
          expectedBasket,
          amount: action.amount,
          quote,
        })
      } else if (action.type === "mint") {
        readiness = await getBasketMintReadiness({
          publicClient,
          account,
          basketAddress: expectedBasket.address,
          amount: action.amount,
        })
      } else {
        readiness = await getBasketRedemptionReadiness({
          publicClient,
          account,
          basketAddress: expectedBasket.address,
          amount: action.amount,
          expectedBasket,
        })
      }
      const reviewedAtMs = Date.now()
      const expiresInSeconds =
        action.type === "buy"
          ? Number(
              typeof readiness.expiresIn === "bigint"
                ? readiness.expiresIn
                : readiness.expiresIn || 0,
            )
          : 0
      return Object.freeze({
        ...readiness,
        reviewType: action.type,
        reviewChainId: wovenContracts.chainId,
        reviewProviderId: wallet.selectedProviderId || "",
        requestedAmount: action.amount,
        basketAddress: readiness.basketAddress || readiness.basket || expectedBasket.address,
        ...(action.type === "buy"
          ? {
              reviewPreparedAtMs: reviewedAtMs,
              reviewExpiresAtMs: reviewedAtMs + Math.max(0, expiresInSeconds) * 1_000,
            }
          : {}),
      })
    } catch (error) {
      setActionNotice({
        title:
          action.type === "buy"
            ? "Purchase quote unavailable"
            : action.type === "mint"
              ? "Mint review unavailable"
              : "Redemption review unavailable",
        body: formatProtocolError(error),
      })
      return null
    } finally {
      reviewLockRef.current = false
    }
  }

  const executeAction = async (action) => {
    if (reviewLockRef.current) {
      setActionNotice({
        title: "Review updating",
        body: "Wait for the current onchain review to finish before opening a wallet request.",
      })
      return
    }
    if (action.type === "license" && action.licenseConfirmed !== true) {
      setActionNotice({
        title: "Confirmation required",
        body: "Review the permanent WOVEN removal before activating creator access.",
      })
      return
    }

    if (!contractAddressesConfigured) {
      setActionNotice({
        title: "Action unavailable",
        body: "Woven is not connected to its verified contracts on this network. No wallet request or transaction was sent.",
      })
      return
    }
    if (action.type === "buy" && action.basket?.oneClickRoute !== true) {
      setActionNotice({
        title: "USDC purchase unavailable",
        body: "This basket does not have a reviewed route for every constituent. No wallet request or transaction was sent.",
      })
      return
    }
    if (action.type === "buy" && !oneClickContractsConfigured) {
      setActionNotice({
        title: "USDC purchase unavailable",
        body: "The USDC router and its bStock routes are not configured. No wallet request or transaction was sent.",
      })
      return
    }

    const expectedBasket = action.basket ? getConfiguredBasketRecipe(action.basket) : null
    if (["buy", "mint", "redeem", "fees"].includes(action.type) && !expectedBasket) {
      setActionNotice({
        title: "Basket unavailable",
        body: "The verified basket address and every configured constituent must match before this action can request a wallet transaction.",
      })
      return
    }
    if (["buy", "mint", "redeem"].includes(action.type) && !action.review) {
      setActionNotice({
        title: "Onchain review required",
        body: "Review the current contract amounts before opening a wallet transaction.",
      })
      return
    }
    if (["buy", "mint", "redeem"].includes(action.type)) {
      const reviewMatches = isTradeReviewCurrent(action.review, {
        type: action.type,
        amount: action.amount,
        chainId: wallet.chainId,
        providerId: wallet.selectedProviderId,
        account: wallet.account,
        basketAddress: expectedBasket.address,
      })
      if (!reviewMatches) {
        setActionNotice({
          title: "Review expired",
          body: "The wallet, network, basket or amount changed. Prepare a fresh onchain review before continuing.",
        })
        return
      }
    }
    if (
      action.type === "buy" &&
      (!Number.isFinite(action.review.reviewExpiresAtMs) ||
        Date.now() >= action.review.reviewExpiresAtMs)
    ) {
      setActionNotice({
        title: "Quote expired",
        body: "The USDC price bound expired. Refresh the onchain quote before continuing. No wallet request or transaction was sent.",
      })
      return
    }

    const creationConstituents =
      action.type === "create"
        ? action.selected.map((symbol) => ({
            token: stockBySymbol[symbol]?.address,
            units: action.units[symbol],
          }))
        : []
    if (action.type === "create" && creationConstituents.some((item) => !item.token)) {
      setActionNotice({
        title: "Asset unavailable",
        body: "Every selected constituent needs a verified canonical contract address before a basket can be published.",
      })
      return
    }

    setBusyAction(action.type)
    let actionAccount = wallet.account
    try {
      let account = wallet.account
      let connectedChain = wallet.chainId
      if (!account) {
        const result = await requestWalletConnection()
        if (!result?.ok) return
        account = result.account
        connectedChain = result.chainId
      }
      actionAccount = account
      if (connectedChain !== wovenContracts.chainId) {
        const result = await wallet.switchToBnbChain()
        if (!result?.ok) return
      }
      if (!wallet.provider) {
        setActionNotice({
          title: "Wallet unavailable",
          body: "Reconnect a compatible browser wallet before continuing.",
        })
        return
      }

      const executionContext = wallet.captureContext()
      if (
        !wallet.isContextCurrent(executionContext) ||
        executionContext.account.toLowerCase() !== account.toLowerCase() ||
        executionContext.chainId !== wovenContracts.chainId
      ) {
        setActionNotice({
          title: "Wallet context changed",
          body: "The wallet, account or network changed before the request was prepared. Review the connection and try again.",
        })
        return
      }

      setActionNotice({
        title: "Confirm in your wallet",
        body:
          action.type === "buy"
            ? "Woven will recheck the short-lived USDC quote, request only the required allowance, then atomically buy every required bStock and mint the basket."
            : action.type === "mint"
              ? "Woven will request only the constituent approvals still required, then the basket mint. Verify every request in your wallet."
              : action.type === "license"
                ? "Creator access may require a WOVEN approval followed by the one-time activation transaction."
                : action.type === "fees"
                  ? "Woven is verifying the pending basket fees and simulating the contract distribution before submission."
                  : `Woven is simulating the request before your wallet submits it to ${wovenContracts.networkName}.`,
        pending: true,
      })

      const [publicClient, walletClient] = await Promise.all([
        getPublicClient(),
        createInjectedWalletClient({ provider: wallet.provider, account }),
      ])
      const transactionLifecycle = createPendingTransactionLifecycle({
        guard: pendingGuard,
        chainId: wovenContracts.chainId,
        account,
        action: action.type,
        basket: expectedBasket?.address || null,
      })
      const common = {
        publicClient,
        walletClient,
        account,
        assertCurrentContext: () => wallet.isContextCurrent(executionContext),
        beforeTransactionSubmit: () => pendingGuard.assertWritable(),
        onTransactionLifecycle: transactionLifecycle.handle,
      }
      let result
      let successTitle
      let successBody

      if (action.type === "license") {
        result = await activateCreatorLicense(common)
        successTitle = result.alreadyLicensed
          ? "Creator access already active"
          : "Creator access active"
        successBody = result.alreadyLicensed
          ? "This wallet was already licensed to publish Woven baskets."
          : "The required WOVEN was removed from circulation and creator access was verified onchain."
      } else if (action.type === "create") {
        result = await createBasket({
          ...common,
          name: action.name,
          symbol: action.symbol,
          constituents: creationConstituents,
          mintFeeBps: WOVEN_TOKENOMICS.mintFeeBps,
          initialSupplyCap: String(WOVEN_TOKENOMICS.basketSupplyCap),
        })
        successTitle = "Basket published"
        successBody = `The basket contract was created at ${compactAddress(result.basketAddress)} and verified against the factory event.`
        onNavigate("basket", result.basketAddress)
      } else if (action.type === "buy") {
        result = await mintBasketWithUsdc({
          ...common,
          basketAddress: expectedBasket.address,
          expectedBasket,
          amount: action.amount,
          quote: action.review,
          review: action.review,
        })
        successTitle = "Basket purchased"
        successBody = `${result.readiness.netBasketOutFormatted} ${action.basket.symbol} was minted to your wallet through the reviewed atomic USDC route.`
        setBasketActivityRevision((value) => value + 1)
      } else if (action.type === "mint") {
        result = await mintBasket({
          ...common,
          basketAddress: expectedBasket.address,
          expectedBasket,
          amount: action.amount,
          review: action.review,
        })
        const quote = getMintQuote(result.readiness)
        successTitle = "Basket minted"
        successBody = `${quote.netFormatted} ${action.basket.symbol} was minted to your wallet after the exact ${quote.feeFormatted} ${action.basket.symbol} protocol fee.`
        setBasketActivityRevision((value) => value + 1)
      } else if (action.type === "redeem") {
        result = await redeemBasket({
          ...common,
          basketAddress: expectedBasket.address,
          expectedBasket,
          amount: action.amount,
          review: action.review,
        })
        successTitle = "Redemption confirmed"
        successBody = `${result.basketAmountFormatted} ${action.basket.symbol} was burned on ${wovenContracts.networkName}. Check the receiving wallet balances for the final token amounts.`
        setBasketActivityRevision((value) => value + 1)
      } else if (action.type === "fees") {
        result = await distributeBasketFees({
          ...common,
          basketAddress: expectedBasket.address,
        })
        successTitle = "Fees distributed"
        successBody = `${formatTokenAmount(result.distribution.totalAmount, 18)} ${action.basket.symbol} was distributed: ${formatTokenAmount(result.distribution.creatorAmount, 18)} to the creator and ${formatTokenAmount(result.distribution.treasuryAmount, 18)} to the treasury.`
        setBasketActivityRevision((value) => value + 1)
      } else {
        throw new Error("Unknown protocol action")
      }

      setActionNotice({
        title: successTitle,
        body: successBody,
        txHash: latestTransactionHash(result),
        contractAddress: result?.basketAddress || null,
      })
      return result
    } catch (error) {
      const completedTransactionHashes = Array.isArray(error?.details?.completedTransactionHashes)
        ? error.details.completedTransactionHashes
        : []
      if (error?.code === "RECEIPT_UNCONFIRMED" && error?.txHash && actionAccount) {
        let pendingState
        try {
          pendingState = pendingGuard.persist({
            chainId: wovenContracts.chainId,
            account: actionAccount,
            action: action.type,
            basket: expectedBasket?.address || null,
            hash: error.txHash,
          })
        } catch {
          try {
            const current = pendingGuard.read()
            pendingState = {
              ...current,
              transaction: current.transaction || { hash: error.txHash },
            }
          } catch {
            pendingState = {
              status: "blocked",
              reason: "storage-unavailable",
              transaction: { hash: error.txHash },
            }
          }
        }
        setActionNotice(pendingTransactionNotice(pendingState))
        return
      }

      const creationConfirmedButUnverified = [
        "BASKET_EVENT_NOT_FOUND",
        "BASKET_POST_CONFIRMATION_MISMATCH",
        "BASKET_POST_CONFIRMATION_UNVERIFIED",
      ].includes(error?.code)
      setActionNotice({
        title: creationConfirmedButUnverified
          ? "Transaction confirmed — verification required"
          : "Onchain request not completed",
        body: `${formatProtocolError(error)}${
          completedTransactionHashes.length > 0
            ? ` ${completedTransactionHashes.length} earlier approval transaction${completedTransactionHashes.length === 1 ? " was" : "s were"} confirmed; review the current allowances before trying again.`
            : ""
        }`,
        txHash: error?.txHash || completedTransactionHashes.at(-1) || null,
      })
    } finally {
      setBusyAction(null)
    }
  }

  const requestAction = async (action) => {
    if (busyAction || actionLockRef.current) return

    actionLockRef.current = true
    try {
      const execute = async () => {
        const pending = await reconcilePendingTransaction()
        if (!pending.allowAction) return undefined
        return executeAction(action)
      }

      if (!contractAddressesConfigured) return await execute()

      let locked
      try {
        locked = await runWithExclusiveWriteLock(getBrowserLockManager(), execute)
      } catch {
        setActionNotice({
          title: "Transaction lock unavailable",
          body: "Woven could not establish the browser-wide transaction lock. No wallet request was sent. Reload the page or use a compatible browser before trying again.",
        })
        return
      }
      if (locked.status === "unsupported") {
        setActionNotice({
          title: "Transaction lock unavailable",
          body: "This browser cannot coordinate Woven transactions across tabs. Use a compatible browser before sending an onchain request.",
        })
        return
      }
      if (locked.status === "busy") {
        setActionNotice({
          title: "Transaction already active",
          body: "Another Woven tab is preparing or confirming a transaction. Finish that request before starting another one.",
        })
        return
      }
      return locked.value
    } finally {
      actionLockRef.current = false
      setBusyAction(null)
    }
  }

  const content =
    initialView === "basket" && basket ? (
      <BasketDetail
        key={`${basket.address}:${wallet.account || "disconnected"}:${wallet.chainId ?? "unknown"}:${wallet.selectedProviderId || "provider"}:${basketActivityRevision}`}
        basket={basket}
        onBack={() => onNavigate("app")}
        wallet={wallet}
        onPrepare={requestTradeReview}
        onAction={requestAction}
        busyAction={busyAction}
        getPublicClient={getPublicClient}
        activityRevision={basketActivityRevision}
      />
    ) : initialView === "basket" && basketRouteLoading ? (
      <BasketRouteStatus
        title="Verifying basket"
        body="Reading the basket and its fixed composition from the configured Woven factory."
        loading
        onNavigate={onNavigate}
      />
    ) : initialView === "basket" && requestedBasketAddress ? (
      <BasketRouteStatus
        title="Basket unavailable"
        body={
          !contractAddressesConfigured
            ? "This basket cannot be verified until the Woven factory is connected on this network."
            : currentDynamicBasket?.error ||
              "This basket could not be verified against the configured Woven factory."
        }
        onNavigate={onNavigate}
      />
    ) : initialView === "basket" ? (
      <NotFound title="Basket not found" onNavigate={onNavigate} />
    ) : initialView === "portfolio" ? (
      <Portfolio
        wallet={wallet}
        onNavigate={onNavigate}
        getPublicClient={getPublicClient}
        onConnect={requestWalletConnection}
      />
    ) : initialView === "studio" ? (
      <CreatorStudio
        onAction={requestAction}
        busyAction={busyAction}
        wallet={wallet}
        getPublicClient={getPublicClient}
      />
    ) : initialView === "app" ? (
      <BasketIndex
        onOpen={(id) => onNavigate("basket", id)}
        onNavigate={onNavigate}
        getPublicClient={getPublicClient}
      />
    ) : (
      <NotFound onNavigate={onNavigate} />
    )

  const notice =
    actionNotice || (wallet.error ? { title: "Wallet request failed", body: wallet.error } : null)

  return (
    <div className="product-app">
      <a
        className="skip-link app-skip-link"
        href="#app-content"
        onClick={(event) => {
          event.preventDefault()
          const target = document.getElementById("app-content")
          target?.focus({ preventScroll: true })
          target?.scrollIntoView({ block: "start" })
        }}
      >
        Skip to content
      </a>
      <AppHeader
        view={initialView}
        onNavigate={onNavigate}
        wallet={wallet}
        walletPanelRequest={walletPanelRequest}
      />
      <div
        className={`route-stage${initialView === "studio" ? " route-stage--studio" : ""}`}
        key={`${initialView}-${basketId || ""}`}
      >
        {content}
      </div>
      {notice && (
        <Modal
          title={notice.title}
          onClose={() => {
            setActionNotice(null)
            wallet.clearError()
          }}
        >
          <p
            className={
              notice.pending ? "protocol-notice protocol-notice--pending" : "protocol-notice"
            }
          >
            {notice.pending ? (
              <LoaderCircle className="button-spinner" size={17} aria-hidden="true" />
            ) : null}
            <span>{notice.body}</span>
          </p>
          {notice.pending ? (
            <p className="protocol-notice__aside">
              Closing this message does not cancel a wallet request. Disconnecting or changing the
              wallet stops any later protocol requests in this sequence.
            </p>
          ) : null}
          {notice.txHash ? (
            <a
              className="protocol-notice__link"
              href={`${wovenContracts.explorerBaseUrl}/tx/${notice.txHash}`}
              target="_blank"
              rel="noreferrer"
              aria-label="View transaction on BscScan (opens in a new tab)"
            >
              View transaction <ExternalLink size={15} aria-hidden="true" />
            </a>
          ) : null}
          {notice.contractAddress ? (
            <a
              className="protocol-notice__link"
              href={`${wovenContracts.explorerBaseUrl}/address/${notice.contractAddress}`}
              target="_blank"
              rel="noreferrer"
              aria-label="View basket contract on BscScan (opens in a new tab)"
            >
              View basket contract <ExternalLink size={15} aria-hidden="true" />
            </a>
          ) : null}
          <button
            className="button button--ink button--full"
            type="button"
            onClick={() => {
              setActionNotice(null)
              wallet.clearError()
            }}
          >
            Close
          </button>
        </Modal>
      )}
    </div>
  )
}
