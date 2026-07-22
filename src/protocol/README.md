# Protocol client

This directory is the browser-facing boundary for Woven contract reads and
writes. It uses `viem`, exact `bigint` arithmetic, an allowlisted build-time BNB
Smart Chain profile, and transaction simulation before each wallet submission.
`VITE_BNB_NETWORK` selects mainnet (`chainId: 56`, the default) or testnet
(`chainId: 97`); any other value stops the build.

Submitted writes wait for two confirmations by default. A receipt timeout is an
unknown state, not a failed transaction; clients must retain the transaction
hash and prevent blind resubmission until its final receipt is reconciled.

## Configuration boundary

All six core addresses in `.env.example` are required for protocol writes. The
atomic purchase path additionally requires the configured BSC USDC and
`OneClickBasketRouter` addresses. The client rejects zero or malformed
addresses, requires deployed contract code, validates the immutable wiring
exposed by the configured contracts, and fails closed when configuration is
incomplete. Source-code and deployed-bytecode identity must be verified
independently against the signed release record and block explorer.

Mint, redeem, and constituent-approval writes require an `expectedBasket`
containing the verified basket address, name, symbol, mint fee, and complete
constituent recipe. A name or symbol is never treated as identity.
`getConfiguredBasketRecipe()` in `src/data/baskets.js` returns this object only
when the basket and constituent addresses plus the confirmed raw recipe are
configured. Displayed bStock amounts use ERC-8056 conversion helpers; recipe
identity, balances, approvals, and transfers remain raw.

`VITE_*` values are public browser configuration. Never put private keys,
authenticated provider URLs, or other secrets in them. Every configured address
must belong to the selected network profile.

## Public exports

`src/protocol/index.js` exposes these application-level APIs:

- Clients: `createBnbPublicClient`, `createInjectedWalletClient`, `createBnbClients`
- Creator access: `getCreatorLicenseStatus`, `approveCreatorLicense`,
  `burnCreatorLicense`, `activateCreatorLicense`
- Basket creation: `prepareBasketCreation`, `createBasket`
- Basket reads: `verifyBasketRecipe`, `getBasketRequiredUnits`,
  `getBasketMintReadiness`, `getBasketRedemptionReadiness`
- Basket writes: `approveBasketConstituents`, `mintBasket`, `redeemBasket`
- Atomic USDC purchase: `createBasketBuyQuote`,
  `createBasketBuyQuoteFingerprint`, `getBasketBuyReadiness`,
  `approveUsdcForBasketBuy`, `mintBasketWithUsdc`
- Discovery: `listFactoryBasketAddresses`, `readFactoryBasket`,
  `discoverFactoryBaskets`, `getPortfolioBalances`
- Fees: `getFeeDistributionStatus`, `distributeBasketFees`
- Pending receipts: `createPendingTransactionGuard`, `pendingTransactionGuard`
- Errors and formatting: `ProtocolError`, `formatProtocolError`,
  `toProtocolError`, `runProtocolAction`, `withCompletedTransactions`, and exact
  amount helpers
- Scaled amounts: `readScaledUiAmount`, `convertScaledUiInput`

Human-entered amounts are decimal strings. Returned raw token amounts are
`bigint` values.

The bStock adapter requires the ERC-8056 core, conversion, and pending-state
interfaces and fails closed when any read is missing or malformed. Trade reviews
fingerprint raw amounts, displayed amounts, the active multiplier, the pending
multiplier, and its effective timestamp; a change blocks the write and requires
a fresh review.

Atomic purchase quotes enumerate only constructor-bound adapter routes and
select the cheapest valid exact-output route per constituent at one pinned BNB
Chain block. A quote commits to the block hash, route and adapter hashes, exact
outputs, expected and maximum USDC per leg, aggregate maximum, basket recipe,
fee, recipient, and short deadline. Readiness reproduces those quotes at the
pinned block and verifies that the block remains canonical before any wallet
request. The default maximum is one percent above each expected leg and the
default quote lifetime is five minutes.

When the current allowance is insufficient, `approveUsdcForBasketBuy` first
resets a non-zero partial allowance and then approves exactly the reviewed
aggregate maximum. This approval is a separate wallet transaction. The
subsequent `mintBasketWithUsdc` call rechecks the complete review, simulates the
router request, and submits one atomic transaction for every swap and the final
mint. A failed leg reverts the whole purchase; unused USDC is refunded by the
router.

## Clients and writes

```js
const publicClient = await createBnbPublicClient()
const walletClient = await createInjectedWalletClient({
  provider: wallet.provider,
  account: wallet.account,
})

const expectedBasket = getConfiguredBasketRecipe(basket)
if (!expectedBasket) throw new Error("Basket configuration is incomplete")

const result = await mintBasket({
  publicClient,
  walletClient,
  account: wallet.account,
  basketAddress: expectedBasket.address,
  expectedBasket,
  amount: "1.25",
  assertCurrentContext: () => wallet.isContextCurrent(reviewedContext),
})
```

Creating a wallet client does not request accounts or switch networks. The
wallet UI owns those interactions. Every write rechecks the active account and
selected chain.

After a basket-creation receipt confirms, the client reads the emitted basket
and verifies factory and fee-splitter creator provenance, exact metadata and
recipe, mint fee, both caps, guardian, fee recipient, and decimals. It also
confirms nonempty contract code at the emitted address. A mismatch fails closed
with the confirmed transaction hash so callers do not submit a duplicate
creation transaction.

Minting verifies factory provenance, immutable protocol wiring, and the complete
basket terms before reading requirements. It submits missing approvals
sequentially, re-reads state, simulates the mint, submits it, and waits for a
successful receipt. Set `approveConstituents: false` to require separate
approvals. Exact approvals are the default; use `approvalAmount: "max"` only
after an explicit user choice.

If a later request in a multi-transaction sequence fails, the thrown error keeps
the hashes of earlier confirmed approvals in
`details.completedTransactionHashes`. The application surfaces those hashes so
the user can review existing allowances instead of assuming that nothing
changed.

`createPendingTransactionGuard()` stores one submitted-but-unconfirmed write in
a strict, versioned browser record. It prevents another write from replacing
that record and clears it only after a matching final receipt has reached the
same two-confirmation depth used by normal writes. Corrupt or unavailable
storage fails closed for new writes. `ProductApp` reconciles this record on load
and immediately before every write action.

`ProductApp` also holds an exclusive browser-wide Web Lock for the complete
write sequence. Its transaction lifecycle stores each broadcast hash before
receipt polling begins, atomically follows wallet repricing, and clears only an
exact transaction after a known terminal outcome. An unconfirmed write remains
locked across reloads so a timeout cannot become a blind duplicate submission.
Immediately before every individual wallet broadcast, the client also performs
a reversible write/read/remove probe against the durable guard slot. Read-only,
full, corrupt, or silently failing storage stops the request before the wallet
can submit it.

When a wallet reprices or replaces that write, call
`guard.replaceHash(expectedTransaction, replacementHash)`. The compare-and-set
operation changes only the hash, requires the exact prior identity, verifies the
single stored record after writing, and is idempotent when the replacement is
already current. Unsafe storage states remain locked and are never overwritten.

Pass `assertCurrentContext` to any exported write action. The callback receives
`{ phase, account }` and runs immediately before simulation and again before
submission for every transaction. Returning `false` or throwing produces
`CONTEXT_CHANGED` and prevents that submission. Each submitted transaction
object contains its hash and receipt; high-level results group those objects by
action.

## Discovery and fees

`listFactoryBasketAddresses` reads the paginated factory index and provenance.
`readFactoryBasket` reads one factory-created basket. `discoverFactoryBaskets`
adds terms, supply, pause, backing, and constituent data. `getPortfolioBalances`
reads an account's factory-basket balances and omits zero balances unless
`includeZeroBalances` is true. Index, aggregate-discovery, and portfolio results
retain successful entries and return structured `failures` for entries that
could not be verified.

`getBasketMintReadiness` returns the onchain `mintFeeBps`, gross basket amount,
fee amount, net amount, balances, allowances, `isFullyBacked`, and blockers. An
underbacked basket includes `UNDERBACKED`, cannot mint, and is rejected before
any constituent approval or mint submission. The UI helper
`getMintQuote(readiness)` formats those values; it is not a price or gas quote.
`getFeeDistributionStatus` returns the fee splitter's pending basket-token
balance and the exact creator/treasury split. `distributeBasketFees` invokes the
permissionless split when a balance is pending; it does not award the caller a
fee.

Display `formatProtocolError(error)` to users. Retain the `ProtocolError` for its
structured code and any submitted transaction hash when receipt confirmation is
uncertain.
