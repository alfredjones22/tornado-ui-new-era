# Tornado withdrawals: disposable executors, batches, and smart-account actions

Date: 2026-11-07. Design discussion; no implementation or deployment is included.

## Recommendation

Use two explicit paths rather than making every withdrawal depend on a user-controlled EIP-7702 account:

1. **Plain withdrawal:** a new batch-capable paymaster withdraws every selected note directly to the destination during validation. Its UserOp has no execution calls. The browser can generate and sign with a disposable executor; the user supplies no wallet signature or extra key. This is the smallest coherent contract change that gives plain single- and multi-note withdrawals the same fund-routing safety. Its gating question is bundler acceptance and validation gas at useful batch sizes.
2. **Withdrawal plus actions:** an off-the-shelf smart account is both the withdrawal recipient and the UserOp sender. The user's existing EOA controls that account and signs its UserOp. It receives the withdrawals and executes the actions itself. **This appears compatible with the existing Tornado paymaster; the substantial change is generalizing the SDK beyond its current EIP-7702 account implementation.** No EIP-7702 authorization is needed for this path.

These meet the two requested use cases without requiring a separate orchestrator in the advanced path. If keeping that orchestrator separate is itself a requirement, paths C and D below address it, with more contract and authorization work.

**The basic path needs an on-chain implementation change. The advanced smart-account path can use unchanged off-the-shelf account code and the existing paymaster.** Those are different claims: deploying a standard account is not changing its implementation, but it is still a deployment unless the user already has that account.

Do not promise that all withdrawals remain private if later actions fail. With the current fee-collection model, the sponsoring note is spent during validation. We can keep its proceeds safe at the recipient, but execution failure does not put that note back in Tornado.

## 1. The model today

### Four distinct roles

| Role | Meaning |
| --- | --- |
| Bundler | Submits the outer Ethereum transaction and receives gas compensation. |
| EntryPoint | Validates the UserOp, calls its account, and settles gas. |
| UserOp sender / executor | The account whose signature authorizes the UserOp and whose code executes its `callData`. Currently the SDK uses an EIP-7702-delegated EOA. |
| Withdrawal recipient | The address embedded in a Tornado proof that receives the note's principal, less that proof's fee. It need not generally be the UserOp sender. |

“Caller” is ambiguous here. During validation the paymaster calls the pool; during execution the account calls the pool. Neither call requires the pool's payout address to be that caller. The restriction we are discussing is imposed by our paymaster.

ERC-4337 allocates `callGasLimit` to the main execution call into the sender. It does not impose a general identity between the sender and an asset recipient. Its standard `eip7702Auth` parameter, however, is signed by the UserOp sender, not an arbitrary second account. See [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337).

### The three phases

1. **Validation:** the sender validates its UserOp signature. The paymaster then executes the sponsoring Tornado withdrawal, receives its fee, and checks that the fee covers the maximum sponsored cost.
2. **Execution:** EntryPoint calls the sender. Today its batch withdraws the remaining notes and then forwards funds or runs custom tail calls.
3. **Post-operation settlement:** the paymaster attempts to send the excess fee to its refund recipient.

The inspected SDK already has a direct single-note path: one note, no tail calls, proof recipient equals the requested destination, and empty execution calldata with `callGasLimit = 0`. For batches, it currently proves withdrawals to the executor and consolidates there. See [current SDK withdrawal construction](/Users/x/dev/personal/kohaku/packages/tornado-cash/src/state/thunks/paymasterWithdrawThunk.ts:195).

### Why our paymaster demands zero execution gas for a separate recipient

The current rule is effectively:

```solidity
if (proofRecipient != userOp.sender && callGasLimit != 0) revert;
```

See [the exact guard](/Users/x/dev/personal/kohaku-contracts/privacy-paymaster/contracts/BasePrivacyPaymaster.sol:220) and [its Tornado call site](/Users/x/dev/personal/kohaku-contracts/privacy-paymaster/contracts/tornadocash/TornadoPaymaster.sol:73).

Its purpose is authorization of gas spending. A Classic Tornado proof binds the payout address and fee, but does not bind a particular UserOp or its execution calldata. Without another check, someone who sees a proof could attach it to their own account and spend the proof's fee budget on their own execution. Requiring the sender to be the proof recipient ties execution to the account the note owner chose to pay.

Important qualifications:

- This is an application-level anti-griefing policy, not a requirement of Tornado or ERC-4337.
- An attacker cannot change the proof's payout address or increase its committed fee. The issue is unauthorized use of that fee and loss of an expected refund, not an ability to redirect the entire note.
- This guard is not complete protection against every copied-proof attack. In particular, zero execution gas does not eliminate validation and pre-verification charges.
- Simply attaching a signature from a newly generated executor does not fix the missing link: an attacker can generate a different key and signature. Something the note author authorized must bind that executor or execution policy.

If preventing arbitrary account-validation work from consuming a copied proof's fee is also required, constrain the accepted account implementation/factory or add an authenticated intent. SDK-side gas checks cannot constrain an attacker using a different client. The present rule is narrower than a complete proof-to-operation commitment.

Classic's public inputs and permissionless withdrawal entry point are visible in [Tornado.sol](https://raw.githubusercontent.com/tornadocash/tornado-core/master/contracts/Tornado.sol) and [the withdrawal circuit](https://github.com/tornadocash/tornado-core/blob/master/circuits/withdraw.circom).

### Why a reverting forward can strand funds

Suppose three notes use the current consolidation path:

1. The sponsoring note pays its principal to executor S during validation.
2. Execution withdraws the other two notes to S.
3. Execution forwards the combined balance to final recipient R.

If step 3 reverts, the execution batch reverts. The two execution-phase withdrawals are undone. **The sponsoring withdrawal was outside that execution frame, so its principal can remain on S.** EntryPoint may still charge gas and settle the paymaster.

If the failed call occurs after forwarding, that forward can also roll back with the enclosing execution batch. Moving the forward earlier or adding an unconditional final sweep to the same frame does not solve outer reverts or out-of-gas failures.

This follows the separate validation and execution frames in [EntryPoint v0.8](/Users/x/dev/personal/kohaku-contracts/privacy-paymaster/lib/account-abstraction/contracts/core/EntryPoint.sol:201), including [the inner execution call](/Users/x/dev/personal/kohaku-contracts/privacy-paymaster/lib/account-abstraction/contracts/core/EntryPoint.sol:376).

| Failure | Sponsoring note | Execution-phase notes | Main recovery issue |
| --- | --- | --- | --- |
| Validation fails and the outer transaction reverts | Unspent | Unspent | No committed withdrawal from that attempt. EIP-7702 authorization processing has separate persistence semantics. |
| Execution batch reverts | Spent; validation payout remains | Reverted/unspent | Who owns the validation payout address? |
| Execution succeeds, excess-fee transfer fails | Spent | Spent | Where is the failed refund recorded and recoverable? |
| A public proof is submitted directly to its pool | That proof can be spent independently | Other proofs need not be spent | A UserOp signature does not make Classic proofs exclusive to that UserOp. |

EIP-7702 delegation updates are not rolled back with a failed transaction's execution; “throwaway” does not mean the delegation automatically disappears. See [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702).

## 2. Breaking-change ratings

Ratings describe engineering and integration impact, not a proposed semver number:

- **1/5:** SDK routing or policy change using existing contracts.
- **2/5:** contained new paymaster feature or an account adapter using existing account contracts.
- **3/5:** new authorization or account-safety model across contracts and SDK.
- **4/5:** materially different fee collection or sponsorship architecture.
- **5/5:** new pool/circuit assumptions or migration of protocol state.

| Path | Rating | Existing Tornado pools and note strings | Paymaster change | Basic flow without user signatures | Actions in one UserOp |
| --- | --- | --- | --- | --- | --- |
| Existing SDK/CLI bridge: recoverable executor | 1/5 | Compatible | No | Does not give the desired disposable-account guarantee | Yes, with custody/recovery caveats |
| **A. All notes paid directly during validation** | **2/5** | Compatible | New batch-capable version | **Yes** | Separate authorized execution design needed |
| **B. Standard recipient smart account is the sender** | **2/5** | Compatible | **No apparent need** | Requires a real owner signature; intended for advanced mode | **Yes** |
| C. Separate disposable sender, recipient-authorized intent | 3/5 | Compatible | New authorization guard | Requires recipient authorization, so not the basic mode alone | Yes |
| D. Proof-bound fee receiver / executor | 4/5 | Compatible; proof construction changes | New fee collection | Yes | Yes, with the recipient's account authorizations |
| E. Executor with permanent permissionless recovery | 3/5 | Compatible | Not essential for the core recovery approach | Yes, but custom account/recovery machinery | Yes |
| F. Separate fee note / independent gas budget | 4/5 | Compatible at pool level | Refund/fee policy changes | Yes, if the funding requirements are met | Yes |
| New circuits or pools with native intent commitments | 5/5 | Existing pools do not gain the new capability | Yes | Potentially | Potentially |

All proposed paths need integration testing. The ratings do not mean a new contract deployment is risk-free. A new paymaster can be added alongside the existing one; old prepared operations must continue targeting their original contract and encoding.

### Which paths need no smart contract code changes?

| Path | New/custom Solidity code? | Deployments | SDK/UI changes | Does it meet the basic disposable-executor goal? |
| --- | --- | --- | --- | --- |
| Existing wallet-controlled executor | No | Current EOA delegation only | Already supported in substance | No: relies on retaining control of the receiving executor. |
| **B: standard recipient smart account is sender** | **No** | Possibly a standard account and, if unavailable, its unchanged standard factory/implementation | Generic account adapter, deployment, nonce, wallet signing | **No: user signs as the account owner. Meets advanced mode.** |
| **A: direct validation batch** | **Yes: batch paymaster** | New paymaster version | Batch encoder, proving and estimation | **Yes**, subject to admission limits. |
| E: public-recovery executor | Yes: account/recovery behavior, even if the paymaster is unchanged | Account implementation/factory as needed | Recovery-aware routing and receipts | Can remove key dependence, but recovery may be a second operation. |
| N independent direct single-note UserOps | No | Existing transport/account mechanism | Multi-submission UI and tracking | Disposable transport per note, **but not one UserOp**. |

If R is already a compatible deployed smart account, B can need neither new Solidity code nor new deployments. It still needs its owner's valid authorization. Off-the-shelf account support is not present merely because the current SDK accepts an external EIP-7702 signer.

### Why an SDK-only fix cannot satisfy every basic-flow requirement

Under the inspected paymaster and the SDK's current standard account implementation:

1. Choose a disposable sender S and an unrelated final recipient R.
2. If the sponsoring proof pays R, the existing guard forces zero execution gas. The paymaster collects only one note, and there is no execution budget to withdraw the remaining notes.
3. If the sponsoring proof pays S, execution is allowed, but the sponsoring principal and its refund are now routed to S.
4. Any forwarding implemented only in execution can be skipped by an execution revert or out-of-gas failure. The validation payout remains committed.

Therefore changing SDK calldata, signatures, or estimation alone cannot simultaneously give **one UserOp + arbitrary R + no user account authorization + disposable S + no stranded protocol funds**. We must change an on-chain implementation or relax one of those requirements.

Making R the sender is the important exception for advanced mode: it removes the unrelated disposable sender and uses the receiving account's authorization. It does not magically let an SDK sign for an arbitrary third-party address.

Sending N independent direct singles could provide a frontend “withdraw several” gesture without a contract change. It costs separate UserOp overhead, lacks the requested single-UserOp semantics, and is not guaranteed to be included in one outer transaction. It is a comparison point, not a proposal to reinstate the previously rejected withdrawal queue.

## 3. Path A: withdraw the entire batch during validation

**Best first candidate for the basic Tornado frontend.**

Extend the paymaster's data from one withdrawal to an explicit bounded array. Each proof pays the actual destination R. The first proof can pay the total fee to the paymaster; the others can have zero fee. The paymaster executes the complete array during validation. Execution calldata is empty and `callGasLimit` remains zero.

### What this buys us

- Single and multiple notes have the same payout model.
- Neither principal nor the refund is routed through the disposable executor.
- R can be an EOA or a compatible receiving contract, without signing anything.
- The browser generates the executor's authorization and UserOp signature internally. No user-managed executor key or authorization prompt.
- If a withdrawal within this validation batch fails, the enclosing transaction must revert; earlier withdrawals in that same attempt are rolled back too. Do not catch a failed note and silently continue a partial batch.
- Refunds can keep using the sponsoring proof's recipient R. No independently mutable refund address is needed for this mode.

This is a contract and SDK change, not a fix achievable merely by changing gas estimation. The inspected paymaster interface only collects one sponsoring withdrawal.

### What we would change

**Paymaster:** bounded array decoding; allowlisted pools and assets; a clear common-recipient policy; duplicate-note rejection; fee accounting; all-or-revert withdrawal collection; and an unambiguous versioned payload. Enforce empty execution calldata and zero execution gas for this mode, rather than merely assuming the SDK supplied them. Initially restrict a batch to one asset. Mixed denominations are straightforward; multiple fee assets introduce extra accounting and pricing problems.

**SDK:** build all proofs to R; put them in paymaster data rather than execution calldata; estimate the enlarged validation path with zero execution gas; keep the host-derived fee bounds and explicit fee budget. Reject a batch whose fee cannot be paid by the sponsoring note. Splitting the fee across several notes can be a later feature.

### The main drawback: admission and validation gas

This moves N proof verifications into validation. Gas and payload grow with N. It may be acceptable on the bundlers we use, but a target such as 12 notes must be measured, not assumed.

The canonical ERC-7562 policy currently lists a 500,000 verification-gas bound and forbids value-bearing validation calls outside specific EntryPoint exceptions. Our withdrawal-during-validation architecture already relies on relaxed policies for some operations; native payouts and ERC-20 oracle access need explicit scrutiny. A contract can work on-chain and still be rejected by a bundler. See [ERC-7562](https://eips.ethereum.org/EIPS/eip-7562).

Consequently: prototype and trace 1, 2, 4, 8, and 12 notes against the intended bundler before making this the only batch design. Raising a client-side ceiling does not make a provider accept the operation.

### Limits

This mode intentionally does not run custom user actions. Adding arbitrary execution by just removing the guard reintroduces the authorization problem.

Also, payout failure and refund failure differ. For native Classic pools, a rejected principal transfer makes the withdrawal revert; token transfers follow the token's behavior. A postOp refund needs its own failure handling. See [ETH payout behavior](https://raw.githubusercontent.com/tornadocash/tornado-core/master/contracts/ETHTornado.sol) and [ERC-20 payout behavior](https://raw.githubusercontent.com/tornadocash/tornado-core/master/contracts/ERC20Tornado.sol).

A contract might accept ETH from a pool but reject a later transfer from the paymaster. The proposed mode guarantees no protocol-created balance on the disposable executor; guaranteeing recovery of every failed refund additionally requires the refund/claim mechanism described below. Unsolicited transfers to the executor are outside the protocol's payout guarantee.

## 4. Path B: the recipient is a standard smart account and the UserOp sender

**Best first candidate for the advanced flow, incorporating the off-the-shelf account requirement.**

Let R be a standard smart contract account controlled by the user's existing EOA. Make R the UserOp sender as well as the proof recipient. EntryPoint itself supplies the orchestration; a separate disposable account is unnecessary.

1. Derive or select R using a supported account implementation and factory.
2. If R is undeployed, include its factory deployment in the UserOp. Account creation occurs before paymaster validation.
3. The EOA owner signs R's UserOp using its normal wallet.
4. The sponsoring note pays R during paymaster validation.
5. R executes the other withdrawals to itself, then its swaps, deposits, transfers, or other actions.
6. The paymaster refunds R.

The current `proofRecipient == userOp.sender` rule is satisfied. There is no EIP-7702 delegation of the owner's EOA and no need for `wallet_signAuthorization`.

### Off-the-shelf account choice

The EntryPoint v0.8 reference **SimpleAccount + SimpleAccountFactory** is a concrete compatibility starting point: an EOA owner signs the UserOp, the account supports execution, and the factory provides a deterministic address. It is explicitly a reference/sample implementation; choosing a production deployment still requires verifying its exact code, factory, EntryPoint version, and upgrade authority. See [SimpleAccount v0.8](https://raw.githubusercontent.com/eth-infinitism/account-abstraction/v0.8.0/contracts/accounts/SimpleAccount.sol) and [its factory](https://raw.githubusercontent.com/eth-infinitism/account-abstraction/v0.8.0/contracts/accounts/SimpleAccountFactory.sol).

A Safe with a suitable ERC-4337 module is another candidate, but “Safe supports 4337” is not sufficient to assume a particular module supports our EntryPoint v0.8 deployment. Pin and test the complete account/module/factory combination.

Do not invent a new wallet account just to run the advanced actions if an existing compatible implementation does the job.

### SDK changes

The SDK currently conflates account address and EOA signer address in its EIP-7702 path. A smart account has a separate owner/signing identity. Add an account adapter that supplies:

- Sender address and optional factory/deployment data.
- Account-specific call encoding and UserOp signing.
- The account's current EntryPoint nonce, rather than a hardcoded zero.
- Account-specific validation/deployment estimation.

Keep the existing external EIP-7702 signer checks intact. Do not weaken them to accept an owner signature for an unrelated sender; add a distinct smart-account path whose on-chain account validates that owner signature.

This can be additive to the public SDK API. Account deployment and nonce handling are significant implementation work, but there is no apparent requirement to change Tornado pools or the paymaster for this route.

### Failure semantics and UX

If the execution batch fails, the sponsoring principal and refund remain at R, a normal account the user controls. The execution-phase notes remain unspent. This avoids an inaccessible executor, but it is still a partially completed withdrawal at the protocol level.

Show R explicitly as the receiving smart account, retain its implementation/factory/owner/salt metadata, and provide ordinary account recovery and balance visibility. An owner EOA is not automatically the same receiving address as its smart account.

This route does not satisfy the basic “withdraw to any address without wallet involvement” goal by itself. Giving a standard account a random owner and then deleting that owner's key would recreate the original problem.

There is also a privacy trade-off: the account's owner/configuration can be public. Making a receiving account owned by the same EOA that made deposits can reveal a relationship the user wanted to avoid. Display the ownership choice; do not silently choose a familiar depositing EOA as owner. Batched notes also become publicly linked to each other by the shared withdrawal operation, regardless of which executor design is used.

## 5. Path C: keep the orchestrator separate and require a recipient-authorized intent

Here the disposable sender S runs the UserOp; every proof pays R directly. The paymaster allows nonzero execution gas because R has authorized a specific withdrawal/execution intent.

For an EOA, that can be an EIP-712 signature. For a deployed smart account, an account-compatible signature check can use [ERC-1271](https://eips.ethereum.org/EIPS/eip-1271). Counterfactual account signatures require additional deployment/verification design; do not assume an undeployed R can already answer `isValidSignature`.

The authorization should bind at least the chain, EntryPoint, paymaster, executor S, recipient, ordered pool/nullifier set, execution policy or calls hash, maximum fee/gas exposure, and validity/replay limits. Define precisely which fields may be refined during gas estimation. An authorization with bounds can avoid repeated wallet prompts when only estimated gas changes within those bounds.

Avoid a signing cycle: a signature embedded in paymaster data cannot naïvely sign a UserOp hash that includes that same signature. Use a defined intent digest or canonical signature-excluded encoding.

### Standard account behind the orchestrator

Your proposed separation is possible, but the account must expose an entry point an external relayer can invoke with owner authorization.

- A Safe's native signed `execTransaction` is an example.
- An ERC-1271 validation method alone is not an execution method.
- The reference SimpleAccount's ordinary `execute` admits its owner or EntryPoint, not an arbitrary separate orchestrator. It works naturally as the UserOp sender in path B; it is not interchangeable with a Safe's signed-relay interface.

For a Safe-backed route, verify the returned success result as well as outer call success; configure its internal gas reimbursement deliberately so it does not unintentionally add another fee on top of the paymaster. The account's signed call bundle can execute as the Safe, giving downstream applications the correct `msg.sender`. See [Safe v1.4.1's execution interface](https://raw.githubusercontent.com/safe-global/safe-smart-account/v1.4.1/contracts/Safe.sol).

### Trade-offs

Principal never needs to sit on S. But recipient participation is mandatory, so this cannot replace path A for an arbitrary third-party destination. It also adds an authorization layer beyond the recipient's ordinary action signature unless that action format explicitly covers the required sponsorship policy.

If R must be deployed during this operation, its creation and authorization checks must be designed together. Validation is not a free-form factory execution environment. Path B is considerably simpler for first-use smart accounts.

## 6. Path D: bind the executor through the proof's fee-receiver address

**A stronger separate-orchestrator architecture without changing Classic circuits, but more invasive than A or B.**

The proof already binds a `relayer` address. Our implementation currently fixes it to the paymaster, but Classic's pool does not require that choice.

One concrete design is a factory-created session account S with a permanent recovery recipient R:

1. The sponsoring proof pays principal directly to R and names S as its fee receiver (`relayer`).
2. The paymaster requires that proof's fee receiver to be the UserOp sender S, using a supported account implementation.
3. During validation the pool pays its fee to S; a narrowly authorized collection hook transfers that fee to the paymaster before validation succeeds.
4. Remaining withdrawal calls pay R directly. S can invoke R's standard signed execution method for advanced actions.
5. PostOp refunds go directly to R.

This creates the missing proof-to-executor link: a copier cannot substitute a different sender and still satisfy the proof-bound fee-receiver constraint. The sender's own account signature then authorizes its UserOp.

S holds a fee transiently, but no withdrawal principal. A successful validation must leave no protocol fee stranded on S. Collection failure must revert validation, undoing the sponsoring withdrawal. Verify actual fee receipt; do not trust a collector's claimed transfer amount.

### Why a custom fee-collection hook is necessary

The current Simple7702Account does not let an arbitrary paymaster transfer assets out of it. ETH and ERC-20 fee collection need explicit, constrained support. Also, ERC-20 transfers do not generally invoke a receiver callback, so an ETH-only automatic-forwarding trick is not enough.

### Public proof submission and recovery

A sponsoring proof can be submitted directly to its pool without using our paymaster. That pays the principal to R but can leave the fee on S. The design therefore needs a permanent, permissionless way to return that fee to fixed recipient R without S's owner key.

A factory account with R committed in its immutable configuration can provide this. Include counterfactual recovery: if a proof is exposed before deployment, the deployment/recovery descriptor must remain available, or its parameters must be reconstructible. “The factory can deploy it” is not a sufficient guarantee if the necessary initialization data has been lost.

If the literal requirement is that the orchestrator never even transiently receives a fee, use a separate proof-bound fee collector instead. Its address must commit to the authorized executor/intent, and its deployment and recovery introduce additional machinery. An unsigned collector configuration attached to paymaster data is not enough.

### Verdict

This can support both requested modes and keep principal off the orchestrator. It changes the fee-collection trust boundary, adds account/collector code, and is not an off-the-shelf-account-only integration. I would consider it if separate orchestration becomes essential or path A fails practical batch-size admission tests.

## 7. Path E: permanent public recovery instead of guaranteeing no custody

Keep the current payout-to-executor architecture, but make loss of its signing key irrelevant to recovery. A session account has a fixed recovery recipient R, and anyone can request a sweep that can only pay R.

This can preserve the current paymaster's recipient-equals-sender rule. It is much stronger than “the key can theoretically be rederived from a note,” and handles a reverting execution batch or a refund arriving after execution.

However:

- It is custom account behavior, not something every standard account provides.
- A failed execution may need another gas-paying recovery transaction.
- A rejected ETH transfer needs a defined claim or wrapping alternative. Token freezes and unsupported token behavior cannot be made universally recoverable by an SDK.
- Counterfactual deployment metadata must survive proof exposure and browser closure.
- A signed recovery certificate can work with a 7702 account, but it must be durably available; a certificate in browser memory is not a recovery guarantee.

This is a reasonable alternative when “no extra private key to manage” is the requirement and a public recovery operation is acceptable. It does not satisfy the stronger “executor never holds principal” design preference.

The recent CLI change is a simpler recovery bridge: its executor is a normal saved HD account visible in balances. That helps the CLI; it is not the frontend's disposable-executor solution.

## 8. Path F: separate the gas payment from all principal execution

For stronger execution atomicity, use a dedicated fee note or an independently secured gas budget. The fee collection happens in validation; all intended principal withdrawals and actions happen in execution.

A fee-note variation spends the sponsoring note entirely into the fee budget and returns unused value to a separately authorized refund destination. The executor receives no principal from that fee note. This requires changing the SDK's current rejection of a fee consuming the whole sponsoring denomination and changing/refining paymaster refund authorization.

Downsides include requiring an appropriately sized extra note, exposing that entire note as the committed fee budget, and handling copied-proof submissions that bypass normal settlement. This is a product and economic change, not just a new calldata encoding.

The alternative is a paymaster that fronts gas against a credit balance, collateral, or trusted sponsorship. Merely moving fee collection into execution is unsafe: if execution reverts before collecting the fee, the paymaster still owes gas. A proof that funds might be withdrawn later is not itself payment.

This path can make the principal batch and actions revert together while a separate gas payment remains committed. It cannot make a failed Ethereum operation cost no gas, and it is not the least invasive way to meet the stated goals.

## 9. Changes I would not choose

### Delete the guard and leave everything else unchanged

Small diff, incomplete authorization model. It prevents neither proof transplantation nor unauthorized consumption of the refund budget. It also does nothing to fix existing routing of funds through the executor. Reject as the default design.

### Send only the later notes directly to R

Useful damage reduction, but the sponsoring principal and refund still go to the executor. It does not make the executor disposable. It can be an incremental improvement for a recoverable-account path, not the final basic frontend guarantee.

### Try harder to forward in a reverting execution batch

More accurate simulation helps reliability, not the guarantee. Another call can revert, a target can change state, or the execution can run out of gas. Recovery cannot depend solely on code in the frame that might revert.

### Run arbitrary actions during paymaster validation

This superficially places everything in one reverting frame, but substantially worsens validation policy, gas, callback, and state-dependency issues. Keep plain proof collection distinct from user application execution.

### Add an unsigned refund-recipient or executor field

It must be authenticated by the note/proof, the authorized account, or a defined intent commitment. A convenient new field is not itself consent to redirect money or spend fees.

### Add an execution commitment to Classic's proof without changing its verifier

Classic has a fixed public-input format. Its root and nullifier have protocol meanings; ETH pools require `refund = 0`. Those fields are not spare arbitrary context slots. A new circuit/verifier/pool design can support native intent binding, but it does not retrofit that feature into existing Classic pools.

## 10. Guarantees the SDK should expose

Prefer high-level safe modes over a caller having to understand the paymaster's internals:

- **Plain payout:** explicit final recipient; one asset; no principal or refund routed to the transport account. Fail if the selected backend cannot provide that property.
- **Smart-account execution:** explicit receiving account and its adapter, explicit authorized actions, owner signing through the host wallet, ordinary account recovery.
- **Separate orchestrator:** an advanced mode with an explicit authorization/recovery model. Do not silently select it because another estimate failed.

The SDK should keep payout recipient, refund recipient, UserOp account, owner signer, and action-executing account conceptually separate. Some modes deliberately make several equal; the types should not assume they are always equal.

Additional invariants:

1. Never substitute a known-recoverable or random custody account as a silent fallback for a requested direct payout.
2. Do not expose a random execution account in a custody-producing mode without an enforced recovery route.
3. Cap total fee exposure, gas prices, and gas quantities. Report the maximum committed fee and minimum payout separately from a possible later refund.
4. The refund arrives after execution. Custom actions must not budget money that is only returned in postOp.
5. Verify final signed operations with realistic full-flow simulation. Test account deployment and paymaster validation together; do not simulate away fee checks or withdraw failure paths and call that a guarantee.
6. After a reverted UserOp, inspect per-note nullifiers and payouts. Never blindly resubmit the whole batch or label all notes unspent.
7. Preserve a public operation/recovery receipt before exposing signed payloads. Preparation sent to a bundler is already disclosure of a potentially executable candidate.
8. Match the deployed account, factory, EntryPoint, and paymaster versions. An account's code and owner signature format are part of the integration.

The current paymaster catches an unsuccessful refund transfer and emits `RefundFailed`; it does not create a recipient-owned claim balance. A new paymaster should consider a bounded refund push with a protected claimable fallback. Credits must be backed and excluded from administrative sweeps. Test postOp out-of-gas and rollback separately; “we catch transfer failure” alone does not cover them. See [current refund handling](/Users/x/dev/personal/kohaku-contracts/privacy-paymaster/contracts/BasePrivacyPaymaster.sol:167).

### Atomicity should be an explicit promise

There are three different promises:

| Promise | Feasible with the recommended paths? |
| --- | --- |
| One UserOp pays multiple notes and runs actions on success | Yes. |
| No protocol-created principal is lost on a throwaway transport account if execution fails | Yes: direct payout paths; or user-owned recipient account in advanced mode. |
| Every note remains private if any later action fails | Not with the current sponsoring-withdrawal-in-validation model. Requires separating gas funding from principal, or a materially different architecture. |

Classic proofs can also be copied and submitted independently. A signature around a UserOp does not change that pool-level property. Absolute non-strippable multi-note intent would require additional protocol/receiver enforcement, not just a relayed wallet signature.

## 11. Least invasive plan to test next

1. **Advanced-mode spike with no Tornado contract change:** use a pinned off-the-shelf EntryPoint v0.8 account as recipient and sender. Have an ordinary browser-wallet EOA sign its UserOp. Test deployment, two-note withdrawal, a normal action, and a deliberately reverting action. Verify balances, refunds, account recovery, and repeat use with a nonzero account nonce.
2. **Basic-mode contract spike:** add a separate experimental batch-validation paymaster and SDK encoder. Benchmark 1/2/4/8/12 same-asset notes on the exact intended bundler. Include native and supported ERC-20 cases. Keep the old paymaster path available while assessing admission limits.
3. **Choose based on those results:** if validation batches are practical, A + B is the smallest coherent product architecture. If not, investigate D or E for the unsigned basic frontend rather than pretending a recoverable random account is disposable.

Specific adversarial cases to cover before shipping:

- Failure in the second/last note, rejection of ETH, token transfer failure, and deliberately insufficient execution gas.
- Action reverts after some successful execution calls; a wallet method returns failure without reverting.
- Refund recipient rejects payment or consumes its allotted callback gas.
- Proof copied into a different UserOp and proof submitted straight to the pool.
- Lost browser session after preparation, after disclosure, after inclusion, and after execution failure.
- A first-use counterfactual recipient and a reused recipient with a nonzero EntryPoint nonce.
- Changed gas quotes, payload limits, single-note fee capacity, and maximum batch sizes.

## Appendix: implications for other protocols

### Privacy Pools v1

Reuse the separation of payout, transport, action execution, and refund destinations. The current SDK's adapter encoding already has proof-context-bound fee and refund fields, which gives it more room for authenticating intent than Classic Tornado's fixed public inputs. But its direct extra-note withdrawal path pays the executing processooor; direct-to-third-party batching may require an adapter, not just changing the address supplied to the SDK. See [adapter encoding](/Users/x/dev/personal/kohaku/packages/privacy-pools/src/paymaster/adapter-data.ts:24).

The local `kohaku-contracts` checkout contains an older PP paymaster shape than the current SDK's adapter encoding. Do not infer current PP deployment capabilities from that older file alone. Any PP proposal needs a separate deployed-adapter review.

### Railgun

Carry over the same account/recipient separation, explicit failure promises, recovery invariants, and typed SDK account adapters. Its WETH-based gas-payment and privacy-paymaster flow need their own analysis; do not copy Tornado's validation-note or relayer-field design onto it by analogy. No Railgun deployment or current failure behavior was audited for this document.

## Evidence and scope

- SDK inspected: `/Users/x/dev/personal/kohaku`, branch `fix/tornado-delegation`, commit `bb369a2d`; Tornado package manifest `0.1.0-alpha.35`. These are local source observations, not a registry or deployment verification.
- Paymaster source inspected: `/Users/x/dev/personal/kohaku-contracts`, branch `chore/sepolia-deployments`, commit `1b23e91`.
- EntryPoint and account examples: local vendored v0.8 code, cross-checked against [upstream EntryPoint v0.8](https://github.com/eth-infinitism/account-abstraction/blob/v0.8.0/contracts/core/EntryPoint.sol) and the account sources linked above.
- The numbered designs are proposals and engineering judgments. Their exact gas, bundler admission, and recovery behavior have not been demonstrated by a new prototype in this discussion.
- Existing frontend, SDK, CLI, and contract implementation files were not changed for this document.
