# Quality standard

Every release must be understandable, reproducible, accessible, and explicit
about the evidence supporting its claims.

## Automated gates

Continuous integration runs from a clean dependency install and requires:

- lint and formatting checks;
- web unit tests and a production build;
- Solidity compilation and contract tests;
- Slither high-severity and ERC-20 conformance checks;
- dependency audit results suitable for review.

Contract changes should preserve unit, fuzz, invariant, and adversarial token
coverage. Wallet changes should cover missing providers, rejected requests,
account and chain events, stale asynchronous work, and absent contract addresses.

## Interface gates

Review each supported route at representative desktop, tablet, narrow mobile,
and short landscape sizes. Confirm:

- no clipped, overlapping, or unreachable controls;
- logical keyboard order, visible focus, and correct dialog/menu containment;
- appropriate names, states, and relationships for assistive technology;
- readable contrast and usable behavior at text zoom;
- reduced-motion preferences remove nonessential movement;
- loading, empty, error, wallet rejection, and wrong-network states are coherent;
- bStock inputs and displayed balances use the live ERC-8056 conversion helpers,
  while reviews and transaction records retain the exact raw-token values;
- every link and control has a real destination or a clearly unavailable state.

## Claim discipline

Evidence must be stated at the level actually established:

| Evidence                  | Supports                                        | Does not support                                                                       |
| ------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| Local build               | Source compiles into web assets                 | Production health or correct environment configuration                                 |
| Automated tests           | Covered behavior passes in the test environment | Absence of defects or economic safety                                                  |
| Static analysis           | Reviewed patterns were detected or cleared      | Independent audit or formal verification                                               |
| Explorer verification     | Published bytecode matches submitted source     | Correct ownership, asset backing, or legal availability                                |
| Wallet connection         | The browser can communicate with a wallet       | Successful protocol execution or safe assets                                           |
| Registry approval         | The protocol Safe approved an address           | Custody, redemption rights, price parity, or jurisdictional access                     |
| Official token provenance | An address matches primary issuer evidence      | Continued transferability, eligibility, proxy immutability, or redemption availability |

Release notes must distinguish implementation, deployment, verification, and
external approval. Marketing language must not turn one category into another.

## Reproducible evidence

Run `npm run release:evidence` only after `npm run build` and
`npm run contracts:build`. It creates an untracked `release-evidence/` directory
containing:

- a reproducible CycloneDX 1.6 runtime SBOM derived from `package-lock.json`;
- a schema-validated CycloneDX 1.6 contract SBOM covering the exact
  OpenZeppelin version and forge-std commit;
- SHA-256 hashes for the web build, deployable contract artifacts, SBOM, and
  build configuration;
- a machine-readable release record with the pinned OpenZeppelin and forge-std
  dependencies, plus the commit identity when `RELEASE_COMMIT` or `GITHUB_SHA`
  is present.

The command rejects missing artifacts, paths outside the repository, and
symbolic links. A hash manifest establishes artifact identity only; it is not
proof of deployment, review, backing, or legal availability.

## Release record

For an onchain release, retain the reviewed commit, dependency lockfile,
compiler settings, CI result, deployment transaction hashes, verified addresses,
Safe configuration, constituent evidence, and unresolved risk acceptance. Do not
store secrets or personal data in the record.
