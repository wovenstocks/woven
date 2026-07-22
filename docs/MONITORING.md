# Production monitoring plan

> **Status: pre-launch specification.** This repository does not deploy a
> monitor, indexer, pager, status page, log store, or on-call service. Every
> provider, destination, owner, threshold, and retention location marked
> `REQUIRED` must be assigned, tested, and recorded in the release manifest
> before public mainnet write actions are enabled.

Monitoring must establish what happened at a specific BNB Smart Chain block. It
must not turn a local simulation, an unconfirmed transaction, a frontend result,
or a single RPC response into onchain proof.

## Release inputs

Seed the monitor from the signed deployment record, not from tickers, search
results, or frontend environment variables.

| Input                 | Required release value                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network               | BNB Smart Chain mainnet, chain ID `56`                                                                                                                                 |
| Core contracts        | Creator license, registry, fee splitter, guardian, factory, and every supported basket address                                                                         |
| Control plane         | Protocol Safe, expected owners, threshold, nonce baseline, singleton, fallback handler, modules, guard, and runtime-code hashes                                        |
| Router surface        | USDC, router, ordered adapters, immutable dependencies, route IDs and hashes, pools, and release-time runtime-code hashes                                              |
| External assets       | Primary-source address evidence, proxy or beacon resolution, administrator or owner, implementation and code hash, ERC-8056 state, and documented restriction controls |
| Web release           | Production domain, immutable deployment URL, release commit, build digest, network profile, and public contract-address digest                                         |
| Observation providers | `REQUIRED`: primary RPC or indexer, independent RPC, web probe location, and notification destination                                                                  |
| Ownership             | `REQUIRED`: monitoring owner, on-call owner and backup, evidence custodian, and external-asset liaison                                                                 |

Authenticated RPC URLs, notification credentials, wallet secrets, and provider
tokens belong in the monitoring provider's secret store. They must not appear in
the release record or this repository.

## Chain observation rules

- Ingest logs by `(chainId, blockHash, transactionHash, logIndex)` and retain the
  raw log before decoding it.
- Keep observations provisional until the release owner has selected and
  documented a BNB Chain confirmation threshold. Reconcile block hashes and
  remove or supersede observations affected by a reorganization.
- Read post-state at the event's block when the RPC supports historical state;
  also capture a current-block read to identify later changes.
- Use at least two independent providers for a critical alert. Provider
  disagreement is itself a degraded-monitoring alert, not permission to choose
  the more convenient result.
- De-duplicate notifications without deleting repeated evidence. A resolved
  alert must link to the transaction receipt and state read-back that resolved
  it.
- Backfill from the last confirmed block after every collector restart. Alert on
  a gap rather than silently resuming from the current head.

## Protocol event coverage

Monitor all deployed instances from their creation blocks. Standard ERC-20
`Transfer` and `Approval` logs are useful transaction evidence but do not, by
themselves, prove correct backing or authorization.

| Contract                 | Event                                                                                                                                   | Required correlation and read-back                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Protocol Safe            | execution success/failure and every owner, threshold, module, guard, or fallback-handler change from the exact verified Safe v1.4.1 ABI | Safe transaction hash and nonce, decoded target/value/operation/calldata, executor receipt, expected change record, and complete post-state profile                                        |
| `CreatorLicense`         | `LicenseBurned`                                                                                                                         | Creator, exact `10,000e18` amount, configured sink, successful receipt, sink balance delta, and `isLicensed(creator)`                                                                      |
| `CanonicalAssetRegistry` | `AssetStatusSet`                                                                                                                        | Executing Safe transaction, asset code, primary-source evidence, final `isSupported(asset)`, registry `owner()`, and `pendingOwner()`                                                      |
| `CanonicalAssetRegistry` | inherited `OwnershipTransferStarted` / `OwnershipTransferred`                                                                           | Expected old, pending, and new owner; Safe approval record; final owner and pending owner                                                                                                  |
| `BasketFactory`          | `BasketCreated`                                                                                                                         | Creator license, registry membership at the event block, factory `creatorOf`, basket runtime code, immutable recipe, fee, cap, guardian, fee recipient, and matching splitter registration |
| `FeeSplitter`            | `BasketRegistered`                                                                                                                      | Same receipt and basket/creator pair as factory creation                                                                                                                                   |
| `BasketToken`            | `Minted`                                                                                                                                | Gross amount, fee, total-supply delta, exact constituent inflows, cap, pause state, and backing after the receipt                                                                          |
| `BasketToken`            | `Redeemed`                                                                                                                              | Burn amount, total-supply delta, exact constituent outflows, recipient deltas, and backing after the receipt                                                                               |
| `BasketToken`            | `MintPausedSet`                                                                                                                         | Matching guardian call and final `mintPaused()` state                                                                                                                                      |
| `CuratorGuardian`        | `MintPauseSet`                                                                                                                          | Expected Safe execution, managed basket, matching basket event in the same receipt, and final pause state                                                                                  |
| `BasketToken`            | `SupplyCapSet`                                                                                                                          | Matching guardian call, previous cap, new cap, immutable maximum, and final `supplyCap()`                                                                                                  |
| `CuratorGuardian`        | `CapRaised`                                                                                                                             | Expected Safe execution, matching basket event, and strictly increasing cap not above `maxSupplyCap()`                                                                                     |
| `FeeSplitter`            | `Distributed`                                                                                                                           | Registered creator, 60/40 amounts, basket-token balance deltas, and final splitter balance                                                                                                 |
| `OneClickBasketRouter`   | `BasketMintedWithUsdc`                                                                                                                  | Payer, basket, recipient, gross and net output, measured USDC debit/refund, constituent outputs, basket mint event, and router/adapter post-state                                          |

An event decoder must be versioned with the monitored runtime code. Unknown
topics or a decoding mismatch at a monitored address are alerts, not logs to
discard. The Safe monitor must load its ABI from the pinned, verified singleton;
it must not assume that events from another Safe version have the same meaning.

## State and invariant checks

### Safe and protocol control plane

Check every block for events and at least every five minutes by direct read:

- Safe runtime code, proxy singleton, version, owners, threshold, modules,
  guard, fallback handler, and nonce match the approved control profile or an
  executed change record;
- registry `owner()` equals the approved Safe and `pendingOwner()` is zero
  outside a recorded two-step transfer;
- guardian `admin`, splitter `treasury` and `factory`, and the factory's license,
  registry, splitter, and guardian links match their immutable release values;
- no Safe execution, owner or threshold change, module enablement, guard change,
  fallback-handler change, or registry ownership step is accepted merely
  because it came from the Safe address. It must match an approved transaction
  record and successful executor receipt.

The launch profile is a one-owner, threshold-one Safe. Monitoring reduces
detection time; it does not remove that single-key risk.

### Basket backing and configuration

For every factory-created basket, recalculate each requirement in raw units:

```text
required(token) = ceil(totalSupply * unitsPerBasket(token) / 1e18)
```

Compare the result with the constituent balance held by the basket and with
`isFullyBacked()`. Also pin and re-read `constituents()`, `units()`,
`mintFeeBps`, `feeRecipient`, `guardian`, `maxSupplyCap`, `supplyCap`, and
`mintPaused`. A runtime-code or immutable-configuration mismatch is critical.
Excess constituent balances are recorded as over-backing; they are not counted
as protocol revenue and must not hide a deficit in another constituent.

### External bStocks

For every admitted address, monitor the control surface recorded during asset
admission:

- token runtime code and the EIP-1967 implementation, beacon, and administrator
  slots; for a beacon, resolve `implementation()` and monitor the beacon's
  administrator or owner using its verified ABI;
- resolved implementation runtime code hash and any provider-published upgrade
  event;
- exact symbol, decimals, ERC-8056 interface support, `uiMultiplier()`,
  `newUIMultiplier()`, `effectiveAt()`, and the `toUIAmount`/`fromUIAmount`
  roundtrip used by the release preflight;
- pause, blacklist, freeze, seizure, transfer-restriction, or operator state and
  events exposed by the verified issuer ABI;
- primary issuer status, current terms, custody and redemption notices, and
  jurisdiction restrictions through a separately assigned manual review.

Pause and compliance controls are not standardized across ERC-20s. The release
record must name the exact ABI methods, events, privileged addresses, and normal
values for each asset; the monitor must not guess method names or infer safety
from a successful `balanceOf` call. A multiplier change affects displayed
amounts, not the basket's immutable raw-unit recipe.

### Router, adapters, and market routes

The router and adapters have no admin pause, upgrade, route replacement, or
rescue function. Monitor:

- router runtime code and immutable `usdc`, `basketFactory`, `assetRegistry`,
  ordered `adapters()`, and `adapterCodehash(adapter)` values;
- every adapter's runtime code, immutable external dependencies,
  `inputToken()`, `routeOutput(routeId)`, and `routeHash(routeId)`;
- proxy implementations and runtime code hashes for external dependencies such
  as USDC, plus the deployment-record pins for venue routers, quoters, pool
  managers, state views, Permit2, factories, and pools;
- route-specific pool state and liquidity, and fresh exact-output quote probes
  at the release-record sizes. Alert when a quote fails, liquidity reaches zero,
  or the approved price-impact or maximum-input threshold is exceeded;
- confirmed router failures grouped by selector or revert data, successful
  route spend, refund, and output deltas;
- USDC and constituent balances at the router and adapters before and after
  transactions. Compare against the previously recorded baseline, because a
  third party can donate tokens. Any unexplained increase is a residual alert;
  any session delta after a successful transaction is critical. Residual funds
  may be stranded because there is no rescue function.

Registry removal prevents router execution for an affected constituent, but it
does not alter existing basket recipes or stop direct in-kind minting. Those
limits must be reflected in every alert response.

### Web and release integrity

From at least two locations, probe the production domain and immutable
deployment URL every minute once monitoring is activated:

- DNS, TLS validity, HTTPS status, response latency, and direct navigation to
  each supported route;
- required security headers and expected cache behavior for HTML and immutable
  assets;
- release commit/build marker, chain ID `56`, public address digest, and loaded
  JavaScript asset hashes against the approved release record;
- a read-only wallet/RPC synthetic that verifies chain mismatch and incomplete
  configuration fail closed without requesting a signature;
- desktop and narrow-mobile rendering of the landing page, basket list, basket
  detail, studio, and error boundary.

A synthetic must never perform a mainnet approval, mint, purchase, redemption,
Safe execution, or wallet signature. A healthy website does not prove healthy
contracts, routes, or external assets.

## Alert severity and routing

Acknowledgement targets below are launch targets, not current staffing claims.
They apply only after an owner, backup, paging route, and escalation route have
passed a test notification.

| Severity              | Examples                                                                                                                                                                                                                                     | Proposed acknowledgement target                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `SEV-0 Critical`      | Backing deficit; confirmed unauthorized Safe control change; external bStock pause/freeze affecting transfers; monitored implementation or critical code-hash change; wrong chain or addresses served with writes enabled; confirmed exploit | Page incident commander, onchain lead, Safe operator, and web lead immediately; target 15 minutes |
| `SEV-1 High`          | Unexpected registry or pending-owner change; router session residual; route unavailable across independent providers; production write path unavailable; domain or release-integrity failure                                                 | Page primary owner and incident commander; target 30 minutes                                      |
| `SEV-2 Medium`        | Scheduled multiplier change; cap or liquidity approaching its reviewed threshold; one RPC/indexer unavailable; elevated reverted-transaction rate                                                                                            | Ticket plus owner notification; target four hours                                                 |
| `SEV-3 Informational` | Expected basket creation, distribution, planned Safe execution, or release observation with all postconditions satisfied                                                                                                                     | Retain for review; no page                                                                        |

An expected change remains alertable until it is matched to a reviewed change
record and all postconditions pass. Silence windows must identify the exact
rule, addresses, start/end time, approver, and reason; never silence all onchain
alerts for a deployment.

## Evidence and retention

For every alert or material state change, retain:

1. alert ID, rule version, detection and acknowledgement times, chain ID, block
   number/hash, RPC providers, and raw responses;
2. raw logs, decoded events, transaction and Safe transaction hashes, sender
   nonce, full receipt/status, calldata or its hash, and state read-backs pinned
   to a block;
3. runtime code, code hashes, implementation/beacon/admin slots, quote inputs,
   route state, relevant balance deltas, and independent-provider comparison;
4. incident decisions, reviewers, executed actions, public notices, recovery
   evidence, and postmortem; and
5. SHA-256 hashes of exported evidence files and an append-only custody log.

Store public-chain evidence and operational records in an access-controlled,
append-only location with encrypted backups. Do not store private keys, seed
phrases, keystore passwords, authenticated RPC URLs, session cookies, or
unredacted wallet recordings. Screenshots are secondary evidence and never
replace receipts or block-pinned reads.

The release owner and legal reviewer must approve a retention schedule. Until
that schedule exists, deletion is blocked. The engineering baseline is to keep
deployment, Safe-control, asset-admission, and incident evidence for the
supported life of the immutable deployment plus at least 24 months; applicable
law or provider terms may require longer retention.

## Activation checklist

Monitoring is not operational until all of the following are evidenced:

- [ ] Every required address, block, code hash, proxy resolution, route, and
      expected state was imported from the final deployment record.
- [ ] Primary and independent RPC providers agree on a recorded test block, and
      gap/reorganization handling was exercised.
- [ ] Every `SEV-0` and `SEV-1` rule generated a test notification received by
      the assigned primary and backup.
- [ ] Web probes validated both the production domain and immutable deployment
      URL without sending a transaction or signature request.
- [ ] Evidence export, hashing, access control, backup restoration, and the
      approved retention schedule were tested.
- [ ] The incident roles in [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) were
      assigned and the pre-launch tabletop was completed.
- [ ] The release owner signed the activation record. A configuration file or
      dashboard screenshot alone is not activation evidence.
