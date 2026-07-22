# Architecture

Woven separates the browser interface, immutable basket contracts, and the
limited protocol control plane. The browser never holds server-side credentials;
all `VITE_` values are public build-time configuration. There is no Binance
Stocks REST API integration in the browser or a custodial backend.

## System boundaries

| Boundary                 | Responsibility                                                                             | Trust assumption                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| React application        | Presents baskets, connects an injected EIP-1193 wallet, and prepares user-approved actions | The user verifies network, address, amount, and wallet prompt                          |
| `CreatorLicense`         | Grants permanent publishing access after an exact WOVEN sink transfer                      | The configured WOVEN contract has the required supply, decimals, and transfer behavior |
| `CanonicalAssetRegistry` | Allows the Safe to approve constituent contracts for future baskets                        | Safe owners verify canonical addresses and external restrictions                       |
| `BasketFactory`          | Creates baskets for licensed creators from approved constituents                           | Constructor inputs and linked core contracts are correct                               |
| `BasketToken`            | Custodies constituents, issues basket ERC-20s, and redeems them in kind                    | Constituents follow compatible raw ERC-20 transfer and accounting behavior             |
| `FeeSplitter`            | Routes accumulated basket-token mint fees to creator and treasury                          | Treasury and creator destinations are correct                                          |
| `CuratorGuardian`        | Allows the Safe to raise basket caps and pause or resume new mints                         | Safe owners verify the basket address and use both capabilities conservatively         |
| `OneClickBasketRouter`   | Buys exact basket constituents from bounded USDC and mints atomically                      | Approved DEX routes have sufficient execution liquidity at transaction time            |
| Exact-output adapters    | Expose only immutable, constructor-bound PancakeSwap or Uniswap routes                     | Pinned router dependencies and external pools behave as verified                       |

## Basket lifecycle

### Creation

1. The Safe approves constituent contract addresses in `CanonicalAssetRegistry`.
2. A creator completes the one-time `CreatorLicense` WOVEN sink transfer.
3. `BasketFactory` validates the license, registry membership, and starter cap.
4. The factory deploys a `BasketToken` with immutable constituent addresses,
   raw units, mint fee, fee recipient, guardian, and maximum cap.

Registry changes affect only future creation. They cannot replace the constituents
inside an existing basket.

### Minting

For a requested basket amount, `BasketToken` calculates each required constituent
with upward rounding. Before each deposit it verifies that the existing balance
still backs the outstanding supply, then transfers all constituents before
minting. The token rejects existing deficits and short receipts. The configured
fee is issued as basket tokens to `FeeSplitter`; the remainder goes to the
recipient.

### Atomic USDC purchase

The optional buy router pulls only the reviewed USDC maximum from the user,
executes one exact-output swap for every raw constituent requirement, and then
mints through the same `BasketToken` path. Adapter addresses, bytecode, route
IDs, output tokens, and aggregate maxima are checked onchain. Unspent USDC is
returned. If any swap exceeds its bound, returns an inexact amount, or the final
mint fails, the entire transaction reverts. A first purchase may require a
separate exact USDC approval transaction.

### Redemption

The holder burns basket tokens and receives each constituent pro rata. Redemption
is not disabled by the mint pause state or an existing backing deficit. Each
outgoing transfer must decrease basket backing by exactly, and credit the
recipient by at least, the nominal amount or the full redemption reverts. The
basket has no administrative function that transfers backing to a privileged
address.

## Control plane

The deployment script assigns registry ownership and guardian administration to a
canonical Safe v1.4.1 and sets that same Safe as the immutable treasury. The
supported initial profile is one owner, threshold one, no modules, no guard, and
the canonical compatibility fallback handler. The deployed guardian interface
exposes only monotonic cap increases and mint pause toggles. It rejects empty-code
and wrong-guardian targets and verifies the requested state change before
emitting success. A pause affects new minting only; redemption remains available
unless an external constituent itself blocks transfers. Contract addresses remain
absent from the web build until the deployment and verification gates are complete.

The one owner wallet reviews and signs Safe creation, core deployment, and later
Safe transactions. Repository tooling prepares unsigned calldata and verifies
public state; it does not receive a private key or seed phrase.

## External constituent boundary

Basket recipes store raw ERC-20 units. Official bStocks may expose ERC-8056
scaled-UI amounts, so clients must convert inputs and displays with the token's
current helper functions without changing the immutable raw recipe. A multiplier
change is an external display event, not protocol rebalancing.

The basket core cannot remove issuer dependencies. A bStock proxy or beacon may
be upgraded, and an issuer or compliance operator may pause, blacklist, freeze,
seize, or restrict transfers. Those controls can prevent an otherwise callable
redemption from completing. Canonical provenance, token behavior, eligibility,
custody, and redemption terms are release gates for every admitted address.

## Explicit exclusions

- No Binance Stocks REST API call occurs in a smart contract, browser, or Woven
  backend.
- No oracle, automatic rebalancing, proxy upgrade, or administrative backing withdrawal exists.
- No operator account buys equities or bStocks for users. The optional USDC
  route spends the user's funds only against immutable onchain DEX routes.
- The route does not guarantee liquidity, execution price, issuer redemption,
  or legal availability; an unavailable leg reverts the complete purchase.
- Registry membership does not prove legal availability, custody, redemption rights, or price parity.

Review [contracts/SECURITY_PROPERTIES.md](../contracts/SECURITY_PROPERTIES.md) for
the contract-specific invariants and [DEPLOYMENT.md](DEPLOYMENT.md) for activation gates.
