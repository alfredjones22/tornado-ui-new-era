# Tornado UI — New Era

## Product direction

Keep Classic's black background, mint green, PT Mono, deposit/withdraw tabs, fixed-denomination choices, and adjacent pool information. Build a small Vue 3 + TypeScript + Vite app in this directory; the Nuxt 2 Classic checkout is a read-only design reference. Use the published build of `kohaku/packages/tornado-cash`, pinned to `0.1.0-alpha.36`, for cryptography, the pool catalog, proof generation, and paymaster preparation. For production v0.1, expose only single-note withdrawals. Keep the multi-withdrawal component, supporting modules and tests in source, with its page wiring, route, links and promotional copy removed from the production interface. There is no feature flag. Deposit batching remains available. The completed multi-withdrawal stages below are historical.

## V1 decisions (agreed)

- Ethereum mainnet and Sepolia only. Both deposits and withdrawals use the same SDK catalog intersected with the Tornado paymaster allowlist as kohaku-cli. Mainnet: ETH, DAI, USDC, USDT, WBTC. Sepolia: ETH, DAI. No deposit-only tokens or unsupported cDAI. ERC-20 approvals use exact amounts, with allowance reset when necessary.
- All nine ETH denominations: 0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100. Read addresses from the SDK. Sepolia currently has no 100 ETH pool in that catalog; show it as unavailable. Never invent a deployment.
- Independent Classic-compatible `tornado-<currency>-...` notes by default. Offer an optional new 24-word seed phrase for each deposit session, using the SDK signature derivation at `m/29795'/1'/0'` and consecutive nonces 0 through N−1 across all selected denominations. Include both the phrase and raw notes in the required downloaded backup. No phrase input/import, account creation, persistent note vault or seed-based withdrawal flow.
- One note cart is the sole selection interface: choose a token, then minus/count/plus controls per denomination, with itemized subtotals, a running total and note count. Sessions have no note cap; wallet batches contain at most 12 ETH notes or 5 token notes and confirm one at a time. One note is a single deposit; several notes are a batch. Each deposit creates a separate note. The amount-entry/automatic CLI packing alternative was discussed and deliberately dropped in favor of this one interface.
- Deposit execution: wallet-native atomic batching through EIP-5792 when advertised; sequential wallet transactions as a visible fallback. Offer an explicit sequential choice. No application-driven delegation of the connected account. A wallet may itself implement its advertised batching with delegation; that remains in the wallet's consent flow.
- A deposit batch is a convenience queue, not a promise of one transaction or atomic execution. Never automatically fall back after a submission error. Retain each submitted transaction/batch identifier and reconcile receipts before any retry. A partial failure does not undo confirmed deposits.
- Basic withdrawals: paste/import exactly one note and enter one recipient. One review submits exactly one UserOperation by default, or one transaction through an optional Classic TORN relayer. Reject multi-note input; do not queue withdrawals. Finish or reconcile the current withdrawal before starting another. No connected wallet is required. Withdraw the full note, less the quoted paymaster fee; no arbitrary partial-note amounts.
- Use ERC-4337 + the Tornado privacy paymaster by default. Single-note withdrawals also offer registered Classic TORN relayers with a separate service-surcharge disclosure and a “Switch to 4337?” action. The bundler is transport, not the fee-paying paymaster. Pimlico and Custom endpoint choices; validate network and EntryPoint v0.8 support before proving/submission.
- The imported note gets an isolated SDK session and its own recoverable note-derived EIP-7702 executor, which forwards proceeds to the chosen recipient (including a Safe). The recipient does not need to sign or provide a key in this basic flow. Retain the UserOperation hash for receipt checks, with no automatic retry on ambiguous responses.
- Show actual SDK fee quotes and net proceeds before submission. Try bundler estimation first and allow the released SDK's bounded fallback for direct single-note withdrawals. Show fallback quotes as such. Do not label paymaster fees as free. Both proceeds and unused-gas refunds pay the reviewed recipient directly, with zero execution gas and a disposable sender.
- Basic single-note withdrawals keep empty calldata and zero execution gas. The separate smart-account flow accepts 1–12 notes and optional reviewed custom CALL actions after the withdrawals, with a breakout transaction builder and full-operation simulation when supported. Forwarding and custom actions are mutually exclusive.

## Tradeoffs to revisit

1. **Seed phrase:** the later approved option creates a fresh identity for one deposit session only, never imports an existing phrase, and retains all individual raw notes. The phrase exposes the whole batch; any one raw note exposes only that deposit. Withdrawals remain note-only. CLI-compatible discovery uses the unchanged SDK signature scheme, account index zero and a contiguous nonce sequence.
2. **Deposit batching:** EIP-5792 respects wallet capabilities. Sequential deposits work more broadly but require more confirmations and gas, and may partially complete. Do not add a custom batching contract or EIP-7702 account upgrade until there is a concrete need.
3. **Withdrawal batching:** the basic version was committed and the user selected `feat/multi-withdraw` for the separate beta described below. The SDK is now published and the connected-wallet UI is implemented below. Pool/amount/timing and shared-recipient correlations still exist; consolidation does not enlarge a pool's anonymity set.
4. **Pool activity:** show on-chain deposit count with honest loading/error states. It is not a count of distinct users or an assertion of anonymity. No synthetic statistics.
5. **Wallet coverage:** start with injected EIP-1193/EIP-6963 providers. A Safe is usable when exposed through one of these providers; standalone Safe App SDK and WalletConnect require later integration and testing.

## Implementation sequence

- [x] Catalog, amount arithmetic, note validation, independent-note generation.
- [x] Classic-style responsive interface, single/batch deposits, single-note withdrawals, provider settings.
- [x] Wallet discovery, chain checks, public deposits, wallet-native batch detection, receipt tracking.
- [x] SDK browser worker/artifact integration, isolated-note proof/quote preparation, review and paymaster submission (implemented; funded verification pending).
- [x] Meaningful unit tests for money movement, deposit partial progress, single-note withdrawal enforcement, malformed/wrong-chain notes, and provider validation; production build and browser checks. 38 tests pass. Production-preview checks confirm that two pasted notes disable review, while one valid-format note enables it.
- [ ] Sepolia funded end-to-end testing with an explicitly approved test wallet, then mainnet readiness review. No live transactions as part of local development.
- [x] Browser history-cache integration: CDN-hosted public snapshots per pool with pinned checksums, verified Saga catch-up with console-logged RPC fallback, and RPC tail on both networks and withdrawal flows.
- [ ] Executor-fund recovery and session restoration. See README for current limitations.

## Completed beta and upstream signing (historical stage)

- [x] Separate `#multi-withdraw` page/flow. Basic single-note input still rejects multiple notes and requires no receiver key. Deposit batching stays available.
- [x] Accept 1–12 independent notes of one asset in the smart-account flow, allowing different denominations. Reject duplicate/reused nullifiers, mixed assets, unsupported pools and wrong chains.
- [x] Require a pasted, backed-up fresh receiver EOA key in this beta only. Receiver and delegated executor are the same account; proceeds/refunds stay there. Use only zero transaction/EntryPoint nonce checks and required SDK/bundler estimation, without balance or history restrictions.
- [x] Prepare and submit exactly one UserOperation. Validate the sponsoring proof and every direct withdrawal against the selected notes. Reject extra calls or other recipients. No automatic submission retry or per-note withdrawal queue.
- [x] Keep the receiver key in memory during preparation only; clear its field on preparation, network change and leaving the beta page. Exclude it from exports and redact hex secrets in errors. Secure erasure of JavaScript strings is not guaranteed.
- [x] Implement upstream `delegation: { mode: 'external', signer }` on SDK branch `codex/tornado-host-signing`: scoped host bridge, verified signatures, cached authorization, awaited typed-data requests and no delegator-key derivation in external mode. Keep this implementation separate from the UI's dependency.
- [x] Validate the beta with 53 UI unit tests, typecheck/build and browser checks. Upstream: 50 focused tests and worker/declaration builds pass; ten existing root-verification unit failures reproduce against the unchanged commit. No funded transaction has been broadcast.
- [x] Implement the desired connected-wallet UI after the user assessed/committed the beta and published the SDK. Account/network pinning, compatible authorization signing and clear multiple-signature prompts are required. Current estimation may need up to three UserOperation signatures plus one cached delegation authorization.
- [ ] Funded Sepolia verification, including a twelve-note gas estimate and one actual consolidated withdrawal. The 12-note cap is a UI policy, not a promise that every bundler/fee scenario accepts it.

## Connected-wallet implementation (released SDK follow-up)

- [x] Pin the published Tornado Cash SDK to `0.1.0-alpha.35`, retaining its browser-worker integration.
- [x] Replace the beta key input and custom key derivation with `delegation: { mode: 'external', signer }`. Keep the separate multi-note page and unchanged wallet-free single-note flow.
- [x] Review delegation and each concrete batch fee/net/gas budget before the wallet prompt. Pin the selected account/network and verify returned signatures. Reject changed final payloads.
- [x] Expose only authorization and typed-data callbacks through the disposable frame channel. Close it on completion, errors and cancellation; refuse late callbacks after wallet changes.
- [x] Retain exactly one UserOperation submission, unused-EOA validation (zero nonces, no code/delegation), no custom calls, no per-note queue and no automatic retry. Retain the locally computed hash on ambiguous submission.
- [x] Validate with 88 tests, TypeScript checks, production build and browser form checks. Compatible-wallet signing is covered with real test-key signatures through a simulated provider; funded verification remains pending.

## Withdrawal UX refinement

- [x] Default to single-note withdrawal and expose multi-withdrawal as a secondary option inside that flow.
- [x] Remove the ownership/custody acknowledgement checkbox and extra queue/nonce copy. Use “The receiver wallet must be an unused EOA.”
- [x] Check the receiver on connection and show a red inline error below its button for used accounts, contract wallets or existing delegations. Recheck before preparing/submitting; do not add balance or historical-activity requirements.
- [x] Use the top-of-form “Withdraw multiple notes at once? (new)” banner. Start disconnected without querying injected wallets; discover wallets when the chooser opens and request accounts only after explicit selection. Preserve the selected connection across account/network events while invalidating prepared signatures.
- [x] Keep single-note preparation progress/errors next to Review. Reject incomplete pool history and expose historical-RPC failures. Use a Sepolia endpoint that serves old logs, with paced reads and bounded rate-limit retries. 120 regression tests and production build pass; funded withdrawal verification remains pending.

- [x] Ignore redundant wallet notifications during preparation. Preserve actual cancellation reasons and distinguish unsupported authorization methods from invalid parameters. Only warn about executable candidates after sharing a UserOperation signature.

## Operational boundaries

Keep changes local and uncommitted. No deployment, production keys, analytics, note-bearing URLs, or note persistence in localStorage. Public settings may be stored locally; endpoint credentials and notes remain in memory. Session refresh loses in-memory progress; downloaded notes are the recovery source. Do not claim funded verification until it has actually run.

## Reference checks

- Local SDK catalog/config and single-note paymaster end-to-end test inspected on 2026-11-04.
- EIP-5792: https://eips.ethereum.org/EIPS/eip-5792
- Pimlico EIP-7702: https://docs.pimlico.io/guides/eip7702
