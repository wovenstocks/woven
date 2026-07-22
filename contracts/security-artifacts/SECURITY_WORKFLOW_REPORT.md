# Woven Security Workflow Report

Date: 2026-07-22
Scope: production contracts in `src/`, all three deployment scripts, relevant
tests, and the initial CORE4 exact-output route profile
Deployment evidence: no deployed Woven addresses, receipts, verified-source
records, signed configuration hashes, or mainnet canary were reviewed
Control-plane evidence: protocol Safe
`0xF97FC34f97E556271E824D4011A02E5Fa78658fE` and creation transaction
`0xeaac144ce794eccd7e3509bf478d745c97f80a1ee00a87bf5ffe213e5768c948`
with expected owner `0x9b32E54046e0061a0139C62827B76CF2f19e1DfC` passed the
pinned BNB mainnet Safe profile and proxy-factory evidence checks. The profile
was re-read on block `111427186`
(`0x38f2e9fb5c932b6c0b5933bfbeaf483ededc7295098b791ca519a3764620e525`,
2026-07-22T06:30:46Z)
Tools: Forge 1.7.1, Slither 0.11.5, OpenZeppelin Contracts 5.6.1

## Executive result

- Confirmed critical findings: 0
- Confirmed high findings: 0
- Conditional medium risk: external token, proxy, compliance, custody, and DEX
  dependency behavior
- Low operational risks: registry ordering, metadata impersonation, MEV and
  route availability, and immutable-router incident response
- Informational: Slither, ERC conformance, complexity, assembly, and
  deployment-script observations documented below

This is a repository-level engineering review, not an independent audit and not
proof of mainnet readiness. Slither emitted 21 High-impact
`reentrancy-balance` detector instances. They are preserved and triaged below;
they are not omitted from the evidence. A live release still requires the
deployment record, current external dependency checks, receipts, verified
bytecode, legal review, monitoring, and a low-value mainnet canary.

## Step 1: Slither triage

The production scan analyzed 55 contracts with 100 detectors and emitted 56
result instances: 21 High, 0 Medium, 23 Low, and 12 Informational. No result was
silently discarded. CI excludes only `reentrancy-balance` from its High-failure
gate and executes that detector again into a separate JSON artifact with
`--fail-none`; every other High detector remains release-blocking.

| Detector                | Raw impact / instances | Triage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ---------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reentrancy-balance`    |              High / 21 | Slither reports balance reads around external calls in `OneClickBasketRouter.mintWithUsdc` and each adapter's `swapExactOutput`. All four entry points are `nonReentrant`. The router accepts only constructor-pinned adapter code hashes, and adapters pin their venue dependencies. Exact caller debit, spend, output, refund, allowance cleanup, and final baseline checks cause inconsistent callbacks or balance changes to revert atomically. This is a scanner false positive for reentrant state corruption in the reviewed code. Any future removal of the guard, code-hash binding, or delta checks reopens the finding and must fail review. |
| `calls-loop`            |               Low / 17 | Core loops are bounded by 20 constituents. One-click execution is bounded by 8 constituents; adapter paths and the initial deployment route set are also bounded. External-call failure reverts the transaction.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `reentrancy-events`     |                Low / 2 | Guardian calls are Safe-admin-only, store no mutable guardian state, validate the target, verify post-call state, then emit success.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `timestamp`             |                Low / 4 | Timestamps enforce user deadlines. The router additionally caps the deadline window at 20 minutes; per-leg and total USDC maxima remain the price protection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `assembly`              |      Informational / 2 | Pancake v3 path readers decode fixed packed addresses and fees after constructor and runtime length checks. Deployment-script copies are scanned separately.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `cyclomatic-complexity` |      Informational / 7 | Complexity is concentrated in fail-closed constructors and atomic settlement paths. Tests cover rejection branches, rollback, refunds, and cleanup; complexity remains a manual-review cost.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pragma`                |      Informational / 1 | Production contracts pin 0.8.24. Dependency source uses compatible ranges and the Foundry profile selects 0.8.24.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `missing-inheritance`   |      Informational / 2 | Slither suggests explicit inheritance from local structural interfaces. Implementations expose the required selectors; moving interfaces would improve structure but add no runtime control.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Separate deployment scans were executed with the same documented
`reentrancy-balance` split:

| Script                  | Contracts analyzed | High findings after the documented exclusion |
| ----------------------- | -----------------: | -------------------------------------------: |
| `DeployCore.s.sol`      |                 63 |                                            0 |
| `DeployBuyRouter.s.sol` |                 57 |                                            0 |
| `DeployCoreFour.s.sol`  |                 32 |                                            0 |

Deployment-script findings are dominated by bounded validation loops,
dependency pragma/naming output, intentionally ignored quote fields, and
forge-std unused constants. `DeployBuyRouter` packed-path assembly is the same
fixed-width decode pattern used by the reviewed v3 adapter. The deployment
scripts are operational controls, not substitutes for current-chain evidence.

## Step 2: special features

### Upgradeability

Explicit searches for `delegatecall`, UUPS, ERC-1967 proxy implementations,
diamonds, initializers, and upgrade functions found no upgrade mechanism in
Woven production contracts. The core, router, adapters, and baskets use
constructor-bound immutable wiring, so `slither-check-upgradeability` has no
Woven proxy/implementation pair to evaluate.

This does not extend to external assets. USDC and the reviewed bStocks use
external proxy or beacon mechanisms. `DeployBuyRouter` and `DeployCoreFour`
check the reviewed EIP-1967 implementation or beacon slots and runtime code
hashes at deployment time. External administrators can upgrade later;
continuous monitoring, UI delisting, and a newly reviewed immutable router are
the required response.

### ERC-20 conformance

`slither-check-erc contracts BasketToken --erc ERC20` passed required ERC-20
functions, return types, view modifiers, and indexed events. It reports only
the standard ERC-20 approval replacement race inherited from OpenZeppelin.
Clients should use exact approvals and standard non-zero allowance replacement
guidance.

### Token integration

**Medium, conditional on admission:** registry inclusion proves only that the
Safe selected an address with code. Basket mint and redeem measure exact balance
deltas, so ordinary transfer-tax behavior reverts instead of silently changing
backing. A blacklist, pause, seizure, negative rebase, hostile proxy upgrade,
country restriction, custody failure, or offchain redemption failure can still
block or impair redemption.

ERC-8056 changes displayed amounts while raw balances and transfers remain the
contract accounting unit. CORE4 derives each raw unit from the current
`fromUIAmount(1e16)` result and requires the exact `toUIAmount` roundtrip. That
deployment-time conversion does not remove later multiplier or upgrade risk;
the confirmed raw recipe must be recorded and pinned in the web build.

### Core and route deployment validation

All three deployment scripts use one shared, fail-closed Safe v1.4.1 profile.
It pins the Safe proxy, singleton, proxy-factory, and fallback-handler runtime
code hashes and verifies one expected owner, threshold one, no modules or guard,
the canonical fallback handler, and treasury identity. Historical creation
provenance is checked separately by the required launch preflight transaction
evidence. `DeployCore.s.sol` additionally validates WOVEN graduation and
ownership renunciation plus complete core wiring.

`DeployBuyRouter.s.sol` is BNB-mainnet-only. Before broadcast it validates
current runtime code hashes, USDC and bStock implementation/beacon slots,
factory/registry wiring, fixed pool keys or addresses, non-zero liquidity,
four exact-output quote probes and ceilings, and a confirmed configuration
hash. Its initial routes cover NVDAB and TSLAB through hook-free Uniswap v4 and
MSFTB and QQQB through PancakeSwap v3. The dust-sized PancakeSwap v2 TSLAB route
is deliberately excluded.

`DeployCoreFour.s.sol` fixes the public basket to Woven Core Four (`CORE4`),
ordered NVDAB/MSFTB/TSLAB/QQQB constituents, 30 bps mint fee, 1,000-token initial
cap, and 1,000,000-token maximum cap. It requires Safe registry admission, a
licensed creator, current code-hash pins, all four route outputs, exact
ERC-8056 unit conversion, an unchanged factory count, and a separately confirmed
configuration hash. It does not make TECH5 executable because the initial route
set has no METAB route.

## Step 3: visual inspection

Slither's inheritance, function-summary, and vars-and-auth printers were
executed against the expanded production scope. The raw local files remain
ignored; the reviewed diagrams are versioned as:

- `inheritance-diagram.md`
- `function-summary-diagram.md`
- `vars-and-auth-diagram.md`

Inspection found no unexpected Woven proxy storage layout or admin writer. The
router and adapters have no route setter, admin withdrawal, rescue, pause,
upgrade, or arbitrary-call entry point. Their routes, dependencies, and code
hashes are constructor-bound. Slither's compact diagrams do not consistently
show every inherited interface or `ReentrancyGuard` edge, so those bases and
the inherited registry `onlyOwner` condition were confirmed directly in source
and are called out in the reviewed diagrams.

## Step 4: properties and stateful fuzzing

Project-specific invariants and external assumptions are documented in
`../SECURITY_PROPERTIES.md`. Echidna is not installed; the active property
control is the native Forge stateful invariant harness.

`forge test --summary` reported 108 passed and 0 failed across twelve suites. Three
of those test functions are opt-in BSC fork smoke tests that return immediately
unless their explicit fork flag is enabled; the default run therefore executes
105 substantive local unit, fuzz, integration, and invariant tests. The complete
CORE4 fork flow was also run explicitly against BNB Chain state at block 111417608. It derives the four raw basket units through
`fromUIAmount(1e16)`, quotes all four configured legs, and exercises the atomic
USDC-to-CORE4 mint path. This fork result is route evidence for that historical
block, not a mainnet transaction or a guarantee of current liquidity.

| Suite                             |    Tests | Coverage focus                                                                                      |
| --------------------------------- | -------: | --------------------------------------------------------------------------------------------------- |
| `BasketInvariantTest`             |        3 | 256 runs and 16,384 calls per invariant for backing, caps, and immutable recipe                     |
| `DeployCoreValidationTest`        |        7 | WOVEN, pinned Safe runtime, and launch profile                                                      |
| `DeployCoreFourValidationTest`    |        3 | Settled registry ownership and pending-owner rejection                                              |
| `TestnetFixtureDeploymentTest`    |        5 | Chain-97-only fixtures and complete core license/create/mint/fee/redeem flow                        |
| `WovenPlatformTest`               |       17 | licensing, factory, guardian, fees, mint/redeem, 1,000 backing fuzz cases                           |
| `TokenIntegrationTest`            |        7 | short transfers, seizure deficits, exact redemption, 1,000 deficit fuzz cases                       |
| `OneClickBasketRouterTest`        |       23 | atomic rollback, maxima, deadlines, provenance, adapter code hashes, reentrancy, refunds, residuals |
| `PancakeV2ExactOutputAdapterTest` |       10 | immutable routes, spend/output/refund accounting, rollback, code changes                            |
| `PancakeV3ExactOutputAdapterTest` |       12 | packed reverse paths, quote validation, swap dependencies, accounting and rollback                  |
| `UniswapV4ExactOutputAdapterTest` |       18 | hook-free path, Universal Router/Permit2, reentrancy, allowance cleanup, exact deltas               |
| `UniswapV4BscForkTest`            | 2 opt-in | live-route quote/swap smoke when explicitly enabled with an RPC                                     |
| `CoreFourRouterBscForkTest`       | 1 opt-in | complete four-leg USDC-to-CORE4 route at a pinned or current BNB Chain fork                         |

A green local run does not prove the final mainnet route state, deployed
bytecode, signer permissions, legal eligibility, or a mainnet canary.

## Step 5: manual review

### Privacy and secrets

No onchain secret is expected. Basket recipes, route IDs, creator addresses,
balances, license activity, and limits are public. Repository workflows use
public addresses and unsigned preparation or external-keystore signing; private
keys, seed phrases, authenticated RPC URLs, and exchange credentials must not
enter release evidence.

### MEV and ordering

Core in-kind mint and redemption do not depend on an oracle price. The optional
USDC route is price-sensitive. It uses exact output, per-leg maxima, an exact
total maximum, a minimum net basket output, and a short deadline. A sandwich,
price move, or liquidity withdrawal can consume value up to the user's approved
maximum or make the complete transaction revert. There is no fallback to an
unreviewed route.

Registry removals remain mempool-visible and affect future creation or routed
mint checks, not the composition or redemption logic of existing baskets. UI
delisting and communication are part of incident response. Names and symbols
are not unique; factory provenance and contract address define canonicality.

### Cryptography

Production contracts contain no randomness, custom signature recovery, or
secret-key handling. `keccak256` derives route IDs, route hashes, pool IDs, and
deployment configuration commitments; those hashes bind reviewed data but do
not authorize a signer or prove external truth.

### DeFi dependencies and incident response

The one-click path depends on canonical USDC/USDT behavior, approved bStock
transferability, PancakeSwap or Uniswap liquidity, quoter correctness,
Universal Router, Permit2, PoolManager, and immutable adapter paths. Code-hash
checks detect bytecode changes at deployment or execution where implemented;
they do not guarantee liquidity, price, issuer solvency, custody, or later proxy
state.

The router and adapters have no admin pause or upgrade path. If a dependency,
route, or external asset becomes unsafe, clients must stop exposing affected
buys, preserve redemption where the constituent permits it, and deploy a newly
reviewed immutable adapter/router set. No frontend change repairs an already
deployed contract.

## Engineering conclusion

The expanded source scope has no confirmed critical or high issue from this
workflow, and the current local test suite passes. This result does **not**
establish mainnet readiness. The release remains blocked until the complete v2
deployment record contains signed transactions, runtime code hashes, route and
probe observations, CORE4 read-backs, source verification, independent review,
and a successful low-value mainnet canary.
