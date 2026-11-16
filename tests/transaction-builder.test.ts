import { describe, expect, it } from 'vitest'
import { decodeFunctionData, parseAbi, parseEther } from 'viem'
import { callsHash, canonicalCalls, encodeBuilderCall, ethValue, exportSafeBatch, importSafeBatch, parseContractAbi } from '../src/core/transaction-builder'

const to = '0x4444444444444444444444444444444444444444', sender = '0x3333333333333333333333333333333333333333'
const calls = [{ to, value: 123n, data: '0xabcd' }] as const
describe('transaction builder encoding and Safe interchange', () => {
  it('roundtrips only exact public CALL payloads and binds their order', () => {
    const json = exportSafeBatch(calls, 1)
    expect(importSafeBatch(json, 1)).toEqual(calls)
    expect(Object.keys(JSON.parse(json).transactions[0])).toEqual(['to', 'value', 'data', 'contractMethod', 'contractInputsValues'])
    expect(callsHash(calls)).not.toBe(callsHash([...calls, { to: sender, value: 0n, data: '0x' }]))
    expect(callsHash([...calls, { to: sender, value: 0n, data: '0x' }])).not.toBe(callsHash([{ to: sender, value: 0n, data: '0x' }, ...calls]))
  })
  it.each(['0x1', '0xzz', 'abcd'])('rejects malformed hex: %s', data => {
    expect(() => canonicalCalls([{ to, value: 0n, data: data as `0x${string}` }])).toThrow('hex')
  })
  it('enforces bounded CALL-only lists and prevents account self-admin calls', () => {
    expect(() => canonicalCalls([{ to: sender, value: 0n, data: '0x' }], sender)).toThrow('recovery')
    expect(() => canonicalCalls([{ to: '0x0000000000000000000000000000000000000000', value: 0n, data: '0x' }])).toThrow('nonzero')
    expect(() => canonicalCalls([{ to, value: -1n, data: '0x' }])).toThrow('uint256')
    expect(() => canonicalCalls(Array.from({ length: 13 }, () => calls[0]))).toThrow('12')
    expect(() => canonicalCalls([{ to, value: 0n, data: `0x${'ff'.repeat(16385)}` }])).toThrow('too large')
    const batch = JSON.parse(exportSafeBatch(calls, 1))
    batch.transactions[0].operation = 1
    expect(() => importSafeBatch(JSON.stringify(batch), 1)).toThrow('delegatecall')
    expect(() => importSafeBatch(exportSafeBatch(calls, 1), 11155111)).toThrow('network')
  })
  it('encodes ABI arrays, tuples, bools, overloaded signatures and exact integers', () => {
    const abi = parseAbi(['function act((address who,uint256 amount)[] items,bool enabled)', 'function act(uint256 amount)'])
    const writable = parseContractAbi(JSON.stringify(abi))
    const call = encodeBuilderCall(to, 0n, writable[0]!, [JSON.stringify([{ who: sender, amount: '90071992547409930' }]), 'true'])
    expect(decodeFunctionData({ abi, data: call.data }).args).toEqual([[{ who: sender, amount: 90071992547409930n }], true])
    expect(call.label).toBe('act((address,uint256)[],bool)')
    expect(() => encodeBuilderCall(to, 0n, writable[1]!, [90071992547409930])).toThrow('Quote large integers')
    expect(() => encodeBuilderCall(to, 1n, writable[1]!, ['1'])).toThrow('does not accept ETH')
    expect(ethValue('0.000000000000000001')).toBe(1n)
    expect(ethValue('1.5')).toBe(parseEther('1.5'))
    expect(() => ethValue('1e3')).toThrow()
  })
  it('imports Safe ABI-only calls and rejects contradictory raw calldata', () => {
    const batch = { version: '1.0', chainId: '1', transactions: [{ to, value: '0', data: null,
      contractMethod: { name: 'transfer', payable: false, inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] }, contractInputsValues: { to: sender, amount: '42' } }] }
    const [call] = importSafeBatch(JSON.stringify(batch), 1)
    expect(call!.data.slice(0, 10)).toBe('0xa9059cbb')
    expect(importSafeBatch(JSON.stringify({ ...batch, transactions: [{ ...batch.transactions[0], data: call!.data }] }), 1)[0]!.data).toBe(call!.data)
    expect(() => importSafeBatch(JSON.stringify({ ...batch, transactions: [{ ...batch.transactions[0], data: '0x' }] }), 1)).toThrow('disagree')
  })
})
