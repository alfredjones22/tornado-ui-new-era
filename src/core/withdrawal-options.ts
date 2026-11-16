import type { TCPaymasterUnshieldOptions, TypedDataSigner } from '@kohaku-eth/tornado-cash'
import { createTx } from '@kohaku-eth/provider'
import { reviewedCalls, type SmartWithdrawalScope } from './smart-withdrawal-policy'
import { smartWithdrawalGasLimits } from './withdrawal-gas'

/** The frame and SDK worker share these options. No tails means direct payout
 * for one note; never add an empty callback to force intermediate custody. */
export function paymasterOptions(scope?: SmartWithdrawalScope, signer?: TypedDataSigner): TCPaymasterUnshieldOptions {
  if (!scope) return { mode: 'paymaster', gasEstimationPolicy: 'best-effort',
    maxGasLimits: { verificationGasLimit: 250_000n, paymasterVerificationGasLimit: 2_000_000n } }
  if (!signer || signer.address.toLowerCase() !== scope.account.owner.toLowerCase()) throw new Error('Missing smart account owner signer.')
  const actions = reviewedCalls(scope), { account } = scope
  return { mode: 'paymaster', gasEstimationPolicy: 'required', maxGasLimits: smartWithdrawalGasLimits(account.deployed),
    delegation: { mode: 'smart-account', signer, account: { kind: 'simple-account', address: account.address,
      ...(!account.deployed ? { factory: { address: account.factory, salt: account.salt } } : {}) },
      nonce: account.nonce, allowUsed: true },
    ...(actions.length ? { executionGasRetry: true, tailCalls: async (sender: string) => {
      if (sender.toLowerCase() !== account.address.toLowerCase()) throw new Error('Unexpected custom-action sender.')
      return actions.map(call => createTx(call.to, call.data, call.value))
    } } : {}),
  }
}
