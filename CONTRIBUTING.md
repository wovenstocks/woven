# Contributing

Woven accepts focused changes that preserve the protocol's backing guarantees,
fail-closed execution, accessibility, and clear separation between local checks
and mainnet readiness.

## Before you begin

- Search open issues and pull requests for related work.
- Open an issue before proposing a new protocol capability or trust assumption.
- Never place private keys, seed phrases, API credentials, or production secrets in the repository.
- Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Local setup

Install the Node.js and Foundry prerequisites documented in [README.md](README.md), then run:

```bash
npm ci
npm run lint
npm run format:check
npm test
npm run build
npm run contracts:test
```

Changes to Solidity behavior should include focused tests and, where relevant,
fuzz or invariant coverage. Changes to wallet or transaction flows should include
tests for rejection, chain mismatch, missing provider, and missing configuration.

## Pull requests

Keep pull requests small enough to review as one coherent change. Explain:

- the problem and intended behavior;
- security, trust, accessibility, and compatibility effects;
- the commands used to verify the change;
- screenshots only when they materially clarify a user-interface change.

Do not combine generated artifacts, dependency upgrades, and functional changes
without a clear reason. A passing CI run is required, but it is not evidence of a
mainnet deployment, independent audit, or verified external asset.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
