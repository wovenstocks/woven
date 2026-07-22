# Woven Stocks

[Website](https://wovenstocks.com) · [X](https://x.com/wovenstocks)

Woven Stocks is a BNB Chain interface and smart-contract system for fixed,
redeemable token baskets. Each basket token represents a defined quantity of
every ERC-20 constituent held by its basket contract. Users can buy a complete
basket atomically with USDC or deposit the constituents directly, then redeem
the basket token in kind when external constituent transfer rules permit.

## Repository scope

The repository contains the web application, browser protocol client, contract
core, deployment validation, and automated tests. It does not include a Woven
contract deployment record. When the selected network's address configuration
is incomplete, the interface keeps onchain actions unavailable.

The codebase does not by itself establish:

- a live Woven deployment or service;
- verified canonical tokenized-stock addresses or transfer rules;
- deployed USDC router addresses, guaranteed DEX liquidity, an exchange
  account, a Binance API integration, or a custodial trading backend;
- an independent security audit or legal approval.

The browser and repository contain no Binance Stocks REST API credentials or
trading backend. Production deployments must use independently verified bStocks
that already exist on BNB Chain. Users may either deposit those assets in kind or use the optional
exact-output router to buy every required constituent from approved onchain DEX
routes with their own USDC. Smart contracts cannot call an exchange REST API;
the USDC path is DEX execution, not Binance-account trading.

## How it works

1. The protocol Safe approves reviewed ERC-20 constituents in the asset registry.
2. A creator with onchain access publishes a basket with fixed constituent amounts.
3. A user either deposits every required constituent or supplies a bounded USDC
   maximum to the atomic buy router.
4. The router buys exact constituent amounts from immutable approved DEX routes;
   any failed leg reverts the whole purchase and mint.
5. The contract issues a transferable basket ERC-20, less the configured mint fee.
6. A holder burns basket tokens to receive every constituent in kind.

Basket composition is fixed at deployment. There is no oracle, rebalancing
engine, upgrade proxy, or administrative withdrawal route in the basket core.
External constituent contracts may still be upgradeable, paused, frozen, or
restricted by their issuer or compliance operator.

The supported launch profile uses one public owner wallet controlling a
canonical 1-of-1 Safe; that same Safe is the protocol controller and treasury.
The repository prepares the Safe creation calldata, records launch steps and
verifies public chain state. Contract broadcasts still require an explicit
external signer for every transaction. It never needs the owner's seed phrase
or private key. See
[deployment](docs/DEPLOYMENT.md) for the Four.meme graduation and Safe gates,
then use the [mainnet operator runbook](docs/LAUNCH_OPERATOR_RUNBOOK.md) and its
[signing and receipt manifest](docs/LAUNCH_SIGNING_RECEIPTS_TEMPLATE.json) for
the reviewed launch.

The repository also includes a localhost-only MetaMask release console for
already encoded, independently reviewed direct-wallet transactions. It does not
translate Foundry scripts, Safe owner signatures, or external-platform actions,
and it never batches or signs automatically. See the operator runbook before
preparing or loading a manifest.

## Development

Prerequisites:

- Node.js 24.14.0 and npm 11.16.0;
- Foundry for Solidity builds and tests.

```bash
npm ci
npx playwright install chromium
(cd contracts && forge install \
  foundry-rs/forge-std@rev=bf647bd6046f2f7da30d0c2bf435e5c76a780c1b \
  --no-git --shallow)
npm run dev
```

The web build defaults to BNB Smart Chain mainnet. Set
`VITE_BNB_NETWORK=testnet` only in a separate testnet environment; the selected
profile is immutable after build time. See [deployment](docs/DEPLOYMENT.md) for
the exact RPC, explorer, address-separation, and E2E requirements.

Run the full local checks before opening a pull request:

```bash
npm run lint
npm run format:check
npm test
npm run build
npm run test:e2e
npm run contracts:fmt
npm run contracts:build
npm run contracts:test
```

The normal test suite covers the local release console. When a final launch
record and separately reviewed direct-transaction plan exist, prepare a
hash-bound unsigned manifest and start the localhost server:

```bash
npm run release:console:prepare -- \
  --launch-record release-evidence/launch-attempt.json \
  --plan release-evidence/direct-transaction-plan.json \
  --output release-evidence/unsigned-transactions.json
npm run release:console
```

The console accepts only BNB Chain 56 or 97, a unique injected MetaMask
provider, the exact manifest sender and chain, and direct-MetaMask signing
surfaces. Every `eth_sendTransaction` call requires a fresh row review, checkbox
and final click. Submitted hashes are checked against public transaction data
and a two-confirmation receipt before an exportable public receipt record is
marked confirmed.

Responsive hero and social images are generated deterministically from the
tracked source artwork:

```bash
npm run assets:images
```

After both production builds succeed, generate reproducible runtime and contract
CycloneDX SBOMs, an artifact hash manifest, and a release record with the pinned
contract dependencies:

```bash
npm run release:evidence
```

The generated `release-evidence/` directory is intentionally untracked. CI
retains it with the Slither and ERC-20 conformance results for each run.

## Repository map

| Path                     | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `src/`                   | React application, wallet integration, and contract configuration |
| `public/`                | Production web assets                                             |
| `contracts/src/`         | Solidity protocol contracts                                       |
| `contracts/test/`        | Unit, fuzz, invariant, and token-integration tests                |
| `contracts/script/`      | Fail-closed BNB Chain deployment script                           |
| `docs/`                  | Architecture, deployment, quality, and maturity documentation     |
| `tools/release-console/` | Local fail-closed MetaMask review and receipt console             |

Start with [the architecture](docs/ARCHITECTURE.md), then review the
[deployment gates](docs/DEPLOYMENT.md),
[mainnet operator runbook](docs/LAUNCH_OPERATOR_RUNBOOK.md), and
[contract documentation](contracts/README.md).
Token supply, licensing, and fee behavior are specified in [TOKENOMICS.md](TOKENOMICS.md).
Browser-client exports and safety requirements are documented in the
[protocol client reference](src/protocol/README.md).
Production operations must instantiate and test the pre-launch
[monitoring plan](docs/MONITORING.md) and
[incident-response plan](docs/INCIDENT_RESPONSE.md); the repository does not
deploy those services or assign their owners.

## Security

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md)
and use GitHub private vulnerability reporting.

## Licensing

A project-wide license has not been selected. Third-party and adapted components
retain their own notices and license terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
and [contracts/THIRD_PARTY_NOTICES.md](contracts/THIRD_PARTY_NOTICES.md).
