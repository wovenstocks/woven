# Security artifacts

Generated during the repository's local security-review workflow on 2026-07-22.
These artifacts support engineering review; they are not an independent audit.

## Commands

```sh
slither . --exclude-dependencies --exclude reentrancy-balance --fail-high
slither . --exclude-dependencies --detect reentrancy-balance --fail-none
slither script/DeployCore.s.sol --exclude-dependencies --exclude reentrancy-balance --fail-high
slither script/DeployBuyRouter.s.sol --exclude-dependencies --exclude reentrancy-balance --fail-high
slither script/DeployCoreFour.s.sol --exclude-dependencies --exclude reentrancy-balance --fail-high
slither-check-erc . BasketToken --erc erc20
slither . --exclude-dependencies --print inheritance-graph
slither . --exclude-dependencies --print function-summary
slither . --exclude-dependencies --print vars-and-auth
FOUNDRY_INVARIANT_RUNS=128 FOUNDRY_INVARIANT_DEPTH=64 \
  forge test --match-contract BasketInvariantTest -vv
forge build --sizes
forge test --summary
```

`reentrancy-balance` is excluded only from the High-failure command and is
immediately rerun as preserved evidence. The report documents why its 21 current
instances are scanner false positives for the reviewed `nonReentrant`,
code-hash-bound, balance-delta-checked entry points. Every other High detector
remains release-blocking.

Files beginning with `slither-` are local, ignored tool output. The reviewed Markdown
diagrams are the versioned, human-sized security views derived from those printers.
See `SECURITY_WORKFLOW_REPORT.md` for triage and conclusions, and
`../SECURITY_PROPERTIES.md` for the project-specific invariant specification.
