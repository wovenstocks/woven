# Function and external-call diagram

Derived from Slither's `function-summary` printer. The complete project-contract
tables are stored in `slither-function-summary.txt`.

```mermaid
flowchart LR
  User[User] -->|mint / redeem| BasketToken
  Creator[Licensed creator] -->|createBasket| BasketFactory
  BasketFactory -->|isLicensed| CreatorLicense
  BasketFactory -->|isSupported per asset| Registry[CanonicalAssetRegistry]
  BasketFactory -->|deploy| BasketToken
  BasketFactory -->|register| FeeSplitter

  Safe[Protocol Safe] -->|setAsset / setAssets| Registry
  Safe -->|raiseCap / setMintPaused| Guardian[CuratorGuardian]
  Guardian -->|setSupplyCap / setMintPaused| BasketToken

  Creator -->|burnForLicense| CreatorLicense
  Anyone[Any caller] -->|distribute| FeeSplitter
  FeeSplitter -->|basket tokens| Creator
  FeeSplitter -->|basket tokens| Treasury[Treasury]

  BasketToken -->|transferFrom / balanceOf| Constituents[Canonical ERC-20 constituents]
  BasketToken -->|transfer| Constituents
  CreatorLicense -->|transferFrom / balanceOf| WOVEN[WOVEN token]

  Buyer[USDC payer] -->|mintWithUsdc| BuyRouter[OneClickBasketRouter]
  BuyRouter -->|factory provenance / registry support| Registry
  BuyRouter -->|exact-output leg| V4Adapter[UniswapV4ExactOutputAdapter]
  BuyRouter -->|exact-output leg| V3Adapter[PancakeV3ExactOutputAdapter]
  BuyRouter -->|mint fixed raw recipe| BasketToken
  BuyRouter -->|refund unused input| Buyer

  V4Adapter -->|approve / clear| Permit2
  Permit2 --> UniversalRouter[Uniswap Universal Router]
  V4Adapter -->|quote| V4Quoter[Uniswap V4Quoter]
  UniversalRouter --> V4Pools[Hook-free v4 pools]

  V3Adapter -->|quote| PancakeQuoter[Pancake QuoterV2]
  V3Adapter -->|exactOutput| PancakeRouter[Pancake SmartRouter]
  PancakeRouter --> V3Pools[Pancake v3 pools]

  V2Adapter[PancakeV2ExactOutputAdapter] -. compiled but excluded from initial route set .-> V2Pools[Pancake v2 pools]
```

Inspection: value-moving paths in `BasketToken`, `CreatorLicense`, and
`FeeSplitter`, the buy router, and every adapter are reentrancy-guarded. The
router accepts only factory-created baskets and constructor-pinned adapter code;
adapters expose constructor-bound routes instead of arbitrary targets or
calldata. Exact debit, output, refund, allowance cleanup, and residual-balance
checks fail closed. The factory makes external calls before and after deployment,
but its registry/license/splitter implementations are immutable deployment
dependencies. Constituent loops in `BasketToken` are bounded to 20 and routed
execution to 8.

Deployment validation is a separate ordering boundary:

```mermaid
flowchart LR
  Operator --> DeployCore
  DeployCore --> Core[Verified core wiring]
  Safe --> Admission[Reviewed setAssets receipt]
  Core --> DeployBuyRouter
  Admission --> DeployBuyRouter
  DeployBuyRouter --> RouteSet[4 immutable routes + probes + config hash]
  Creator --> License[WOVEN approval + burnForLicense]
  RouteSet --> DeployCoreFour
  License --> DeployCoreFour
  DeployCoreFour --> CORE4[CORE4 read-back + config hash]
```

None of these script nodes proves a deployment until its signed transaction,
successful receipt, runtime code hash, and post-deployment read-back are recorded.
