import { describe, expect, it } from 'vitest'
import { encodeFunctionData } from 'viem'
import { actionFixture } from './fixtures/smart-actions'
import { simpleAccountAbi } from '../src/core/smart-account'
import { validateSmartSigningRequest, validateSmartWithdrawal } from '../src/core/smart-withdrawal-policy'
import { batchTypedData } from '../src/core/batch-policy'
import { callsHash } from '../src/core/transaction-builder'
import { settings } from './fixtures/multi-withdrawal'
import { smartFixture } from './fixtures/smart-withdrawal'

describe('smart-account custom action signing policy', () => {
  it.each([1, 2, 12])('accepts exactly the reviewed suffix after %i withdrawals', count => {
    const { quote } = actionFixture(count)
    expect(validateSmartWithdrawal(quote.notes, quote.scope, quote.withdrawal, settings).net).toBe(quote.net)
    expect(validateSmartSigningRequest(batchTypedData(quote.withdrawal, settings), quote.notes, quote.scope, settings).fee).toBe(quote.fee)
  })
  it.each(['eth', 'usdc'].flatMap(symbol => [false, true].map(deployed => ({ symbol, deployed }))))(
    'keeps one-note $symbol custom calls sender-funded (deployed=$deployed)', ({ symbol, deployed }) => {
      const { quote } = actionFixture(1, symbol, deployed)
      expect(BigInt(quote.withdrawal.proof.args[2])).toBe(BigInt(quote.scope.account.address))
      expect(BigInt(quote.withdrawal.userOperation.callGasLimit)).toBeGreaterThan(0n)
      expect(validateSmartWithdrawal(quote.notes, quote.scope, quote.withdrawal, settings).net).toBe(quote.net)
      expect(validateSmartSigningRequest(batchTypedData(quote.withdrawal, settings), quote.notes, quote.scope, settings).fee).toBe(quote.fee)
      quote.withdrawal.userOperation.callGasLimit = '0x0'
      expect(() => validateSmartWithdrawal(quote.notes, quote.scope, quote.withdrawal, settings)).toThrow('require execution gas')
      expect(() => validateSmartSigningRequest(batchTypedData(quote.withdrawal, settings), quote.notes, quote.scope, settings)).toThrow('require execution gas')
    })
  it('supports one note held by the smart account without custom execution', () => {
    const { quote } = smartFixture(1, 'eth', 'account')
    quote.withdrawal.userOperation.callData = '0x'
    expect(validateSmartWithdrawal(quote.notes, quote.scope, quote.withdrawal, settings).net).toBe(quote.net)
  })
  it.each(['target', 'value', 'data', 'order', 'missing', 'extra', 'prefix'])('rejects %s tampering before signing and submission', field => {
    const { quote, calls } = actionFixture()
    if (field === 'target') calls[1]!.target = '0x6666666666666666666666666666666666666666'
    if (field === 'value') calls[1]!.value++
    if (field === 'data') calls[1]!.data = '0xffff'
    if (field === 'order') [calls[1], calls[2]] = [calls[2]!, calls[1]!]
    if (field === 'missing') calls.pop()
    if (field === 'extra') calls.push(calls[1]!)
    if (field === 'prefix') [calls[0], calls[1]] = [calls[1]!, calls[0]!]
    quote.withdrawal.userOperation.callData = encodeFunctionData({ abi: simpleAccountAbi, functionName: 'executeBatch', args: [calls] })
    expect(() => validateSmartSigningRequest(batchTypedData(quote.withdrawal, settings), quote.notes, quote.scope, settings)).toThrow()
    expect(() => validateSmartWithdrawal(quote.notes, quote.scope, quote.withdrawal, settings)).toThrow()
  })
  it('disallows forwarding, self-calls and mutated review metadata with custom calls', () => {
    for (const field of ['forward', 'hash', 'self']) {
      const { quote, actions } = actionFixture()
      if (field === 'forward') { quote.scope.payout = 'custom'; quote.scope.recipient = actions[0]!.to }
      if (field === 'hash') quote.scope.callsHash = callsHash([])
      if (field === 'self') actions[0]!.to = quote.scope.account.address as typeof actions[0]['to']
      expect(() => validateSmartSigningRequest(batchTypedData(quote.withdrawal, settings), quote.notes, quote.scope, settings)).toThrow()
    }
  })
})
