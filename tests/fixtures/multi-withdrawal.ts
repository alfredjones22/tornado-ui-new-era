import { TornadoPaymasterConfigs } from '@kohaku-eth/tornado-cash'
import { privateKeyToAccount } from 'viem/accounts'
import { encodeAbiParameters, encodeFunctionData, hashTypedData, parseAbi, parseAbiParameters, toHex } from 'viem'
import { batchTypedData, noteIdentity, SIMPLE_7702_IMPLEMENTATION } from '../../src/core/batch-policy'
import { parseBatchNotes, poolAbi } from '../../src/core/notes'
import type { MultiWithdrawalQuote } from '../../src/core/multi-withdrawal'
import type { ConnectionSettings } from '../../src/core/rpc'
import type { Withdrawal } from '../../src/core/withdrawals'
export const settings: ConnectionSettings = { chainId: 1, rpcUrl: 'https://example.com', bundler: 'pimlico', bundlerUrl: 'https://example.com' }
const key = `0x${'1f'.repeat(32)}` as const
export const signingAccount = privateKeyToAccount(key)
export const recipient = signingAccount.address
const cfg = TornadoPaymasterConfigs[1]
const executorAbi = parseAbi(['function execute(address target, uint256 value, bytes data)', 'function executeBatch((address target, uint256 value, bytes data)[] calls)'])
export const rawNote = (index: number, asset = 'eth', denomination = '1') => `tornado-${asset}-${denomination}-1-0x${index.toString(16).padStart(2, '0').repeat(62)}`
export function fixture(count = 2, asset = 'eth') {
  const notes = parseBatchNotes(Array.from({ length: count }, (_, i) => rawNote(i + 1, asset, asset === 'eth' ? (i % 2 ? '0.1' : '1') : '100')).join('\n'), 1, 1)
  const fee = 1000n, total = notes.reduce((sum, n) => sum + n.pool.amount, 0n)
  const sponsor = notes[0]!, root = toHex(1n, { size: 32 }), nullifier = toHex(noteIdentity(sponsor).nullifierHash, { size: 32 })
  const proof: Withdrawal['proof'] = { proof: '0x1234', args: [root, nullifier, recipient, cfg.paymasterAddress, toHex(fee), '0x0'] }
  const calls = notes.slice(1).map(note => ({ target: note.pool.address, value: 0n, data: encodeFunctionData({ abi: poolAbi, functionName: 'withdraw', args: [proof.proof, root, toHex(noteIdentity(note).nullifierHash, { size: 32 }), recipient, '0x0000000000000000000000000000000000000000', 0n, 0n] }) }))
  const callData = calls.length === 1 ? encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: [calls[0]!.target, 0n, calls[0]!.data] }) : encodeFunctionData({ abi: executorAbi, functionName: 'executeBatch', args: [calls] })
  const withdrawal: Withdrawal = {
    mode: 'paymaster', proof, poolAddress: BigInt(sponsor.pool.address) as Withdrawal['poolAddress'], isERC20: !!sponsor.pool.asset.token,
    paymasterAddress: cfg.paymasterAddress, entryPointAddress: cfg.entryPointAddress, bundlerUrl: settings.bundlerUrl, gasEstimation: { status: 'estimated' }, fee, withdrawnValue: total,
    userOperation: { sender: recipient, nonce: '0x0', callData, callGasLimit: '0x100000', verificationGasLimit: '0x100000', preVerificationGas: '0x100000', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1',
      paymaster: cfg.paymasterAddress, signature: '0x1234', paymasterData: encodeAbiParameters(parseAbiParameters('(address instance, bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, uint256 fee)'), [{ instance: sponsor.pool.address, proof: proof.proof, root, nullifierHash: nullifier, recipient, fee }]),
      eip7702Auth: { chainId: '0x1', address: SIMPLE_7702_IMPLEMENTATION, nonce: '0x0', r: root, s: nullifier, yParity: '0x0' } },
  }
  const quote: MultiWithdrawalQuote = { id: 'batch', notes, recipient, withdrawal, fee, net: total - fee, quotedAt: Date.now(), signedHash: hashTypedData(batchTypedData(withdrawal, settings)) }
  return { quote, withdrawal, calls }
}
