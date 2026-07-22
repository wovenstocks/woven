# Mainnet launch operator runbook

This runbook covers the public evidence and signatures needed to take the
reviewed Woven repository from a final Four.meme token address to a recorded BNB
Smart Chain mainnet release. It does not authorize a transaction. Every
state-changing step requires a fresh review of the exact chain, sender, target,
value, calldata, and simulation.

Use [`LAUNCH_SIGNING_RECEIPTS_TEMPLATE.json`](LAUNCH_SIGNING_RECEIPTS_TEMPLATE.json)
as the machine-readable companion record. Keep one immutable copy per launch
attempt; do not overwrite a failed or superseded attempt.

## Pinned control plane

The launch reuses the protocol Safe that already exists on BNB Smart Chain
mainnet:

| Field                      | Pinned value                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Chain ID                   | `56`                                                                                    |
| Owner wallet               | `0x9b32E54046e0061a0139C62827B76CF2f19e1DfC`                                            |
| Protocol Safe and treasury | `0xF97FC34f97E556271E824D4011A02E5Fa78658fE`                                            |
| Safe creation transaction  | `0xeaac144ce794eccd7e3509bf478d745c97f80a1ee00a87bf5ffe213e5768c948`                    |
| WOVEN launch contract      | `0xE40b89313D28d50Ea8DE94cA665617df2aC1Ffff`                                            |
| Reviewed Safe profile      | Safe v1.4.1, one owner, threshold one, no modules, no guard, canonical fallback handler |

The Safe creation evidence passed the repository-level pinned proxy-factory and
runtime-profile checks on 2026-07-22. The launch preflight must re-read that
state immediately before deployment because Safe configuration is mutable.

**Do not run `npm run safe:prepare` for this launch.** That command prepares a
new Safe creation transaction. It is not a login, connection, refresh, or
permission step, and it is unnecessary for the existing Safe above. A second
Safe must not silently replace the pinned protocol controller or treasury.

## Signing surfaces

There is no safe blanket signature that lets an operator finish the launch
later. Each onchain transaction has its own nonce, calldata, gas conditions,
and receipt.

| Surface                       | Use                                                                                                          | Boundary                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MetaMask owner wallet         | Review and sign explicit direct-wallet transactions and the owner signature for an explicit Safe transaction | Never share or export the seed phrase or private key. A connection approval is not transaction authorization.                                                                                                                                     |
| Safe transaction flow         | Execute protocol-admin calls from the pinned Safe, such as registry admission                                | Record the Safe nonce, Safe transaction hash, decoded target/value/operation/calldata, executor transaction, and receipt. An owner signature alone is not execution proof.                                                                        |
| Foundry simulation            | Reproduce deployment validation and predicted transactions without changing chain state                      | Run without `--broadcast` and without an account option. A passing simulation is not a receipt.                                                                                                                                                   |
| Foundry broadcast             | Submit the reviewed deployment scripts                                                                       | Foundry needs a supported external signer such as a named encrypted keystore or reviewed hardware-wallet flow. The MetaMask browser extension is not a Foundry CLI signer. Do not export a MetaMask private key merely to make the CLI work.      |
| Foundry-derived MetaMask plan | Submit the exact transactions emitted by a reviewed Foundry dry-run through the localhost console            | The repository generator must bind the dry-run file hash, Git commit, sender, contiguous nonces, calldata, predicted CREATE addresses, order, and a maximum 24-hour expiry. Every transaction still receives its own MetaMask prompt and receipt. |

One public EOA may fill the owner, deployment-signer, creator, and canary-payer
roles if the release owner deliberately chooses and funds that profile. Record
each role separately: sharing an address does not merge the transactions or
remove any review, signature, or receipt requirement.

One local keystore unlock may let Foundry sign a reviewed script run, but every
broadcast remains a separate chain transaction and needs a separate receipt.
The repository's localhost release console handles already encoded direct
transactions and automatically generated
`metamask-direct-from-foundry-simulation` entries. It continues to reject raw
Foundry-only entries, Safe owner-signature entries, Four.meme flows, and
external events. Never hand-copy a Foundry trace into a wallet plan: use the
generator below, or use a supported external Foundry signer.

## Local MetaMask release console

The console is a review and receipt surface, not an encoder or signing proxy. It
binds only to `127.0.0.1`, accepts only local Host headers and allowlisted static
files, performs no page-level fetch or XHR, stores no wallet state, and never
submits a batch. Chain reads and the one explicit send request use only the
injected MetaMask provider. Closing the local process disables it.

1. Copy the launch template into the untracked `release-evidence/` directory.
   Fill its final `releaseId`, `attemptId`, public addresses, simulation hashes,
   calldata hashes and status fields. Preserve the original attempt record.
2. For a Foundry deployment phase, generate both the updated launch record and
   nonce-bound transaction plan directly from the dry-run broadcast file. Use a
   fresh expiry no more than 24 hours ahead and the full reviewed commit:

   ```bash
   npm run release:console:prepare-foundry -- \
     --launch-record release-evidence/launch-attempt.json \
     --broadcast contracts/broadcast/DeployCore.s.sol/56/dry-run/run-latest.json \
     --phase core \
     --release-id woven-mainnet-YYYY-MM-DD \
     --attempt-id attempt-001 \
     --expires-at YYYY-MM-DDTHH:MM:SS.000Z \
     --expected-commit 40_CHARACTER_GIT_COMMIT \
     --record-output release-evidence/core-launch-record.json \
     --plan-output release-evidence/core-transaction-plan.json
   ```

   The command fails if the script operation order, chain, commit, sender,
   nonce sequence, CREATE address, core wiring, or evidence hash differs from
   the reviewed profile. Use `--phase router` or `--phase core4` only with the
   corresponding dry-run artifact.

3. For a non-Foundry direct call, copy
   [`RELEASE_TRANSACTION_PLAN_TEMPLATE.json`](RELEASE_TRANSACTION_PLAN_TEMPLATE.json)
   into `release-evidence/`. Include only direct-MetaMask entries. Populate each
   exact sender, target, nonce, decimal wei value, calldata, expected receipt
   contract address, and UTC expiry when required. Derive calldata from the
   reviewed encoder; never hand-type it.
4. Generate a versioned hash-bound manifest. The command refuses an existing
   output file so an earlier attempt is not overwritten:

   ```bash
   npm run release:console:prepare -- \
     --launch-record release-evidence/launch-attempt.json \
     --plan release-evidence/direct-transaction-plan.json \
     --output release-evidence/unsigned-transactions.json
   ```

5. Independently compare both SHA-256 source hashes and every decoded field,
   then start `npm run release:console`. Open only the printed
   `http://127.0.0.1:<port>` URL in the browser profile containing MetaMask.
6. Load the generated manifest, connect the exact sender, match chain 56, review
   one row, tick the explicit comparison checkbox and click **Send this
   transaction**. MetaMask then provides the separate wallet confirmation.
7. Before each prompt the console re-reads the wallet's pending nonce and stops
   unless it exactly matches the manifest. After submission, do not retry on a
   timeout. Use **Check receipt**. The tool reads the transaction back, compares
   sender, target, nonce, value, calldata and expected CREATE address, requires
   two observed confirmations, and records confirmed, reverted or mismatch
   status. Later rows remain blocked until every earlier receipt is confirmed.
   Export the JSON receipt bundle and attach it to the launch attempt evidence.

The incomplete launch template and transaction-plan template are intentionally
not executable. The console cannot approve future transactions, bypass a
MetaMask prompt, or make one blanket signature valid for later actions.

## Evidence rules

- Work from one clean, reviewed Git commit. Record the commit, Foundry version,
  compiler settings, UTC time, and chain ID before any signature.
- Store only public data: addresses, calldata or its hash, code hashes,
  transaction hashes, receipts, block references, decoded events, explorer
  URLs, and hashes of local evidence files.
- Never store a seed phrase, private key, keystore file or password, wallet
  export, authenticated RPC URL, API token, session cookie, exchange credential,
  or unredacted screen recording.
- Hash evidence files with SHA-256. Do not treat a filename or screenshot as
  proof when an RPC receipt or read-back is available.
- Stop on a reverted receipt, unexpected sender/target/value, changed Safe
  profile, changed code hash, stale route quote, mismatched configuration hash,
  missing source verification, or failed postcondition. Preserve the failed
  record and start a new launch-attempt manifest after review.
- Check a transaction hash and its receipt before retrying. Never assume a
  wallet error means the transaction was not submitted.

## Phase 0: freeze the release candidate

1. Create the launch manifest from the tracked template and assign a unique
   `releaseId` and `attemptId`.
2. Record the exact Git commit, Node/npm/Foundry versions, build artifact digest,
   operator and independent reviewer, all as public identifiers only.
3. Run the complete repository checks and `npm run release:evidence` from the
   same commit.
4. Record the chosen eligibility model, external-asset review, independent
   contract review, production owner approval, and any accepted risks. Missing
   approvals keep the launch blocked even when tests pass.

## Phase 1: WOVEN and existing Safe preflight

After the official token has launched and graduated, record its final contract
address plus the Four.meme creation and graduation evidence. Then run:

```bash
npm run launch:verify -- \
  --network mainnet \
  --owner 0x9b32E54046e0061a0139C62827B76CF2f19e1DfC \
  --safe 0xF97FC34f97E556271E824D4011A02E5Fa78658fE \
  --safe-creation-tx 0xeaac144ce794eccd7e3509bf478d745c97f80a1ee00a87bf5ffe213e5768c948 \
  --woven 0xE40b89313D28d50Ea8DE94cA665617df2aC1Ffff
```

Retain the complete JSON output and its SHA-256 digest. A passing result must
confirm chain 56, exact WOVEN metadata and supply, Four.meme mode zero, renounced
token ownership, the pinned Safe address and creation evidence, one expected
owner, threshold one, empty modules and guard, canonical fallback handler, and
`TREASURY == PROTOCOL_SAFE`.

This phase is read-only. It signs nothing and grants no future permission.

## Phase 2: constituent and route evidence

1. Resolve every bStock address from a primary issuer source. Do not infer an
   address from a ticker, logo, DEX pair, or search result.
2. Run `npm run bstocks:verify` with explicit `SYMBOL=ADDRESS` inputs and retain
   its JSON output and digest.
3. Complete the issuer, proxy or beacon, ERC-8056, transfer-control, custody,
   redemption, and jurisdiction review for NVDAB, MSFTB, TSLAB, and QQQB.
4. Record fresh mainnet route code hashes, pools, liquidity observations,
   exact-output probes, price ceilings, blocks, and UTC times.
5. Derive and independently compare `CONFIRM_ROUTE_CONFIG_HASH`. A second
   reviewer must approve the decoded inputs, not only the hash text.

No transaction is signed in this phase.

## Phase 3: core deployment

Use the exact environment gates in
[`contracts/README.md`](../contracts/README.md). Set chain ID `56`, the final
WOVEN address, the pinned Safe for both `PROTOCOL_SAFE` and `TREASURY`, and the
pinned owner as `EXPECTED_SAFE_OWNER`.

First simulate without an account and without `--broadcast`:

```bash
cd contracts
forge script script/DeployCore.s.sol:DeployCore \
  --rpc-url "$WOVEN_BNB_RPC_URL" \
  --sender 0xREPLACE_WITH_PUBLIC_DEPLOYER
```

After independent comparison of the simulation and manifest, either broadcast
with a reviewed Foundry signer:

```bash
forge script script/DeployCore.s.sol:DeployCore \
  --rpc-url "$WOVEN_BNB_RPC_URL" \
  --account woven-deployer \
  --sender 0xREPLACE_WITH_PUBLIC_DEPLOYER \
  --broadcast \
  --slow
```

or generate the nonce-bound `core` MetaMask plan from the same dry-run artifact
with `npm run release:console:prepare-foundry`. Do not use both submission paths
for one attempt. Re-read the sender's pending nonce immediately before choosing
the path.

Record one successful receipt and created address for each contract:

- `CreatorLicense`;
- `CanonicalAssetRegistry`;
- `FeeSplitter`;
- `CuratorGuardian`;
- `BasketFactory`.
- `FeeSplitter.initFactory(BasketFactory)` as the sixth core transaction.

For each output, record constructor arguments, runtime code hash, verified source
URL, and immutable/read-back wiring. Preserve the Foundry broadcast artifact,
but never commit an external keystore or authenticated RPC URL.

## Phase 4: registry admission through the existing Safe

Only after the constituent review is approved, encode the exact `setAssets`
call documented in [`contracts/README.md`](../contracts/README.md). In the Safe
transaction review, compare all of these values before signing:

- Safe: `0xF97FC34f97E556271E824D4011A02E5Fa78658fE` on chain 56;
- target: the confirmed `CanonicalAssetRegistry` deployment;
- value: `0` wei;
- operation: `CALL`;
- decoded function: `setAssets(address[],bool)`;
- ordered addresses: the four independently approved bStocks;
- support flag: `true`;
- Safe nonce and calldata hash: exact manifest values.

MetaMask signs the explicit Safe owner request. The completed record needs both
the Safe transaction hash and the successful BNB Chain executor transaction
receipt. Read back every registry entry, registry owner, and pending owner after
execution. A queued or signed Safe proposal is not completion.

## Phase 5: exact-output router deployment

Run `DeployBuyRouter.s.sol` without `--broadcast` first. Confirm the fresh route
configuration hash and every code-hash, implementation, pool, route, probe, and
price-ceiling input. Then broadcast with the reviewed Foundry signer.

Record separate successful creation receipts for:

- `UniswapV4ExactOutputAdapter`;
- `PancakeV3ExactOutputAdapter`;
- `OneClickBasketRouter`.

Record source verification, runtime hashes, immutable routes, adapter order,
output-token read-backs, and zero starting balances. Do not deploy the compiled
Pancake v2 adapter in the initial route set.

## Phase 6: creator license

The address configured as `EXPECTED_CREATOR` must own at least 10,000 WOVEN and
must be the Foundry broadcast sender for `DeployCoreFour.s.sol`. Record it as a
separate role even if it equals the Safe owner or earlier deployment signer.

The creator signs two direct transactions:

1. WOVEN `approve(CreatorLicense, 10000e18)`;
2. `CreatorLicense.burnForLicense()`.

Record both receipts. Read back the final allowance, `isLicensed(creator)`, the
creator WOVEN delta, and the dead-address WOVEN delta. The sink transfer does
not reduce WOVEN `totalSupply()`.

## Phase 7: CORE4 creation

1. Record the current `BasketFactory.basketCount()`.
2. Run `DeployCoreFour.s.sol` without `--broadcast` and with
   `CONFIRM_CORE_FOUR_CONFIG_HASH` initially unset to obtain the calculated
   configuration hash.
3. Independently review the creator, all dependencies, asset order, raw-unit
   conversions, routes, 30 bps fee, and supply caps.
4. Set the reviewed hash, simulate again, then broadcast with a Foundry signer
   whose address exactly equals the licensed `EXPECTED_CREATOR`.
5. Record the successful factory transaction, emitted CORE4 address, runtime
   hash, verified source, factory count delta, creator mapping, exact ordered
   raw recipe, fee recipient, guardian, fee, and caps.

Do not reuse a stale factory count or retry before checking the original
transaction receipt and `basketCount()`.

## Phase 8: low-value mainnet canary

With a dedicated small amount of USDC, obtain a fresh quote and short deadline.
Sign only the minimum required USDC approval, if the allowance is insufficient,
then sign one bounded `mintWithUsdc` canary.

Record the approval receipt when applicable and always record the canary receipt,
quote block, deadline, per-leg maxima, total maximum, payer USDC debit and
refund, CORE4 output, required constituent outputs, and final router/adapter
residual balances. The canary passes only if every configured postcondition and
zero-residual check passes. A fork simulation is not a mainnet canary.

## Phase 9: web release and final sign-off

1. Copy only confirmed public addresses and read-back raw units into the
   mainnet Vercel environment.
2. Build from the recorded commit with `VITE_BNB_NETWORK=mainnet`.
3. Deploy, then record the deployment ID, immutable deployment URL, production
   domain, environment-address digest, security-header probe, desktop/mobile
   evidence, and final build digest.
4. Confirm every write action points to chain 56 and the recorded contracts.
5. Obtain contract engineering, independent security, Safe operations,
   external-asset, legal/jurisdiction, and web-release sign-off.

The release is complete only when every required manifest item has status
`confirmed`, every receipt has status `1`, every contract has verified
read-backs, and no blocking exception remains. A domain, GitHub repository, CA,
wallet connection, local test pass, or web deployment alone is not an onchain
launch record.

## Retry and incident rule

Before any retry, query the original transaction hash and sender nonce. If it
confirmed, continue from its actual receipt and post-state. If it reverted,
preserve the receipt and open a new attempt record. If it remains pending, do
not submit a replacement until the operator has explicitly reviewed the nonce,
fee replacement, and effects of either transaction confirming. Never edit a
confirmed manifest entry to make a later transaction look like the original.
