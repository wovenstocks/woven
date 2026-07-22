# Engineering maturity

This document records current engineering evidence and the gates that remain. It
is not a certification, audit opinion, or statement that the protocol is ready for
unrestricted production use.

## Trail of Bits maturity scorecard

Current repository score: **2.2 / 4.0 (Moderate)**. The implementation is more
mature than the operational launch posture. Scores follow the nine-category
Trail of Bits code-maturity framework and describe the reviewed source snapshot,
not a security audit or production approval.

| Category                   | Score | Current position                                                                                                                                 |
| -------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Arithmetic                 |   3/4 | Explicit rounding, `Math.mulDiv`, fuzzing, and backing invariants; extreme-unit and differential decimal/fee coverage remain                     |
| Auditing and monitoring    |   1/4 | Useful protocol events and detailed plans exist, but production collectors, paging, owners, retention, and tabletop evidence do not              |
| Access control             |   2/4 | Two-step registry ownership and narrow guardian powers; the launch profile still concentrates control in one threshold-one Safe                  |
| Complexity                 |   2/4 | Immutable bounded design, but atomic routing and fail-closed deployment validation remain expensive to review manually                           |
| Decentralization           |   2/4 | No Woven proxy or backing withdrawal path; external bStock administrators and the threshold-one Safe remain material dependencies                |
| Documentation              |   3/4 | Trust boundaries, invariants, deployment, monitoring, incidents, and receipt handling are documented; live evidence and a project licence remain |
| Transaction ordering / MEV |   3/4 | Exact-output limits, aggregate maximums, minimum output, and short deadlines; no dedicated sandwich or transaction-permutation suite             |
| Low-level manipulation     |   2/4 | Assembly is limited to validated packed-path decoding; reference decoding and differential fuzzing remain                                        |
| Testing and verification   |   2/4 | 271 web/tool tests and 108 Forge tests pass; no coverage target, mutation suite, formal proof, independent audit, or mainnet canary              |

The highest-value maturity work after this repository handoff is to activate
and test production monitoring, complete an independent contract/deployment
review, approve the bStock eligibility model, and replace or explicitly accept
the one-owner control profile. A project-wide licence also remains an owner
decision.

| Area                      | Current evidence in the repository                                                                                                                                         | Evidence required beyond source                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture              | Fixed basket core plus typed, immutable exact-output adapters and an atomic USDC buy router with documented trust boundaries                                               | Review final deployed wiring, DEX route liquidity, and every external token assumption                                                                           |
| Access control            | Two-step registry ownership, immutable Safe-linked guardian, no basket backing withdrawal route, and a fail-closed one-owner Safe launch profile                           | Protect the single owner key; verify the deployed Safe, signer process, and any later owner/threshold change                                                     |
| Arithmetic and accounting | Fixed compiler, OpenZeppelin math/transfer primitives, exact-receipt checks, fuzz and invariant tests                                                                      | Independent review against production constituent decimals and transfer behavior                                                                                 |
| Testing                   | Foundry unit, fuzz, invariant, and token-integration suites; web checks are enforced by CI                                                                                 | Add or update regression coverage with every material behavior change                                                                                            |
| Static analysis           | Reproducible commands and reviewed artifacts under `contracts/security-artifacts/`                                                                                         | Re-run against the release commit and resolve accepted findings                                                                                                  |
| Upgradeability            | Basket contracts are not proxy-upgradeable; composition is fixed at construction                                                                                           | Publish a migration and incident plan for immutable deployments                                                                                                  |
| Frontend safety           | Address configuration is explicit and intended to fail closed when incomplete                                                                                              | Verify wallet lifecycle, ERC-8056 input/display conversion, transaction calldata, deployed headers, and mainnet canary                                           |
| Deployment                | Chain, confirmation, exact WOVEN metadata/supply, Four.meme graduation, canonical 1-of-1 Safe profile, shared Safe treasury, and post-deployment wiring checks are encoded | Supply public owner and contract inputs, sign externally, deploy, verify sources, and record addresses                                                           |
| External assets           | Registry mechanism and raw-unit basket accounting exist                                                                                                                    | Independently verify official bStock contracts, ERC-8056 behavior, proxy/beacon controls, compliance restrictions, custody, eligibility, and redemption behavior |
| Assurance                 | Security properties, responsible disclosure, and pre-launch monitoring and incident-response runbooks are documented                                                       | Complete independent audit and legal review; deploy and test monitoring; assign incident roles, paging, evidence custody, and retention ownership                |

## Evidence not included

The repository does not include evidence for the following claims:

1. A verified Woven mainnet deployment.
2. A canonical constituent list with independently checked transfer and jurisdiction rules.
3. An independent security audit.
4. Activated production monitoring, tested paging, assigned incident-response
   roles, and completed tabletop evidence. The repository contains plans only;
   see [MONITORING.md](MONITORING.md) and
   [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md).
5. Legal or regulatory approval.
6. A guarantee that an external bStock issuer, proxy administrator, or
   compliance operator will keep transfers and redemption available.

The repository does not integrate the Binance Stocks REST API in its browser or
backend. It supports in-kind use of independently verified bStocks and an
optional user-funded USDC purchase through approved onchain DEX pools.
Exchange-account access, cash brokerage, guaranteed fills, and custodial
execution remain outside the implemented system.

Evidence for one item does not establish the others. Follow
[DEPLOYMENT.md](DEPLOYMENT.md), [QUALITY.md](QUALITY.md),
[MONITORING.md](MONITORING.md), and
[INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) for the records needed for a
deployment.
