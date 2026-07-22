# Woven BNB contract core

This directory contains source, tests, and deployment validation. It does not
include a deployed-address record.

This directory contains Woven's minimal fixed-basket architecture for BNB Smart Chain:

- `BasketToken`: immutable, in-kind mint and redeem with fixed raw constituent units.
- `CreatorLicense`: permanently moves exactly 10,000 `$WOVEN` tokens to an immutable burn sink; one license lets its owner publish multiple fixed baskets.
- `CanonicalAssetRegistry`: Safe-controlled allowlist used only when creating new baskets.
- `BasketFactory`: deploys only licensed, canonical-asset baskets.
- `CuratorGuardian`: lets the protocol Safe raise supply caps and pause or resume
  new mints; it cannot block redemption, redirect fees, or touch funds.
- `FeeSplitter`: immutable 60% creator / 40% treasury routing of mint-fee basket tokens.
- `OneClickBasketRouter`: atomically acquires every required constituent with a
  bounded amount of USDC and mints a canonical basket; any failed leg reverts
  the complete transaction.
- `UniswapV4ExactOutputAdapter` and `PancakeV3ExactOutputAdapter`: immutable,
  exact-output, route-bound venue adapters. Callers cannot choose arbitrary
  targets, selectors, recipients, hooks, or calldata.

## Verified locally

```bash
npm run contracts:build
npm run contracts:test
```

The tests cover the creator license transfer, repeat basket publishing,
fake-asset rejection, exact constituent backing, immutable fee routing,
Safe-controlled mint pause with uninterrupted redemption, fee-on-transfer
rejection in both directions, deficit-gated minting, exact redemption,
mint/redeem, and 1,000 fuzzed backing roundtrips.

### Local and BSC-testnet token fixtures

`script/testnet/DeployTestnetFixtures.s.sol` deploys one fixed-supply
WOVEN-compatible token and four fixed-supply, identity-scaled ERC-8056 fixtures
for NVDAB, MSFTB, TSLAB, and QQQB. It removes any dependency on a real
Four.meme launch or real bStocks while exercising the testnet core. The fixture
bStock names contain `TESTNET FIXTURE`, all five contracts expose
`isTestnetFixture()`, and their constructors permit only chain ID `97` or local
Anvil chain ID `31337`. They cannot be deployed on BNB mainnet.

The fixtures model standard ERC-20 transfers and an identity UI multiplier.
They do not model issuer controls, legal eligibility, custody, backing,
liquidity, proxy upgrades, pauses, freezes, or seizures, and must never be used
as mainnet release evidence. Their exact-symbol metadata exists only to exercise
the same application and core mappings used by the intended assets.

Run the reproducible deployment and complete core-flow tests locally:

```bash
forge test --root contracts --match-path test/TestnetFixtureDeployment.t.sol
```

For BSC testnet, simulate first with a public recipient and no signing option:

```bash
cd contracts
export CONFIRM_TESTNET_FIXTURE_DEPLOY=true
export FIXTURE_EXPECTED_CHAIN_ID=97
export TESTNET_FIXTURE_RECIPIENT=0xREPLACE_WITH_PUBLIC_TESTNET_ADDRESS

forge script script/testnet/DeployTestnetFixtures.s.sol:DeployTestnetFixtures \
  --rpc-url "$WOVEN_BNB_RPC_URL" \
  --sender 0xREPLACE_WITH_DEPLOYER
```

Only after reviewing that simulation, add the external testnet signer and
`--broadcast`. The script prints the five testnet addresses; the WOVEN fixture
can then be supplied to `DeployCore`, and the four asset fixtures can be
admitted by the testnet registry owner for the low-value test flow. The
production router and CORE4 deployment scripts remain BNB-mainnet-only and do
not accept these fixtures.

## Tokenomics encoded here

- Deployment-script requirement: exactly 1,000,000,000 WOVEN with 18 decimals; the script refuses any other `totalSupply()` or `decimals()` value.
- Permanent creator license: exactly 10,000 WOVEN (0.001% of the required supply) moved once from the creator to the immutable burn sink.
- The sink transfer removes those tokens from circulation. It does **not** call an ERC-20 burn function and therefore does not reduce `totalSupply()`.
- A licensed creator can publish multiple immutable, fixed-composition baskets without another license payment.
- Application mint-fee convention: 30 bps. `BasketToken` enforces a 50 bps ceiling.
- Mint-fee basket tokens: 60% to the creator and 40% to the treasury.
- In-kind redemption protocol fee: 0%.

## Deployment-script safeguards

`script/DeployCore.s.sol` requires all of the following and refuses other chain IDs:

- `CONFIRM_DEPLOY=true`
- `EXPECTED_CHAIN_ID=56` for BNB mainnet or `97` for testnet
- `WOVEN_TOKEN`, with name `Woven Stocks`, symbol `WOVEN`, exactly
  `1_000_000_000e18` total supply, 18 decimals, Four.meme `_mode() == 0`, and
  `owner() == address(0)`
- `PROTOCOL_SAFE`, which must be a canonical Safe v1.4.1 proxy using the expected
  Safe L2 singleton and compatibility fallback handler, pinned proxy, singleton,
  proxy-factory, and fallback-handler runtime code hashes, one owner, threshold
  one, no modules, and no guard
- `EXPECTED_SAFE_OWNER`, the single public Safe owner address
- `TREASURY`, which must equal `PROTOCOL_SAFE`
- the license sink is hard-coded in `CreatorLicense` as `0x000000000000000000000000000000000000dEaD`; deployment cannot redirect it

The script reads the deployed WOVEN and Safe state before broadcast and asserts
the complete core wiring after deployment. Run the repository's unsigned
preparation and read-only preflight before the Foundry script:

```bash
npm run safe:prepare -- --network mainnet --owner 0xPUBLIC_OWNER
npm run launch:verify -- \
  --network mainnet \
  --owner 0xPUBLIC_OWNER \
  --safe 0xPROTOCOL_SAFE \
  --safe-creation-tx 0xSAFE_CREATION_TRANSACTION \
  --woven 0xWOVEN_TOKEN
```

`safe:prepare` emits an unsigned Safe creation transaction. Neither command
requests a private key or seed phrase. The owner wallet reviews and signs every
onchain transaction; secrets must remain outside this repository.

### USDC buy-router deployment gate

`script/DeployBuyRouter.s.sol` is a separate, BNB-mainnet-only deployment. It
hard-codes the reviewed four-asset route set and canonical venue addresses:

| Asset | Exact-output path                                                                         |
| ----- | ----------------------------------------------------------------------------------------- |
| NVDAB | Uniswap v4: USDC `(fee 2, spacing 1)` → USDT → NVDAB `(fee 20000, spacing 400)`, no hooks |
| TSLAB | Uniswap v4: USDC `(fee 2, spacing 1)` → USDT → TSLAB `(fee 105, spacing 10)`, no hooks    |
| MSFTB | PancakeSwap v3 reverse path: MSFTB `(fee 2500)` → USDT `(fee 100)` → USDC                 |
| QQQB  | PancakeSwap v3 reverse path: QQQB `(fee 100)` → USDT `(fee 100)` → USDC                   |

The deployment deliberately does not use the dust-sized PancakeSwap v2 TSLAB
pair. It also does not make the current TECH5 product executable because TECH5
contains METAB and this immutable adapter set has no METAB route. Supporting
that basket requires a separately reviewed route and a new router deployment.
Woven does not pre-fund USDC or bStock inventory for this flow: every call pulls
the caller's approved USDC, buys exact constituent outputs from the external
DEX pools, mints atomically, and refunds unused USDC. Registry admission is an
asset-safety gate, not protocol-provided liquidity; the external pools must
remain sufficiently liquid for the user transaction to succeed.

Before `vm.startBroadcast`, the script requires:

- `CONFIRM_DEPLOY=true`, `CONFIRM_INITIAL_FOUR_ASSET_ROUTE_SET=true`, and
  `EXPECTED_CHAIN_ID=56`;
- `PROTOCOL_SAFE` plus `EXPECTED_SAFE_OWNER`; the complete pinned Safe profile
  is revalidated immediately before deployment;
- the deployed `BASKET_FACTORY` and `ASSET_REGISTRY`, matching factory wiring,
  registry support for all four assets, exact ERC-20 symbols and decimals, and
  ERC-8056 interface plus conversion roundtrip checks;
- explicit expected runtime code hashes for USDC, its EIP-1967 implementation,
  USDT, every bStock proxy, the shared bStock beacon and implementation, the
  core contracts, PancakeSwap router/factory/quoter/pools, and Uniswap
  PoolManager, StateView, V4Quoter, Universal Router 2.1.1, and Permit2. The
  script also requires USDC's implementation slot and every bStock's beacon
  slot to match those reviewed addresses at deployment time;
- initialized, non-zero-liquidity canonical pools returned by the fixed factory
  or PoolManager/StateView configuration;
- `PROBE_RAW_OUTPUT_{NVDAB,MSFTB,TSLAB,QQQB}` and
  `MAX_PROBE_USDC_IN_{NVDAB,MSFTB,TSLAB,QQQB}`. Each exact-output quote must
  succeed and remain below its asset-specific USDC ceiling. Probe amounts must
  cover at least the largest intended default one-click leg and cannot be
  reduced below `1e16` raw bStock units;
- `CONFIRM_ROUTE_CONFIG_HASH`, which commits to every address, code hash, pool
  key, path, probe amount, and price ceiling.

Run without `--broadcast` first. With `CONFIRM_ROUTE_CONFIG_HASH` unset, the
script prints the computed hash and then stops. Re-run the full read-only
preflight immediately before any owner-reviewed broadcast; a stale or newly
illiquid route must remain blocked. The probe is a deployment sanity gate, not
a permanent liquidity guarantee. Every user transaction still needs a fresh
quote, per-leg maxima, a total maximum, and a short deadline.

### Woven Core Four launch basket

`script/DeployCoreFour.s.sol` creates the first featured basket that is fully
covered by the initial immutable route set. Its public identity and economic
limits are fixed in source:

- name `Woven Core Four`, symbol `CORE4`;
- constituents, in order: NVDAB, MSFTB, TSLAB, QQQB;
- 30 bps mint fee;
- 1,000 CORE4 initial supply cap and 1,000,000 CORE4 immutable maximum cap.

The release order is: deploy and verify the core; complete the bStock review;
admit the four assets with the registry-owning Safe; deploy and verify the
four-route buy router; complete the creator license; then deploy CORE4. The buy
router and CORE4 scripts both stop if an earlier step is missing or changed.

Each CORE4 token represents exactly `0.01` displayed NVDAB, MSFTB, TSLAB, and
QQQB at deployment. The script derives the corresponding raw quantities from
each live bStock's ERC-8056 conversion helper and rejects zero values, inexact
display/raw roundtrips, or a result that does not display as exactly `0.01`.
The derived raw units are committed by the configuration hash and verified
again after deployment.

Before basket creation, submit one reviewed Safe transaction with the
`CanonicalAssetRegistry` as target, zero BNB value, normal `CALL` operation,
and this calldata:

```bash
cast calldata "setAssets(address[],bool)" \
  "[0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436,0x80106cb3EAD06659A5ad19DF39D9b4733863B9b0,0x5b1910eAaD6450E50f816082Aa078C41F10C292f,0x205812CdBed920aFf76C6580abD681a46D11efc7]" \
  true
```

This command only encodes calldata. The Safe owner must review, sign, execute,
and retain the successful receipt. Do not admit the assets before the issuer,
proxy, ERC-8056, transfer-control, custody, redemption, and jurisdiction review
described below is complete.

The creator wallet must also have completed the existing license flow: approve
exactly `10_000e18` WOVEN to `CreatorLicense`, then call `burnForLicense()`.
Calldata can be prepared without sending either transaction:

```bash
cast calldata "approve(address,uint256)" "$CREATOR_LICENSE" 10000000000000000000000
cast calldata "burnForLicense()"
```

After both receipts confirm, configure the deployed core/router addresses,
`EXPECTED_CREATOR`, the current factory `basketCount`, and all
`EXPECTED_*_CODEHASH` pins required by the script. Its deployment-time
checks repeat the complete Safe profile, core wiring, WOVEN graduation, registry
ownership with no pending owner, registry support, license state, proxy/beacon
implementations, adapter code hashes, and all four route outputs. First run
without `--broadcast` and with
`CONFIRM_CORE_FOUR_CONFIG_HASH` unset to obtain the complete configuration
hash. Confirm that hash, run another no-broadcast simulation, and only then use
an owner-controlled external signer for the reviewed broadcast.

The pre-deployment environment is:

```dotenv
CONFIRM_DEPLOY=true
CONFIRM_CORE_FOUR_LAUNCH=true
EXPECTED_CHAIN_ID=56
PROTOCOL_SAFE=
EXPECTED_SAFE_OWNER=
WOVEN_TOKEN=
CREATOR_LICENSE=
ASSET_REGISTRY=
FEE_SPLITTER=
CURATOR_GUARDIAN=
BASKET_FACTORY=
ONE_CLICK_ROUTER=
UNISWAP_V4_ADAPTER=
PANCAKE_V3_ADAPTER=
EXPECTED_CREATOR=
EXPECTED_CORE_FOUR_FACTORY_BASKET_COUNT=
CONFIRM_CORE_FOUR_CONFIG_HASH=
```

The code-hash variables are intentionally additional gates; consult
`_loadCodehashPins()` in the script for the exact names and populate each from
the same reviewed, current-chain evidence record. After the receipt and
post-deployment assertions pass, map only the read-back values into the web
build:

```dotenv
VITE_BASKET_CORE4=0xCONFIRMED_CORE4_ADDRESS
VITE_BASKET_CORE4_UNITS_RAW=NVDAB_RAW,MSFTB_RAW,TSLAB_RAW,QQQB_RAW
```

`EXPECTED_CORE_FOUR_FACTORY_BASKET_COUNT` prevents a stale or repeated run from
silently creating another basket. CORE4 does not make TECH5 executable; TECH5
still requires a separately reviewed METAB route and a new immutable adapter
and router deployment.

No bStock is trusted automatically. The Safe must add only independently
verified, officially issued BNB Chain bStock contracts after deployment. Do not
publish or fund a basket until primary provenance, deployed bytecode, transfer
behavior, decimals, ERC-8056 scaled-UI conversion, proxy or beacon control,
blacklist/pause/seizure powers, jurisdiction limits, custody, and redemption
behavior are recorded and reviewed. The contracts account in raw ERC-20 units;
the current ERC-8056 multiplier affects display conversion, not the immutable
raw recipe.

## Capabilities and evidence outside this repository

- No deployment record or verified mainnet address set.
- Source code now includes an atomic USDC exact-output route, but there is no
  deployed router, signed deployment, funded mainnet canary, or continuous
  liquidity guarantee.
- No Binance Stocks REST API integration in the browser or backend, exchange API
  key, operator trading account, or custodial trading service. A smart contract
  cannot call an exchange REST API, and exchange trading is not an atomic
  onchain mint.
- No independent audit or legal approval.
- No guarantee that an external issuer, proxy administrator, or compliance
  operator will keep a bStock transferable or redeemable for a particular user.

## Upstream

The backing, rounding, restricted-guardian, factory, and fee-split concepts are adapted from the MIT-licensed Vimen protocol. See `THIRD_PARTY_NOTICES.md` and `LICENSE-VIMEN`.
