import { describe, expect, it, vi } from 'vitest'
import { createTx } from '@kohaku-eth/provider'
import { paymasterOptions } from '../src/core/withdrawal-options'
import { smartFixture } from './fixtures/smart-withdrawal'
import { actionFixture } from './fixtures/smart-actions'

describe('SDK withdrawal option handoff', () => {
  it('uses the recoverable SDK default for basic direct withdrawals without an execution callback or retry opt-in', () => {
    const options = paymasterOptions()
    expect(options.gasEstimationPolicy).toBe('best-effort')
    for (const key of ['delegation', 'tailCalls', 'executionGasRetry']) expect(options).not.toHaveProperty(key)
    expect(options.maxGasLimits).toEqual({ verificationGasLimit: 250_000n, paymasterVerificationGasLimit: 2_000_000n })
  })
  it.each([false, true].flatMap(deployed => (['account', 'wallet', 'custom'] as const).map(payout => ({ deployed, payout }))))(
    'omits tails and retries for the $payout route without custom calls (deployed=$deployed)', ({ deployed, payout }) => {
      const { scope } = smartFixture(1, 'eth', payout, deployed), signer = { address: scope.account.owner, signTypedData: vi.fn() }
      const options = paymasterOptions(scope, signer)
      expect(options.gasEstimationPolicy).toBe('required')
      expect(options).not.toHaveProperty('tailCalls'); expect(options).not.toHaveProperty('executionGasRetry')
      expect(options.maxGasLimits!.callGasLimit).toBe(8_000_000n) // A ceiling alone does not opt in.
      expect(options.delegation).toMatchObject({ mode: 'smart-account', signer, nonce: scope.account.nonce, allowUsed: true,
        account: { kind: 'simple-account', address: scope.account.address } })
      if (options.delegation?.mode !== 'smart-account') throw new Error('Expected smart account')
      expect(!!options.delegation.account.factory).toBe(!deployed)
    })
  it.each([1, 2].flatMap(count => ['eth', 'usdc'].flatMap(symbol => [false, true].map(deployed => ({ count, symbol, deployed })))))(
    'explicitly enables bounded retries and exact custom calls for $count $symbol notes (deployed=$deployed)', async ({ count, symbol, deployed }) => {
      const { scope, actions } = actionFixture(count, symbol, deployed), signer = { address: scope.account.owner, signTypedData: vi.fn() }
      const options = paymasterOptions(scope, signer)
      expect(options.executionGasRetry).toBe(true)
      expect(options.maxGasLimits!.callGasLimit).toBe(8_000_000n)
      expect(await options.tailCalls!(scope.account.address)).toEqual(actions.map(call => createTx(call.to, call.data, call.value)))
      await expect(options.tailCalls!(scope.account.owner)).rejects.toThrow('Unexpected custom-action sender')
      expect(signer.signTypedData).not.toHaveBeenCalled()
    })
  it('rejects a missing or different owner signer', () => {
    const { scope } = smartFixture()
    expect(() => paymasterOptions(scope)).toThrow('owner signer')
    expect(() => paymasterOptions(scope, { address: scope.account.address, signTypedData: vi.fn() })).toThrow('owner signer')
  })
})
