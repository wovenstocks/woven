# Woven Core Security Properties

Scope: source-level specification. These properties describe the intended
behavior of the Solidity contracts in `src/`; they are not evidence of a live
deployment or a completed independent audit.

## Scope and trust model

- A `BasketToken` represents a fixed in-kind recipe of 2 to 20 ERC-20 assets.
- The factory, registry, license, fee splitter, and guardian addresses are
  constructor-bound. The contracts are not proxy-upgradeable.
- `OneClickBasketRouter` binds one USDC token, one canonical basket factory, the
  factory's registry, and an immutable adapter set. Adapter runtime code hashes
  are pinned in the router constructor.
- Venue adapters bind their exact-output routes and external dependencies in
  constructors. The Uniswap v4 adapter permits no hooks; the PancakeSwap v3
  adapter stores reverse exact-output paths. Neither accepts arbitrary target
  addresses, selectors, recipients, or calldata from users.
- The protocol Safe owns `CanonicalAssetRegistry` and is the immutable admin of
  `CuratorGuardian`. The treasury and fee splitter destinations are fixed by the
  deployment wiring.
- The included deployment script accepts only the documented canonical Safe
  v1.4.1 profile: one expected owner, threshold one, no modules, no guard, the
  canonical compatibility fallback handler, and `TREASURY == PROTOCOL_SAFE`.
  This is a release-script gate, not a property enforced by every core contract.
- The license burn destination is the hard-coded dead address
  `0x000000000000000000000000000000000000dEaD`, not an operator- or
  deployer-selected account.
- Constituent-token contracts and the WOVEN token are external trust
  dependencies. Code existence or a ticker is not sufficient proof that an
  address is canonical or compatible.

## Critical invariants

### Backing and supply

1. For every constituent `i`, the basket balance must remain at least
   `ceil(totalSupply * units[i] / 1e18)` under the compatible-token assumptions
   below.
2. Before accepting each constituent for a new mint, its existing basket balance
   must cover `ceil(totalSupply * units[i] / 1e18)`. A successful mint then
   transfers at least the new required quantity of every constituent before
   minting exactly `basketAmount` units in total (user amount plus fee amount).
3. A successful redemption burns the requested basket amount before transferring
   `floor(basketAmount * units[i] / 1e18)` of every constituent.
4. `totalSupply <= supplyCap <= maxSupplyCap` at all times.
5. The constituent addresses and raw units cannot change after construction.
6. There is no admin withdrawal path for constituent assets.

### Availability and control

7. Redemption is never gated by `mintPaused`, the registry, the license, or an
   admin role.
8. Only the basket's immutable guardian may change `mintPaused` or `supplyCap`.
   The fee recipient is constructor-bound and immutable.
9. Factory-created baskets use `CuratorGuardian`. Its immutable admin may toggle
   minting or raise a cap to a strictly larger value; `BasketToken` independently
   enforces the immutable maximum cap. The guardian has no route to block
   redemption, redirect fees, or withdraw backing.
   Before forwarding, the guardian rejects empty-code targets and contracts that
   do not identify it as their guardian. It also verifies the resulting cap or
   pause state before emitting success. A forwarded call therefore controls a
   basket only when that basket authorizes the forwarding `CuratorGuardian`.
10. Only the two-step registry owner may add or remove canonical assets. Registry
    changes affect future factory creations only and cannot alter an existing
    basket recipe or redemption. Ownership renunciation is disabled, so the
    registry cannot be accidentally frozen through `renounceOwnership`.

### Licensing, creation, and fees

11. A creator becomes licensed only after the exact compiled
    `LICENSE_BURN_AMOUNT` reaches the fixed published dead address. A failed or
    short transfer reverts the license-state change atomically.
12. One address can pay for a creator license only once; a successful license is
    permanent.
13. The factory creates baskets only for licensed callers and only from assets
    supported by the registry at execution time.
14. Every factory basket starts at or below `STARTER_CAP` and has the immutable
    `CEILING` as its maximum cap.
15. The mint fee and fee recipient are immutable per basket, and the fee cannot
    exceed 50 basis points. The full gross basket amount remains backed: the fee
    is minted as basket tokens, not removed from constituent collateral.
16. `FeeSplitter` registration is factory-only. Distribution sends 60% of the
    registered basket-token balance to its recorded creator and the remainder to
    the immutable treasury.
17. `FeeSplitter.initFactory` succeeds once, only for the deployer, and must be
    completed as part of the deployment sequence.

### Atomic USDC purchase and mint

18. A one-click call is accepted only for a non-zero basket created by the
    immutable factory, with 1 to 8 constituents that remain supported by the
    immutable factory registry at execution time.
19. The caller supplies one exact-output leg per constituent. Leg token,
    required raw output, immutable route output, adapter code hash, and the sum
    of per-leg USDC maxima must match the basket recipe and declared total.
20. The router pulls exactly `maxTotalUsdcIn`. Each adapter may spend no more
    than its leg maximum and must report the same amount the router measures.
    Failed, partial, or over-budget swaps revert every earlier leg and the user
    transfer atomically.
21. Every constituent balance delta must equal the basket's exact raw unit
    requirement before mint. Temporary constituent approvals are exact and are
    cleared after minting.
22. The recipient must receive at least `minNetBasketOut`. Any mint failure or
    short basket output reverts all swaps and transfers.
23. Unspent USDC is returned to the payer. Final USDC and constituent balances
    must equal their pre-call baselines, so one call cannot take prior donations
    or leave its own session funds in the router. Prior donations are not a
    rescue mechanism and can remain permanently stranded.
24. Calls expire at the supplied deadline, which may be no more than 20 minutes
    ahead. Deadlines do not replace per-leg and total maximum-input protection.

## Arithmetic and rounding properties

- Solidity 0.8.24 checked arithmetic must revert on overflow or underflow.
- Deposits round constituent requirements up; redemptions round outputs down.
  Rounding must never make the remaining basket undercollateralized.
- Redemption rejects a request if rounding would make any constituent output
  zero, preventing a holder from burning basket supply without receiving every
  recipe component.
- The fee calculation rounds down by less than one basket-token wei per mint.
- Recipe units are raw constituent-token quantities per `1e18` basket units;
  canonical-asset verification must record each token's decimals. For ERC-8056
  constituents, clients must use the current token helper to convert displayed
  UI amounts to and from these raw units; a UI multiplier does not change the
  immutable raw recipe.

## External-interaction properties

- `mint`, `redeem`, `burnForLicense`, and `distribute` use OpenZeppelin
  `SafeERC20`; value-moving multi-call paths use `ReentrancyGuard`.
- The buy router and venue adapters use OpenZeppelin `SafeERC20` and
  `ReentrancyGuard`. They measure caller debit, adapter spend, refunds, exact
  constituent output, basket output, and final balance restoration rather than
  trusting external return values alone.
- PancakeSwap v3 and Uniswap v4 quote and execution dependencies are immutable
  and code-hash pinned by their adapters. The Uniswap v4 adapter also clears its
  ERC-20-to-Permit2 and Permit2-to-Universal-Router allowances after each swap.
- A failed constituent transfer must revert the entire mint or redemption.
- Minting rejects a pre-existing backing deficit before accepting more of the
  affected constituent, then verifies the basket's balance increase and rejects
  short incoming transfers such as conventional fee-on-transfer tokens.
- Redemption rejects the basket itself as recipient and verifies that each
  transfer decreases basket backing by exactly the nominal amount while
  increasing the recipient by at least that amount. Short outgoing transfers
  revert the burn and every constituent transfer atomically.
- The creator-license flow verifies the exact burn-sink balance increase and
  rejects short WOVEN transfers.
- State changes before external token calls are safe only because a revert rolls
  back the complete transaction and the guarded entry point cannot reenter.

## Required integrated-token assumptions

Every whitelisted constituent must be independently verified to:

- be the canonical BNB Chain contract at the intended chain ID;
- implement standard ERC-20 transfer and balance accounting;
- have no transfer tax, reflection, or positive/negative rebasing;
- have documented proxy or beacon implementation and administration plus pause,
  blacklist, freeze, seizure, mint, and upgrade controls;
- permit transfers from the basket contract to all intended eligible users;
- use recorded decimals, document ERC-8056 scaled-UI behavior where present,
  and retain stable raw transfer semantics;
- have primary-source custody, redemption, eligibility, and jurisdiction evidence.

These are security assumptions, not conveniences. Transfer-tax tokens cause
mint or redemption to revert rather than silently changing nominal amounts. A
negative rebase or seizure that creates a deficit blocks further minting, while
redemption remains callable for quantities the constituent can transfer exactly.
A blocklist or pause can still make a constituent temporarily or permanently
unredeemable. No constituent may be admitted until this review is complete.

ERC-8056 scaling changes the displayed amount while leaving raw `balanceOf`,
`totalSupply`, and transfer values unchanged. The Solidity core therefore keeps
raw-token backing, but a stale or incorrect UI conversion can cause a user to
review the wrong economic quantity. Integration tests and release records must
cover `uiMultiplier`, `toUIAmount`, `fromUIAmount`, and any multiplier-update
event for the final token implementation.

The WOVEN token must likewise be the exact Four.meme launch contract, have the
expected name, symbol, supply, and decimals, report graduated mode and renounced
ownership, and preserve standard transfer/balance behavior.

The one-click route additionally assumes that canonical USDC, USDT, PancakeSwap
v3, Uniswap v4 PoolManager/StateView/Quoter, Universal Router, and Permit2 retain
the reviewed bytecode and behavior. Pool existence does not imply adequate
depth. Deployment requires representative exact-output probe quotes, while each
user call still requires a fresh quote, bounded maxima, and a short deadline.
MEV, price movement, and liquidity withdrawal can make a valid quote fail; the
intended response is an atomic revert, not fallback to an unreviewed venue.
The buy-router deployment script pins USDC's EIP-1967 implementation and the
shared bStock beacon plus implementation in addition to proxy runtime code.
Those are deployment-time checks only: the external proxy administrators can
still upgrade the assets later, so continuous monitoring and an operational
delisting response remain required.

## Standards properties

- `BasketToken` inherits OpenZeppelin ERC-20 and must retain ERC-20 functions,
  return types, view modifiers, indexed `Transfer`/`Approval` events, and the
  standard allowance behavior.
- The normal ERC-20 approve race is not solved by the token contract. Clients
  should request exact allowances and use established wallet guidance when
  replacing a non-zero allowance.

## Incident and ordering assumptions

- A pending registry removal is visible in the mempool. A licensed creator could
  create a basket containing that asset before removal executes. Operational
  incident response must therefore also hide unsafe baskets in the UI and warn
  users; delisting cannot modify already-created baskets.
- Basket names and symbols are not unique. A copied or front-run name does not
  establish canonicality; interfaces must identify baskets by factory provenance
  and contract address.
- Basket recipes remain fixed-quantity and there is no rebalancing or protocol
  price oracle. The optional one-click router only performs route-bound
  exact-output swaps immediately before the existing in-kind mint. It does not
  change recipes, custody stock offchain, or use Binance account APIs.
- The router and adapters have no admin pause, upgrade, route replacement, or
  rescue function. A dependency or route incident must be handled by removing
  the affected basket from clients and deploying a newly reviewed immutable
  adapter/router set; existing basket redemption remains separate.
- The initial four-asset deployment route set does not support METAB and cannot
  execute the current TECH5 basket. The very thin PancakeSwap v2 TSLAB pool is
  deliberately excluded from the deployment script.
- `Woven Core Four` (`CORE4`) is the separately named launch basket whose fixed
  NVDAB, MSFTB, TSLAB, and QQQB recipe matches that initial route set. Its
  deployment script requires Safe registry admission, a licensed creator,
  raw units that roundtrip to exactly `0.01` displayed units per asset, current
  code-hash pins, and all four route outputs.
- The initial one-owner, one-signature Safe is a single-key operational risk.
  Repository tooling prepares unsigned transactions and verifies addresses; it
  must never receive the owner's private key or seed phrase.
- The browser and contracts contain no Binance Stocks REST API integration,
  exchange account, API key, or custodial purchase path. Admitted bStocks must
  already exist on BNB Chain; users either supply them in kind or fund the
  route-bound onchain purchase with their own USDC.

## Property-testing map

`test/BasketInvariant.t.sol` exercises arbitrary stateful mint/redeem sequences
and checks:

- backing covers all outstanding supply;
- total supply never exceeds either cap;
- the fixed composition never changes.

The existing unit/fuzz suite additionally checks license atomicity, canonical
asset gating, immutable fee routing, cap and pause authorization, redemption
during a mint pause, and mint/redeem backing.
`test/TokenIntegration.t.sol` verifies rejection of short incoming and outgoing
transfers, blocks minting after a seizure-created deficit, permits exact
redemption despite that mint blocker, and covers fully and over-backed mints.
`test/OneClickBasketRouter.t.sol` covers atomic multi-leg rollback, exact output,
per-leg and total maxima, canonical-factory and registry checks, stale adapter
code, deadline bounds, fee-on-transfer behavior, donation baselines, allowance
cleanup, and minimum basket output. Venue-adapter tests separately exercise
route immutability, quote wiring, dependency code-hash checks, exact spend and
refund accounting, and Uniswap Permit2 allowance cleanup for the v4 adapter.

Echidna was not available in the review environment: `command -v echidna-test`
returned no path (exit status 1). The Forge stateful invariant harness is the
active property-testing control until an Echidna campaign is added and run.
