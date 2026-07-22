# Deployment record template

Create one immutable copy of this record per network release. Replace every
placeholder with evidence from the same deployment run. A blank, inferred, or
cross-network value is a failed release gate.

## Release identity

| Field                     | Recorded value               |
| ------------------------- | ---------------------------- |
| Record schema             | `woven-deployment-record/v2` |
| Environment               | `testnet` or `mainnet`       |
| Chain ID                  | `97` or `56`                 |
| Git commit                | `REQUIRED`                   |
| Deployment UTC time       | `REQUIRED`                   |
| Foundry version           | `REQUIRED`                   |
| Solidity version          | `0.8.24`                     |
| Optimizer settings        | `REQUIRED`                   |
| OpenZeppelin version      | `5.6.1`                      |
| Owner wallet address      | `REQUIRED`                   |
| Deployment signer address | `REQUIRED`                   |
| Script transaction hashes | `REQUIRED`                   |
| Broadcast artifact digest | `REQUIRED`                   |

## Approved inputs

| Input               | Address or value | Evidence                                                                                                                     |
| ------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| WOVEN token         | `REQUIRED`       | Four.meme launch and graduation evidence; source, runtime-code hash, exact name, symbol, supply, decimals, mode, owner state |
| Expected Safe owner | `REQUIRED`       | Public owner address and owner-wallet approval record                                                                        |
| Protocol Safe       | `REQUIRED`       | Safe v1.4.1 singleton, one owner, threshold one, empty modules/guard, canonical fallback handler, creation transaction       |
| Treasury            | `REQUIRED`       | Must equal the protocol Safe                                                                                                 |
| Deployment signer   | `REQUIRED`       | Authorization and funded-gas check                                                                                           |
| Creator wallet      | `REQUIRED`       | Public creator address; license and CORE4 creation receipts                                                                  |
| USDC                | `REQUIRED`       | Canonical BNB Chain address, proxy implementation, runtime-code hash, decimals, transfer behavior                            |
| USDT                | `REQUIRED`       | Canonical BNB Chain address, runtime-code hash, decimals, transfer behavior                                                  |

## Core outputs

For every contract record the address, creation transaction, block number,
runtime-code hash, constructor arguments, and direct explorer-verification URL.

| Contract               | Address    | Creation transaction | Runtime-code hash | Explorer verified |
| ---------------------- | ---------- | -------------------- | ----------------- | ----------------- |
| CreatorLicense         | `REQUIRED` | `REQUIRED`           | `REQUIRED`        | `yes/no`          |
| CanonicalAssetRegistry | `REQUIRED` | `REQUIRED`           | `REQUIRED`        | `yes/no`          |
| FeeSplitter            | `REQUIRED` | `REQUIRED`           | `REQUIRED`        | `yes/no`          |
| CuratorGuardian        | `REQUIRED` | `REQUIRED`           | `REQUIRED`        | `yes/no`          |
| BasketFactory          | `REQUIRED` | `REQUIRED`           | `REQUIRED`        | `yes/no`          |

Record the read-back values for factory license, registry, splitter and guardian;
splitter factory; registry owner and pending owner; Safe owners and threshold;
treasury; WOVEN token; license amount and sink. Every value must match the
approved input set. Attach the JSON output from `npm run launch:verify` and
record that `TREASURY == PROTOCOL_SAFE`. Never attach a private key, seed phrase,
keystore, wallet export, authenticated RPC URL, or exchange credential.

## Atomic USDC router outputs

`DeployBuyRouter.s.sol` is a separate BNB-mainnet deployment. Record each
creation receipt and post-deployment read-back. A compiled artifact is not a
deployed address, and a successful quote is not a liquidity guarantee.

| Contract                    | Address or status             | Creation transaction | Runtime-code hash        | Constructor/read-back evidence | Explorer verified |
| --------------------------- | ----------------------------- | -------------------- | ------------------------ | ------------------------------ | ----------------- |
| UniswapV4ExactOutputAdapter | `REQUIRED`                    | `REQUIRED`           | `REQUIRED`               | `REQUIRED`                     | `yes/no`          |
| PancakeV3ExactOutputAdapter | `REQUIRED`                    | `REQUIRED`           | `REQUIRED`               | `REQUIRED`                     | `yes/no`          |
| OneClickBasketRouter        | `REQUIRED`                    | `REQUIRED`           | `REQUIRED`               | `REQUIRED`                     | `yes/no`          |
| PancakeV2ExactOutputAdapter | `not deployed in initial set` | `not applicable`     | artifact hash `REQUIRED` | dust-pool exclusion confirmed  | `not applicable`  |

The initial router must read back the selected USDC, BasketFactory, registry,
ordered adapter array, and adapter code hashes. The v4 adapter must read back
the official Universal Router 2.1.1, Permit2, V4Quoter, input token, route IDs,
route outputs, and route hashes. The v3 adapter must read back the PancakeSwap
SmartRouter, QuoterV2, input token, route IDs, route outputs, and route hashes.

### Route configuration

Record `CONFIRM_ROUTE_CONFIG_HASH`, its computation block and UTC time, and the
exact values below. The route ID column contains the resulting `bytes32`, not
only its preimage.

| Asset | Adapter        | Route-ID preimage                    | Route ID   | Route hash | Exact fixed path or pool keys                                                   | Pool IDs/addresses and liquidity observation | Output-token read-back |
| ----- | -------------- | ------------------------------------ | ---------- | ---------- | ------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------- |
| NVDAB | Uniswap v4     | `WOVEN:UNISWAP_V4:USDC:USDT:NVDAB:1` | `REQUIRED` | `REQUIRED` | USDC `(fee 2, spacing 1)` → USDT → NVDAB `(fee 20000, spacing 400)`, hooks zero | `REQUIRED`                                   | `REQUIRED`             |
| MSFTB | PancakeSwap v3 | `WOVEN:PANCAKE_V3:USDC:USDT:MSFTB:1` | `REQUIRED` | `REQUIRED` | reverse exact-output path MSFTB `(fee 2500)` → USDT `(fee 100)` → USDC          | `REQUIRED`                                   | `REQUIRED`             |
| TSLAB | Uniswap v4     | `WOVEN:UNISWAP_V4:USDC:USDT:TSLAB:1` | `REQUIRED` | `REQUIRED` | USDC `(fee 2, spacing 1)` → USDT → TSLAB `(fee 105, spacing 10)`, hooks zero    | `REQUIRED`                                   | `REQUIRED`             |
| QQQB  | PancakeSwap v3 | `WOVEN:PANCAKE_V3:USDC:USDT:QQQB:1`  | `REQUIRED` | `REQUIRED` | reverse exact-output path QQQB `(fee 100)` → USDT `(fee 100)` → USDC            | `REQUIRED`                                   | `REQUIRED`             |

Record one fresh pre-broadcast quote per route. The approved maximum must be the
same value supplied to the fail-closed script; do not replace a failing quote
with a different venue during deployment.

| Asset | `PROBE_RAW_OUTPUT_*` | `MAX_PROBE_USDC_IN_*` | Quoted USDC input | Gas estimate | Block number/hash | UTC time   | Quoter address/code hash |
| ----- | -------------------- | --------------------- | ----------------- | ------------ | ----------------- | ---------- | ------------------------ |
| NVDAB | `REQUIRED`           | `REQUIRED`            | `REQUIRED`        | `REQUIRED`   | `REQUIRED`        | `REQUIRED` | `REQUIRED`               |
| MSFTB | `REQUIRED`           | `REQUIRED`            | `REQUIRED`        | `REQUIRED`   | `REQUIRED`        | `REQUIRED` | `REQUIRED`               |
| TSLAB | `REQUIRED`           | `REQUIRED`            | `REQUIRED`        | `REQUIRED`   | `REQUIRED`        | `REQUIRED` | `REQUIRED`               |
| QQQB  | `REQUIRED`           | `REQUIRED`            | `REQUIRED`        | `REQUIRED`   | `REQUIRED`        | `REQUIRED` | `REQUIRED`               |

### Runtime-code and implementation pins

Create one row per environment key below. Record the resolved address, expected
and observed runtime-code hash, chain ID, block number/hash, UTC time, evidence
source, and reviewer. For proxy or beacon entries also record the storage slot,
resolved implementation, implementation code hash, and administrator or owner.

```text
EXPECTED_PROTOCOL_SAFE_CODEHASH
EXPECTED_WOVEN_CODEHASH
EXPECTED_CREATOR_LICENSE_CODEHASH
EXPECTED_ASSET_REGISTRY_CODEHASH
EXPECTED_FEE_SPLITTER_CODEHASH
EXPECTED_CURATOR_GUARDIAN_CODEHASH
EXPECTED_BASKET_FACTORY_CODEHASH
EXPECTED_ONE_CLICK_ROUTER_CODEHASH
EXPECTED_UNISWAP_V4_ADAPTER_CODEHASH
EXPECTED_PANCAKE_V3_ADAPTER_CODEHASH
EXPECTED_USDC_CODEHASH
EXPECTED_USDT_CODEHASH
EXPECTED_USDC_IMPLEMENTATION_CODEHASH
EXPECTED_BSTOCK_BEACON_CODEHASH
EXPECTED_BSTOCK_IMPLEMENTATION_CODEHASH
EXPECTED_NVDAB_CODEHASH
EXPECTED_MSFTB_CODEHASH
EXPECTED_TSLAB_CODEHASH
EXPECTED_QQQB_CODEHASH
EXPECTED_PANCAKE_V3_ROUTER_CODEHASH
EXPECTED_PANCAKE_V3_FACTORY_CODEHASH
EXPECTED_PANCAKE_V3_QUOTER_CODEHASH
EXPECTED_PANCAKE_V3_MSFTB_POOL_CODEHASH
EXPECTED_PANCAKE_V3_QQQB_POOL_CODEHASH
EXPECTED_PANCAKE_V3_STABLE_POOL_CODEHASH
EXPECTED_UNISWAP_V4_POOL_MANAGER_CODEHASH
EXPECTED_UNISWAP_V4_STATE_VIEW_CODEHASH
EXPECTED_UNISWAP_V4_QUOTER_CODEHASH
EXPECTED_UNISWAP_UNIVERSAL_ROUTER_CODEHASH
EXPECTED_UNISWAP_PERMIT2_CODEHASH
```

| Environment key | Address    | Expected code hash | Observed code hash | Proxy/beacon resolution        | Block and UTC time | Evidence and reviewer |
| --------------- | ---------- | ------------------ | ------------------ | ------------------------------ | ------------------ | --------------------- |
| `REQUIRED`      | `REQUIRED` | `REQUIRED`         | `REQUIRED`         | `REQUIRED` or `not applicable` | `REQUIRED`         | `REQUIRED`            |

## Canonical constituent admission

Create one row per admitted token. Attach primary-source evidence rather than a
ticker search result. Record only officially issued bStock contracts that were
independently checked on the selected chain. Issuer provenance does not by
itself prove continued transferability, user eligibility, custody, or redemption.

| Field                                            | Recorded value              |
| ------------------------------------------------ | --------------------------- |
| Issuer/product and symbol                        | `REQUIRED`                  |
| Token contract and chain                         | `REQUIRED`                  |
| Raw decimals and runtime-code hash               | `REQUIRED`                  |
| ERC-8056 multiplier and input/display roundtrip  | `REQUIRED` or `not present` |
| Proxy/beacon implementation and admin            | `REQUIRED` or `not a proxy` |
| Transfer-tax/rebase result                       | `REQUIRED`                  |
| Pause, blacklist, freeze and seizure controls    | `REQUIRED`                  |
| Custody/redemption and jurisdiction restrictions | `REQUIRED`                  |
| Testnet/integration transaction hashes           | `REQUIRED`                  |
| Reviewer, approval and UTC date                  | `REQUIRED`                  |

## Woven Core Four deployment

CORE4 is the initial featured basket covered by all four recorded routes. Do
not reuse this section for TECH5; the initial adapter set has no METAB route.

| Field                                                         | Recorded value                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Name / symbol                                                 | `Woven Core Four` / `CORE4`                                                                                 |
| Constituent order                                             | `NVDAB,MSFTB,TSLAB,QQQB`                                                                                    |
| Displayed unit per asset                                      | `10000000000000000` scaled UI units (`0.01` at 18 UI decimals)                                              |
| Raw units                                                     | `REQUIRED` for each asset, derived with current `fromUIAmount(1e16)` and round-tripped through `toUIAmount` |
| Mint fee                                                      | `30` bps                                                                                                    |
| Initial / maximum supply cap                                  | `1000e18` / `1000000e18`                                                                                    |
| Expected factory basket count before / after                  | `REQUIRED` / `REQUIRED`                                                                                     |
| `CONFIRM_CORE_FOUR_CONFIG_HASH`                               | `REQUIRED` with block and UTC time                                                                          |
| Registry Safe `setAssets` transaction                         | `REQUIRED` successful receipt                                                                               |
| Creator WOVEN approval transaction                            | `REQUIRED` successful receipt                                                                               |
| Creator `burnForLicense` transaction                          | `REQUIRED` successful receipt and dead-address balance delta                                                |
| CORE4 creation transaction and address                        | `REQUIRED` successful receipt                                                                               |
| CORE4 runtime-code hash and verification                      | `REQUIRED`                                                                                                  |
| Factory and FeeSplitter creator read-back                     | `REQUIRED`                                                                                                  |
| Constituent/raw-unit/fee/cap/guardian/fee-recipient read-back | `REQUIRED`                                                                                                  |
| `VITE_BASKET_CORE4`                                           | `REQUIRED`, exact confirmed address                                                                         |
| `VITE_BASKET_CORE4_UNITS_RAW`                                 | `REQUIRED`, read-back values in the documented order                                                        |

## Web release

Record the Vercel deployment ID and URL, production domain, selected network,
every public contract-address value including `VITE_USDC`,
`VITE_ONE_CLICK_ROUTER`, `VITE_BASKET_CORE4`, and the confirmed CORE4 raw-unit
array, Git commit, build log, asset digest, header probe, and desktop/mobile test
evidence.

For the low-value mainnet canary, record the quote block, signed maximums,
deadline, transaction hash/status, payer USDC debit and refund, net CORE4 output,
all four constituent output requirements, and final zero session-residual checks
for the router and adapters. A simulated fork or quote is not a mainnet canary.
Never place private keys, authenticated RPC URLs, passwords, or API tokens in
this record.

## Sign-off

| Responsibility               | Approver   | UTC date   | Evidence link |
| ---------------------------- | ---------- | ---------- | ------------- |
| Contract engineering         | `REQUIRED` | `REQUIRED` | `REQUIRED`    |
| Independent security review  | `REQUIRED` | `REQUIRED` | `REQUIRED`    |
| Safe and treasury operations | `REQUIRED` | `REQUIRED` | `REQUIRED`    |
| External-asset review        | `REQUIRED` | `REQUIRED` | `REQUIRED`    |
| Legal/jurisdiction review    | `REQUIRED` | `REQUIRED` | `REQUIRED`    |
| Web release                  | `REQUIRED` | `REQUIRED` | `REQUIRED`    |
