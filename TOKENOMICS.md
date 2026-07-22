# Woven tokenomics

Official BNB Smart Chain contract:
[`0xE40b89313D28d50Ea8DE94cA665617df2aC1Ffff`](https://bscscan.com/token/0xe40b89313d28d50ea8de94ca665617df2ac1ffff).
Protocol activation remains gated until the Four.meme token has graduated and
the launch preflight confirms `_mode() == 0` and renounced ownership.

## Documented parameters

| Parameter                              |     Current value |
| -------------------------------------- | ----------------: |
| `$WOVEN` supply required by the script |     1,000,000,000 |
| Permanent fixed-basket creator license | 10,000 WOVEN once |
| Basket mint fee convention             |    30 bps / 0.30% |
| Maximum contract-supported mint fee    |    50 bps / 0.50% |
| Creator share of mint fees             |               60% |
| Treasury share of mint fees            |               40% |
| Protocol redemption fee                |                0% |
| Initial basket supply cap              |      1,000 tokens |

The contracts fix the creator-license amount, 50 bps mint-fee ceiling, 60/40 fee
split, and zero protocol redemption fee. The 30 bps mint fee and 1,000-token
initial basket cap are application conventions,
not a factory-wide constant. The included deployment script accepts only the
Four.meme launch token named `Woven Stocks`, symbol `WOVEN`, with 18 decimals,
the stated supply, graduated mode, and renounced ownership. One licensed wallet
can create multiple fixed baskets.

## What `$WOVEN` does

`$WOVEN` unlocks basket creation. It does not back basket tokens and does not grant its holder ownership of the assets in every Woven basket. Each basket contract is backed separately by the constituent ERC-20s deposited into it.

`CreatorLicense` transfers exactly 10,000 WOVEN from the creator to the hard-coded
`0x000000000000000000000000000000000000dEaD` sink. The deployer cannot redirect
it. The transfer is checked using the sink's exact balance increase, which rejects
fee-on-transfer behavior.

The license contract does not call an ERC-20 burn function. Sending tokens to the
sink removes them from circulating balances but does **not** reduce the token's
`totalSupply()` value.

## Basket fees

For a basket configured at 30 bps, the mint fee is issued in basket tokens:

- 18 bps of the gross mint goes to the basket creator economically;
- 12 bps goes to the protocol treasury;
- redemption returns constituents pro rata with no protocol fee.

Distribution is permissionless through the `FeeSplitter`; it is not a promise of continuous automatic payout. Network costs, token transfer behavior, price impact and any external swap costs are separate.

## Deployment requirements

A deployment using the included script requires:

1. the final Four.meme `$WOVEN` contract after graduation, with exact name,
   symbol, 18 decimals, 1,000,000,000 total tokens, `_mode() == 0`, and
   `owner() == address(0)`;
2. a canonical Safe v1.4.1 with one expected owner, threshold one, no modules or
   guard, and the required fallback handler; the same Safe address is used for
   `PROTOCOL_SAFE` and `TREASURY`;
3. independently verified official bStock contracts, including raw-decimal and
   ERC-8056 scaled-UI behavior plus proxy, compliance, pause, blacklist, seizure,
   jurisdiction, custody, and redemption restrictions;
4. independent security and legal review outside the guarantees of this codebase.

The owner supplies only a public wallet address to the preparation and
verification scripts. Signing remains in the wallet; no private key or seed
phrase belongs in this repository.
