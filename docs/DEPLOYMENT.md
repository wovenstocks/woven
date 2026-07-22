# Deployment

Web and contract deployment are separate release operations. Publishing the web
application does not deploy, verify, or activate any smart contract.

## Deployment inputs

Before a contract deployment, the operator must provide:

- the final WOVEN token address after the Four.meme launch has graduated;
- one public owner-wallet address and the canonical 1-of-1 protocol Safe it owns;
- a funded deployment signer with enough BNB for gas;
- independently verified constituent contract addresses and restrictions.

The same Safe is used as `PROTOCOL_SAFE` and `TREASURY`. The owner wallet may
also be the deployment signer, but only its public address belongs in commands
or records. Never paste or commit a private key, seed phrase, keystore password,
wallet-export file, authenticated RPC credential, or exchange credential.

## One-wallet Safe preparation

The supported initial control profile is a canonical Safe v1.4.1 proxy with one
owner, threshold one, no modules, no guard, and the canonical compatibility
fallback handler. This keeps the launch to one owner wallet without assigning
protocol roles directly to an EOA. It is still a single-key operational risk;
use a hardware wallet and add owners or raise the threshold after launch only
through a separately reviewed Safe transaction.

The Woven mainnet Safe already exists at
`0xF97FC34f97E556271E824D4011A02E5Fa78658fE`, owned by
`0x9b32E54046e0061a0139C62827B76CF2f19e1DfC`. Its creation transaction is
`0xeaac144ce794eccd7e3509bf478d745c97f80a1ee00a87bf5ffe213e5768c948`.
Do not run `safe:prepare` again for this mainnet release; doing so would prepare
a different Safe. Use the existing address and creation receipt with
`launch:verify`. The generic command below is retained only for a new network or
an explicitly approved replacement control profile.

Prepare a deterministic Safe deployment from the repository root:

```bash
npm run safe:prepare -- \
  --network mainnet \
  --owner 0xREPLACE_WITH_PUBLIC_OWNER_ADDRESS
```

The command checks the canonical Safe contracts on the selected chain and emits
a predicted Safe address plus an unsigned transaction. Review and submit that
transaction in the owner wallet. The script never requests or handles a private
key. After confirmation, retain the Safe creation transaction and verify the
deployed profile with the launch preflight below.

## WOVEN launch and graduation gate

The canonical WOVEN launch contract is
[`0xE40b89313D28d50Ea8DE94cA665617df2aC1Ffff`](https://bscscan.com/token/0xe40b89313d28d50ea8de94ca665617df2ac1ffff).
The address may be configured in the public web client while trading remains on
the Four.meme curve, but the protocol deployment stays blocked until every gate
below passes.

The contract core must not be deployed while WOVEN remains on the Four.meme
bonding curve. The final token must have all of these onchain properties:

- name `Woven Stocks` and symbol `WOVEN`;
- 18 decimals and exactly 1,000,000,000 total tokens;
- Four.meme `_mode() == 0`, indicating graduation;
- `owner() == address(0)`.

Use this reviewed Four.meme creation profile:

- name `Woven Stocks`, ticker `WOVEN`, and the square
  [`public/woven-token-logo.png`](../public/woven-token-logo.png) asset;
- Free Mode with BNB as the raised token;
- Tax, X Mode, and optional anti-sniping disabled;
- no reserved team allocation and no creator prebuy unless separately approved
  and disclosed before launch;
- description: `WOVEN powers creator access for Woven Stocks, a non-custodial
fixed-basket protocol on BNB Chain. WOVEN is not a stock, ETF, or claim on
basket assets.`

Four.meme currently presets one billion tokens and documents an approximately
0.005 BNB launch transaction fee. Recheck the live form and the official
[How it works](https://four-meme.gitbook.io/four.meme/guide/how-it-works)
page immediately before signing; platform parameters can change. Domain and
social links may remain blank until the project-owned accounts are ready.

Run the read-only preflight after both WOVEN and the Safe exist:

```bash
npm run launch:verify -- \
  --network mainnet \
  --owner 0xREPLACE_WITH_PUBLIC_OWNER_ADDRESS \
  --safe 0xREPLACE_WITH_PROTOCOL_SAFE \
  --safe-creation-tx 0xREPLACE_WITH_SAFE_CREATION_TRANSACTION \
  --woven 0xE40b89313D28d50Ea8DE94cA665617df2aC1Ffff
```

The output is evidence for the release review, not authorization to deploy.
The Solidity deployment script repeats these checks and fails closed.

## Contract release gates

1. Run the complete local checks and review the resulting artifacts.
2. Complete an independent security review and resolve accepted findings.
3. Verify WOVEN name, symbol, `totalSupply()`, `decimals()`, source, Four.meme
   graduation mode, ownership, and transfer behavior.
4. Run `npm run launch:verify` with the confirmed Safe creation transaction and
   independently review the pinned proxy factory, proxy/singleton/fallback-handler
   code hashes, version, single owner, threshold, empty module/guard state,
   treasury identity, and signer permissions.
5. Deploy the network-portable core on BNB testnet and exercise licensing,
   creation, minting, fee distribution, and redemption with representative token
   behavior. Validate the mainnet-only fixed router routes on a current BNB
   mainnet fork and complete the low-value mainnet canary in step 13.
6. Re-run the checks against the exact commit and compiler settings selected for mainnet.
7. Execute `contracts/script/DeployCore.s.sol` with its fail-closed environment gates.
8. Verify every core deployment receipt, source, runtime code hash, and immutable
   wiring before admitting any constituent.
9. Add constituents to the registry only after independent address and behavior
   review and retain the executed Safe transaction.
10. Execute `contracts/script/DeployBuyRouter.s.sol` only after its current-chain
    code-hash, pool, route, exact-output probe, and configuration-hash gates pass.
11. Complete the creator-license transaction, then execute
    `contracts/script/DeployCoreFour.s.sol` only after its CORE4 factory-count,
    derived raw-unit, route-output, code-hash, and configuration-hash gates pass.
12. Verify every router, adapter, and CORE4 source, receipt, runtime code hash,
    route, and post-deployment read-back on the selected block explorer.
13. Perform a low-value mainnet USDC-to-CORE4 canary before exposing the action
    broadly; record spend, refund, basket output, and zero-residual checks.

The exact script inputs and encoded chain checks are documented in
[contracts/README.md](../contracts/README.md). A passing script validation is
necessary but not sufficient: signer authorization, gas, constituent evidence,
deployed bytecode, receipts, independent review, and web configuration remain
separate requirements.

### Reproducible contract command

Create a named Foundry keystore for the deployment signer outside this
repository. It must not contain a raw private key in this repository. Export
only the public deployment inputs into the current shell, then run the first
command below. It is deliberately a simulation: it contains no account option,
`--broadcast`, or `--slow`.

```bash
cd contracts

export CONFIRM_DEPLOY=true
export EXPECTED_CHAIN_ID=97
export WOVEN_TOKEN=0xREPLACE_WITH_TESTNET_WOVEN
export PROTOCOL_SAFE=0xREPLACE_WITH_TESTNET_SAFE
export TREASURY=0xREPLACE_WITH_TESTNET_SAFE
export EXPECTED_SAFE_OWNER=0xREPLACE_WITH_PUBLIC_OWNER_ADDRESS
export WOVEN_BNB_RPC_URL=https://bsc-testnet-dataseed.bnbchain.org

forge script script/DeployCore.s.sol:DeployCore \
  --rpc-url "$WOVEN_BNB_RPC_URL" \
  --sender 0xREPLACE_WITH_DEPLOYER
```

Only after the simulation, inputs, predicted transactions, and release record
have been approved, submit the separate state-changing command with the external
keystore signer:

```bash
forge script script/DeployCore.s.sol:DeployCore \
  --rpc-url "$WOVEN_BNB_RPC_URL" \
  --account woven-deployer \
  --sender 0xREPLACE_WITH_DEPLOYER \
  --broadcast \
  --slow
```

For mainnet, use a separately reviewed keystore and address set and change only
the selected record to chain ID `56`, and set `WOVEN_BNB_RPC_URL` to a reviewed
BNB mainnet endpoint. Foundry uses this single operator-selected endpoint; it
does not inherit the browser's RPC failover. An authenticated endpoint may be
used only through the external shell environment and must never be committed.
Never reuse a testnet input by editing the
command from shell history. Source verification may be added with `--verify`
only after the exact explorer configuration has been reviewed; verification is
not proof that the configured owners or external assets are safe.

Preserve `broadcast/{DeployCore,DeployBuyRouter,DeployCoreFour}.s.sol/<chain-id>/run-latest.json`,
the console output, receipts, compiler settings, configuration hashes, probe
records, and explorer verification results in the release archive. Copy the facts into the versioned
[deployment record template](DEPLOYMENT_RECORD_TEMPLATE.md); the generated
`broadcast/` directory remains intentionally untracked.

## Constituent admission and Binance boundary

Woven always redeems in kind. For minting, users may deposit already-issued BNB
Chain bStocks or supply USDC to the optional exact-output router, which buys the
required bStocks from approved onchain DEX pools and mints atomically. The
browser and contracts do not call the Binance Stocks REST API, hold Binance API
keys, trade through an operator account, accept cash for an exchange purchase,
or provide a custodial brokerage backend. DEX liquidity is external and must be
revalidated at execution time.

No bStock is admitted from a ticker or third-party listing. For every address,
record primary issuer evidence, chain ID, deployed bytecode, decimals, ERC-8056
scaled-UI behavior, proxy or beacon implementation and admin, transfer tests,
and all applicable custody, redemption, country, blacklist, pause, freeze, and
seizure controls. A token can be officially issued and still be unavailable to
a user or become non-transferable because of external compliance or issuer
controls.

### Eligibility boundary

Binance describes bStocks as tokenized securities whose availability depends on
the user's jurisdiction and the relevant issuer terms. The reviewed Stocks REST
catalog does not document an endpoint that authoritatively decides whether a
wallet or visitor is eligible. Woven must not infer eligibility from an IP
address, wallet connection, Binance account status, or a frontend checkbox.

Before public mainnet write actions are enabled, the release owner must approve
one documented model with legal counsel and the applicable bStock providers:

- restrict only the hosted interface using an auditable jurisdiction and terms
  gate, while clearly documenting that public contracts remain independently
  accessible; or
- add reviewed onchain authorization to every mint and USDC-buy entry point.

The second model changes the protocol architecture and cannot be retrofitted to
immutable contracts without a new deployment. No placeholder allowlist or
undocumented Binance API dependency belongs in the release. See Binance's
[bStocks guide](https://academy.binance.com/en/articles/what-are-bstocks-a-guide-to-tokenized-stocks-on-binance)
for the product and restriction boundary; recheck the current issuer terms
immediately before launch.

After recording addresses from a primary issuer source, run the read-only
technical preflight with explicit `SYMBOL=ADDRESS` inputs:

```bash
npm run bstocks:verify -- \
  --network mainnet \
  NVDAB=0xREPLACE_WITH_PRIMARY_SOURCE_ADDRESS \
  MSFTB=0xREPLACE_WITH_PRIMARY_SOURCE_ADDRESS
```

The deterministic JSON checks chain ID, deployed code, exact symbol, decimals,
the three required ERC-8056 interfaces, current and pending multiplier state,
conversion roundtrip, and standard EIP-1967 implementation or beacon slots.
It sends no transaction and intentionally does not establish canonicality,
backing, eligibility, transferability, or regulatory availability.

ERC-8056 changes displayed amounts through a UI multiplier while raw ERC-20
balances and transfers remain unchanged. Recipe contracts account in raw units.
Every client and operational review must use the token's current scaled-amount
helpers for display/input conversion and retain the raw recipe value. A changing
multiplier does not rebalance a basket and does not remove proxy, pause, or
compliance risk.

## Web configuration

The browser uses one immutable, build-time BNB network profile. `mainnet` is the
default; `testnet` must be selected explicitly. Any other value stops the build.
There is no user-facing or runtime network toggle.

| Profile | Chain ID | Public RPCs                                                                     | Explorer                      |
| ------- | -------- | ------------------------------------------------------------------------------- | ----------------------------- |
| mainnet | 56       | `https://bsc-dataseed.bnbchain.org`, `https://bsc-dataseed-public.bnbchain.org` | `https://bscscan.com`         |
| testnet | 97       | `https://bsc-testnet-dataseed.bnbchain.org`, `https://bsc-testnet.bnbchain.org` | `https://testnet.bscscan.com` |

The browser reads only public addresses for the selected profile:

```dotenv
VITE_BNB_NETWORK=mainnet

# Keep false until every public-launch gate below is independently verified.
VITE_PUBLIC_LAUNCH_LIVE=false
VITE_PUBLIC_SITE_URL=https://wovenstocks.com

VITE_WOVEN_TOKEN=0xE40b89313D28d50Ea8DE94cA665617df2aC1Ffff
VITE_CREATOR_LICENSE=
VITE_ASSET_REGISTRY=
VITE_FEE_SPLITTER=
VITE_CURATOR_GUARDIAN=
VITE_BASKET_FACTORY=

# Enable only after the immutable USDC router is deployed and verified.
VITE_USDC=
VITE_ONE_CLICK_ROUTER=

# Canonical tokenized-stock contracts used by the builder and featured recipes.
VITE_BSTOCK_NVDAB=
VITE_BSTOCK_MSFTB=
VITE_BSTOCK_METAB=
VITE_BSTOCK_TSLAB=
VITE_BSTOCK_QQQB=
VITE_BSTOCK_AAPLB=
VITE_BSTOCK_GOOGLB=
VITE_BSTOCK_AMZNB=
VITE_BSTOCK_AMDB=
VITE_BSTOCK_PLTRB=
VITE_BSTOCK_ORCLB=
VITE_BSTOCK_TSMB=

# Basket contracts emitted by the configured factory.
VITE_BASKET_CORE4=
VITE_BASKET_CORE4_UNITS_RAW=
VITE_BASKET_TECH5=
VITE_BASKET_TECH5_UNITS_RAW=
VITE_BASKET_MAG7B=
VITE_BASKET_MAG7B_UNITS_RAW=
VITE_BASKET_AI6B=
VITE_BASKET_AI6B_UNITS_RAW=
```

Each `*_UNITS_RAW` value is the comma-separated `uint256[]` read back from the
confirmed basket contract, in the documented asset order. A featured route
stays disabled when this pinned raw recipe is absent or malformed.

Set every address from a deployment record for the same selected network. Never
reuse a mainnet address in a testnet build (or the reverse), and never infer an
address from a token name, ticker, search result, or unverified third-party
listing. Before writes, the client requires deployed contract code and validates
the immutable factory wiring exposed by those contracts. The release operator
must separately match verified explorer source and deployed bytecode to the
signed deployment record.

The exact public RPC hosts above are the only external RPC origins permitted by
the Content Security Policy in `vercel.json`. The browser automatically fails
over between the two allowlisted endpoints for the selected network. `VITE_*`
values are embedded in browser assets, so private keys and authenticated RPC
credentials must never be used there.

Search indexing remains fail-closed until all of the following are present in
the same build: explicit public-launch approval, mainnet profile, a custom HTTPS
domain, the six core addresses, USDC and router, the four CORE4 bStock addresses,
the CORE4 basket address, and its four pinned raw units. Vercel preview domains,
localhost, IP hosts, missing values, zero addresses, or duplicate addresses keep
the generated metadata at `noindex`.

### Testnet browser E2E

Create a separate Vercel preview environment containing testnet-only protocol,
constituent, and featured-basket addresses, then set:

```dotenv
VITE_BNB_NETWORK=testnet
```

Build the exact profile locally before promoting that preview:

```bash
VITE_BNB_NETWORK=testnet npm run build
```

Confirm the wallet add/switch request uses chain ID `0x61`, `tBNB`, the official
testnet RPC above, and the testnet BscScan explorer. Exercise the full low-value
testnet flow and retain transaction hashes. A passing testnet run does not
authorize a mainnet release.

For the production deployment, set `VITE_BNB_NETWORK=mainnet` explicitly and use
only verified mainnet addresses. Rebuild; do not promote a testnet bundle or
change the profile after build time.

## Web release checks

```bash
npm ci
npm run lint
npm run format:check
npm test
npm run build
npm run test:e2e
```

Before promoting a release, verify:

- generated assets and source maps contain no secrets or local paths;
- security headers are present on the deployed domain;
- direct navigation works for every supported route;
- wallet connection, rejection, disconnect, and chain mismatch behave correctly;
- actions remain unavailable when any selected-network address is missing;
- mobile, keyboard, reduced-motion, and short-viewport interactions remain usable;
- the deployed commit and environment addresses match the release record.

## External gates that code cannot complete

The following remain release-owner responsibilities:

- Four.meme launch, graduation, final token address, and owner-wallet signatures;
- BNB funding and submission of the unsigned Safe and deployment transactions;
- independent verification and admission of every bStock contract;
- independent smart-contract security review and deployed-bytecode verification;
- legal, jurisdiction, custody, marketing, and restricted-user review;
- the project-wide repository license choice before public GitHub publication;
- domain, DNS, monitoring, incident ownership, and production release approval.

## Rollback and incident handling

Keep the previous web deployment available for rollback. A web rollback cannot
revert immutable contracts or onchain transactions. If a contract issue is found,
stop exposing affected write actions, preserve evidence, notify Safe owners, and
follow the capabilities actually available in the deployed contracts. Do not
claim that a frontend change pauses or repairs onchain state.
