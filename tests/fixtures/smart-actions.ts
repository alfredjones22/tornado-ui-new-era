import { encodeFunctionData, hashTypedData, type Hex } from 'viem'
import { simpleAccountAbi } from '../../src/core/smart-account'
import { batchTypedData } from '../../src/core/batch-policy'
import { callsHash } from '../../src/core/transaction-builder'
import { settings } from './multi-withdrawal'
import { smartFixture } from './smart-withdrawal'

export function actionFixture(count = 2, symbol = 'eth', deployed = false) {
  const fixture = smartFixture(count, symbol, 'account', deployed), { quote, calls } = fixture
  const actions = [{ to: '0x4444444444444444444444444444444444444444' as const, value: 10n, data: '0x1234' as Hex },
    { to: '0x5555555555555555555555555555555555555555' as const, value: 0n, data: '0x5678' as Hex }]
  quote.scope.calls = actions; quote.scope.callsHash = callsHash(actions)
  calls.push(...actions.map(call => ({ target: call.to, value: call.value, data: call.data })))
  quote.withdrawal.userOperation.callData = encodeFunctionData({ abi: simpleAccountAbi, functionName: 'executeBatch', args: [calls] })
  quote.withdrawal.userOperation.callGasLimit = '0x100000'
  quote.signedHash = hashTypedData(batchTypedData(quote.withdrawal, settings))
  return { ...fixture, actions }
}
