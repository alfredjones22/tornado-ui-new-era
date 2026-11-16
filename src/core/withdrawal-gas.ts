/** Ceilings for successfully estimated smart-account withdrawals, not defaults.
 * First-use verification includes factory deployment as well as account validation;
 * Pimlico's estimate plus the SDK's 20% buffer can exceed 1M on Sepolia. */
export const smartWithdrawalGasLimits = (deployed: boolean) => ({
  verificationGasLimit: deployed ? 1_000_000n : 2_000_000n,
  paymasterVerificationGasLimit: 2_000_000n,
  callGasLimit: 8_000_000n,
})
