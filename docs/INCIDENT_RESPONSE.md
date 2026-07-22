# Incident response plan

> **Status: pre-launch runbook.** No incident team, paging route, monitoring
> provider, status page, or communications channel is established by this
> repository. Release-assigned names and tested contact paths are required
> before public mainnet write actions are enabled.

This plan is capability-based. It does not assume that a frontend rollback can
change chain state, that the Woven Safe controls an external bStock, or that an
immutable Woven contract exposes a pause, upgrade, migration, withdrawal, or
rescue function when it does not.

## Severity

| Severity              | Definition                                                                                                                                                                    | Initial response target after staffing                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `SEV-0 Critical`      | Confirmed or credibly active loss, backing deficit, key/control compromise, malicious production release, or external asset restriction that can block constituent transfer   | Page all critical roles; acknowledge within 15 minutes; continuous coordination           |
| `SEV-1 High`          | Major write-path outage, router or route failure, unexpected privileged state, domain compromise without confirmed signing impact, or material incident with bounded exposure | Page incident commander and surface owners; acknowledge within 30 minutes; hourly updates |
| `SEV-2 Medium`        | Degraded provider, pending multiplier change, isolated transaction failure, or issue with a safe workaround and no evidence of loss                                           | Assign owner within four hours; update each business day or on material change            |
| `SEV-3 Informational` | Expected operational event, false positive, or low-risk defect with no affected onchain action                                                                                | Track in normal work and retain evidence                                                  |

These targets are not service guarantees until the release record names primary
and backup responders and proves the notification path.

## Release-assigned roles

One person may hold more than one role, but each responsibility remains explicit.
The one-owner Safe does not remove the need for independent calldata and receipt
review.

| Role                             | Release assignment                | Responsibility                                                                      |
| -------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| Incident commander               | `REQUIRED: name + tested contact` | Severity, coordination, decisions, update cadence, closure                          |
| Onchain/contract lead            | `REQUIRED`                        | Contract state, invariants, traces, scope, technical options                        |
| Safe operator                    | `REQUIRED`                        | Prepare and execute only reviewed actions that the Safe can actually perform        |
| Independent transaction reviewer | `REQUIRED`                        | Decode target, value, operation, calldata, nonce, and postconditions before signing |
| Web release lead                 | `REQUIRED`                        | Disable affected UI paths, rollback/redeploy, verify domain and build integrity     |
| External-asset liaison           | `REQUIRED`                        | Primary-source bStock, custodian, proxy, pause, and restriction verification        |
| Legal/jurisdiction lead          | `REQUIRED`                        | Eligibility, notification, preservation, and regulatory decisions                   |
| Communications lead              | `REQUIRED`                        | Factual user and partner updates through pre-approved channels                      |
| Evidence scribe/custodian        | `REQUIRED`                        | Immutable timeline, receipts, block-pinned reads, decision log, and custody hashes  |
| Backup/escalation owner          | `REQUIRED`                        | Takes over for any unreachable critical role                                        |

Never place a private key, seed phrase, keystore password, provider credential,
or wallet export in an incident channel, ticket, screen recording, or evidence
archive.

## Activation and first 30 minutes

1. **Open one incident record.** Assign an ID, commander, severity, UTC start
   time, affected chain/address/domain, reporter, and evidence scribe. Preserve
   the original alert payload.
2. **Establish chain truth.** Record chain ID, current block number/hash, two RPC
   providers, the deployment record, and monitored code hashes. Distinguish a
   provider outage or reorganization from contract state.
3. **Use receipt-first transaction triage.** For every suspected transaction,
   query its hash, receipt, status, block, sender, and sender nonce before any
   retry. Decode target, value, operation, calldata, logs, balance deltas, and
   post-state.
4. **Bound the surface.** Identify affected baskets, constituents, adapters,
   routes, wallets, approvals, Safe state, web releases, time range, and whether
   direct in-kind minting or redemption is also affected.
5. **Reduce new exposure.** Disable affected hosted-interface write actions and
   publish a precise warning. If an available onchain pause or registry action
   is necessary, follow the Safe procedure below; do not improvise a signature.
6. **Set the next update.** State confirmed facts, unknowns, actions in review,
   user impact, and the next UTC update time. Do not estimate recovered funds or
   resolution before evidence exists.

### Receipt-first retry rule

- If the original transaction confirmed, continue from its actual receipt and
  post-state. Never send the same intended effect again because a wallet or RPC
  timed out.
- If it reverted, preserve the receipt and open a separately identified attempt
  after the cause and changed inputs are reviewed.
- If it remains pending, do not replace it until the operator has reviewed the
  sender nonce, replacement fee, calldata equality, and the effect of either
  transaction confirming.
- A Safe owner signature is not execution. Record the Safe nonce and transaction
  hash, then the executor transaction and successful chain receipt.
- A simulation, `eth_call`, explorer label, or frontend toast is not a receipt.

## Actual response capabilities

| Surface                             | Available response                                                                                                | Hard boundary                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Hosted web interface                | Hide or disable affected actions, warn users, roll back to a verified build, or redeploy from the approved commit | Cannot pause contracts, reverse transactions, revoke wallet approvals, repair backing, or prevent direct contract access     |
| `CanonicalAssetRegistry`            | Current owner Safe can set an asset unsupported and can perform a reviewed two-step ownership transfer            | Removal affects future basket creation and router checks; it does not change existing recipes or stop direct in-kind minting |
| `CuratorGuardian` / managed baskets | Immutable admin Safe can pause or resume new minting on a managed basket                                          | Cannot block redemption, withdraw backing, change recipe/fee/guardian, lower a cap, or exceed the immutable maximum          |
| `BasketToken`                       | Holder can redeem in kind when every external constituent transfer succeeds                                       | No upgrade, rebalancing, admin withdrawal, forced migration, or Woven-controlled recovery from an external freeze            |
| Router and adapters                 | Clients can stop using them; a newly reviewed immutable router/adapter set can be deployed                        | No admin pause, upgrade, route replacement, or rescue. Residual tokens may be stranded                                       |
| `FeeSplitter`                       | Anyone may call `distribute` for a registered basket                                                              | Treasury, creator registration authority, and 60/40 split cannot be changed after deployment                                 |
| `CreatorLicense`                    | Hosted creator onboarding can be disabled                                                                         | WOVEN token, burn sink, amount, and existing licenses cannot be changed or revoked                                           |
| External bStocks, USDC, and venues  | Woven can stop admission/use and contact the relevant provider                                                    | Woven cannot unpause, unfreeze, upgrade, reverse, redeem, or override external contracts                                     |
| Protocol Safe                       | Execute capabilities granted to the Safe while legitimate control remains                                         | A threshold-one Safe is a single-key risk. It cannot add powers to immutable Woven contracts or control an external issuer   |

Registry removal and basket mint pause often belong together: removal blocks the
router and new baskets for that constituent, while pausing each affected managed
basket blocks both direct and routed minting. Neither operation rewrites an
existing recipe, guarantees redemption, or reaches third-party interfaces.

## Safe action procedure

Use the Safe only when the capability table establishes an effective response.
Every action requires a new, explicit review and signature; there is no safe
blanket authorization.

1. Record chain ID, Safe address and current code/profile, owner, threshold,
   modules, guard, fallback handler, nonce, and balance from direct reads.
2. Write the exact target, value, operation, decoded function and arguments,
   calldata hash, expected events, and postconditions. State what the action
   cannot do.
3. Have the contract lead and independent reviewer approve the decoded action.
   Simulate against a pinned current block; treat simulation only as preflight.
4. Have the owner review the same fields in the signing surface. Do not export a
   MetaMask key or ask for a connection-only approval as authorization.
5. Execute and retain the Safe transaction hash, executor transaction, receipt
   status `1`, block reference, decoded events, and post-state. On failure, use
   the receipt-first retry rule.

Do not raise a basket cap during containment. A registry removal must name the
exact asset address; a mint pause must name every affected managed basket.

## Scenario playbooks

### Backing deficit or constituent transfer restriction

1. Recalculate raw-unit backing for every affected basket at the same block and
   compare independent RPCs. Identify transfer, rebase, seizure, freeze, or
   accounting evidence; do not infer the cause from `isFullyBacked()` alone.
2. Disable mint, buy, and misleading redemption claims in the hosted interface.
3. If the Safe remains legitimate, pause minting on every affected managed
   basket and remove the constituent from the registry after decoded review.
4. Verify whether redemption succeeds under the external token's current rules.
   A protocol mint pause does not disable redemption, but an issuer restriction
   can still make redemption revert.
5. Contact the external-asset owner through the release-record channel. Do not
   promise restoration, parity, issuer redemption, or a timeline without its
   evidence.
6. There is no privileged backing withdrawal or forced migration. Any new
   basket or migration design is a separate audited deployment and requires
   voluntary user transactions.

### bStock proxy, pause, compliance, or multiplier change

1. Pin the observation block and record proxy/beacon/admin slots, resolved
   implementation and code hash, provider events, restriction state,
   `uiMultiplier`, `newUIMultiplier`, and `effectiveAt`.
2. Treat an unexplained implementation change or transfer-affecting pause/freeze
   as `SEV-0`; stop affected hosted writes and apply the available registry and
   basket-pause actions.
3. Verify the change against primary issuer sources and the verified ABI. Do not
   guess non-standard pause or blacklist semantics.
4. A multiplier change changes UI conversion only. Never mutate an immutable raw
   recipe or describe the event as protocol rebalancing.
5. Resume only after current transfer tests, backing checks, display roundtrip,
   issuer restrictions, and legal eligibility are independently re-approved.

### Router, adapter, dependency, or liquidity incident

1. Disable only the affected USDC-buy paths first; preserve in-kind mint and
   redemption only if their separate asset and backing checks pass.
2. Record router/adapter code hashes, immutable links, routes, pool state,
   exact-output quote inputs, revert data, allowances, and residual-balance
   baselines at the incident block.
3. For an asset-wide issue, remove the asset from the registry and pause affected
   baskets. For a route-only issue, registry removal may be unnecessarily broad;
   document the decision.
4. Do not attempt an admin route edit, pause, upgrade, or rescue: those functions
   do not exist. Deploy and independently review a new immutable route set if
   service is to resume.

### Safe owner or control-plane compromise

1. Independently read the Safe singleton, owners, threshold, modules, guard,
   fallback handler, nonce, recent executions, registry owner/pending owner, and
   guardian admin. Remove all hosted protocol write paths while control is
   uncertain.
2. If legitimate Safe control still exists, review the Safe's native owner and
   threshold recovery options and any registry ownership transfer as explicit
   Safe transactions. Never assume that a proposed transaction wins a nonce
   race.
3. The guardian admin and fee-splitter treasury are immutable references to the
   original Safe. Transferring registry ownership does not migrate those roles,
   and existing baskets cannot replace their guardian. A compromised Safe can
   therefore require a new protocol deployment and voluntary user migration.
4. If legitimate control is lost, do not claim that Woven can recover the Safe
   or its immutable roles. Coordinate wallet/security specialists, preserve all
   chain evidence, and communicate the exact limitations.

### Frontend, domain, or release compromise

1. Disable the affected domain or deployment route, preserve DNS, TLS, provider,
   build, and access-log evidence, and publish warnings through a separately
   verified channel.
2. Compare served JavaScript and address/network configuration with the approved
   build digest. Roll back or redeploy only a verified commit and re-check every
   security header and write target.
3. Rotate compromised hosting, DNS, GitHub, or monitoring credentials through
   their providers. This does not authorize wallet or Safe key rotation without
   the reviewed onchain process.
4. Identify malicious approvals or signatures from transaction evidence. Do not
   state that a clean redeploy revokes them or reverses an onchain effect.

### WOVEN token incident

Disable creator-license onboarding and record the token's code, owner/mode,
transfer behavior, and issuer/launchpad evidence. Existing basket backing does
not consist of WOVEN, but the immutable `CreatorLicense` cannot change its token,
sink, amount, or prior licenses. A replacement license requires a new core
deployment.

## Communications

- Name the canonical status URL and X/account only in the release record after
  control and backup access are verified. Never invent a support channel during
  an incident.
- State affected chain IDs, contract addresses, products and time ranges; what
  is confirmed; what remains unknown; actions completed with transaction hashes;
  and what the frontend change can and cannot do.
- Do not call a basket an ETF or direct share, promise price parity or
  redemption, imply Binance support, or describe a frontend block as onchain
  enforcement.
- Publish at the cadence in the severity table even when the only update is that
  investigation continues. Correct errors in a new timestamped update rather
  than silently editing the record.
- Legal/jurisdiction leadership decides any provider, regulator, law-enforcement,
  or affected-user notification. Preserve privilege and personal data without
  withholding public chain facts from the technical evidence log.

## Evidence, recovery, and closure

Follow the evidence schema and retention rules in
[MONITORING.md](MONITORING.md). Maintain an append-only UTC timeline of alerts,
facts, hypotheses, decisions, signatures, receipts, state reads, communications,
and responsible reviewers. Hash exported evidence with SHA-256; screenshots and
explorer pages remain secondary to RPC receipts and block-pinned state.

Do not restore an affected write path until all applicable criteria pass:

- root cause and affected addresses/blocks are documented;
- Safe and registry state match the approved profile, with no unexplained
  pending transaction or owner state;
- basket backing and external transfer behavior pass at current blocks;
- implementation, multiplier, route, quote, liquidity, and residual checks have
  current evidence;
- the candidate web build matches its release digest and addresses;
- a low-value canary has a successful mainnet receipt when the recovered path
  moves value; and
- incident commander, contract/security, external-asset, legal, Safe-operations,
  and web owners approve their respective surfaces.

Close the incident only after user-facing status is accurate, temporary access
is removed, evidence is backed up, and every follow-up has an owner and due date.
Publish a factual postmortem target within five business days for `SEV-0` and
`SEV-1`, unless the legal lead records a specific reason to delay it.

## Tabletop requirement

Before launch, run and evidence one tabletop covering:

1. a bStock implementation upgrade followed by a transfer pause;
2. an unexplained backing deficit;
3. a pending Safe transaction with an RPC timeout and replacement pressure;
4. a compromised production domain serving a wrong router address; and
5. zero route liquidity with residual tokens at an immutable adapter.

For each scenario, verify alert routing, role handoff, decoded Safe actions,
receipt-first retry, public wording, evidence export, and recovery criteria.
Repeat the tabletop after any material contract/control-plane change and at
least quarterly while public mainnet write actions remain enabled. A meeting
invite or unchecked checklist is not completion evidence.
