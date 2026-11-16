import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, erc20Abi, type Address, type Hex } from 'viem'
import { atomicBatchAvailable, depositCalls, executeDeposits, type Progress, type WalletProvider } from '../src/core/wallet'
import { poolFor } from '../src/core/catalog'
import { generateNote } from '../src/core/notes'
import type { ConnectionSettings } from '../src/core/rpc'

const { readContract, waitForTransactionReceipt } = vi.hoisted(() => ({ readContract: vi.fn(), waitForTransactionReceipt: vi.fn() }))
vi.mock('../src/core/rpc', () => ({ publicClientFor: () => ({ readContract, waitForTransactionReceipt }), validateConnections: vi.fn() }))
const account: Address = '0x1111111111111111111111111111111111111111'
const hash: Hex = `0x${'ab'.repeat(32)}`
const settings: ConnectionSettings = { chainId: 1, rpcUrl: 'https://example.com', bundler: 'pimlico', bundlerUrl: 'https://example.com' }
const call = (id: string) => ({ id, label: id, to: account, data: '0x' as Hex, value: 0n })
function wallet(send: (method: string) => unknown): WalletProvider {
  return { request: vi.fn(async ({ method }) => method === 'eth_chainId' ? '0x1' : method === 'eth_accounts' ? [account] : send(method)) }
}
beforeEach(() => vi.clearAllMocks())
describe('wallet-native batching', () => {
  it('requires supported atomic capability on the selected chain', async () => {
    expect(await atomicBatchAvailable(wallet(() => ({ '0x1': { atomic: { status: 'supported' } } })), account, 1)).toBe(true)
    expect(await atomicBatchAvailable(wallet(() => ({ '0x1': { atomic: { status: 'ready' } } })), account, 1)).toBe(false)
    expect(await atomicBatchAvailable(wallet(() => ({ '0xaa36a7': { atomic: { status: 'supported' } } })), account, 1)).toBe(false)
    expect(await atomicBatchAvailable(wallet(() => { throw new Error('Unsupported') }), account, 1)).toBe(false)
  })
  it('does not fall back and resend after an ambiguous native-batch failure', async () => {
    const provider = wallet(() => { throw new Error('Connection dropped') })
    const statuses: Progress['status'][] = []
    await expect(executeDeposits({ provider, account, settings, calls: [call('a'), call('b')], atomic: true,
      update: (_, p) => { if (p.status) statuses.push(p.status) } })).rejects.toThrow()
    expect(statuses).toContain('unknown')
    expect(vi.mocked(provider.request).mock.calls.some(([p]) => p.method === 'eth_sendTransaction')).toBe(false)
  })
  it('retains a batch identifier when receipt polling fails', async () => {
    const provider = wallet(method => { if (method === 'wallet_sendCalls') return { id: 'batch-123' }; throw new Error('Disconnected') })
    const patches: Partial<Progress>[] = []
    await expect(executeDeposits({ provider, account, settings, calls: [call('a'), call('b')], atomic: true, update: (_, p) => patches.push(p) })).rejects.toThrow()
    expect(patches.some(p => p.batchId === 'batch-123')).toBe(true)
  })
})
describe('sequential deposit progress', () => {
  it('stops at the failed receipt and keeps earlier confirmations', async () => {
    const rows: Record<string, Partial<Progress>> = {}
    const provider = wallet(() => hash)
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success' }).mockResolvedValueOnce({ status: 'reverted' })
    await expect(executeDeposits({ provider, account, settings, atomic: false, calls: [call('a'), call('b'), call('c')],
      update: (id, p) => { rows[id] = { ...rows[id], ...p } } })).rejects.toThrow('reverted')
    expect(rows.a?.status).toBe('confirmed'); expect(rows.b?.status).toBe('failed'); expect(rows.c).toBeUndefined()
    expect(vi.mocked(provider.request).mock.calls.filter(([p]) => p.method === 'eth_sendTransaction')).toHaveLength(2)
  })
  it('marks a timed-out receipt unknown and preserves its hash', async () => {
    waitForTransactionReceipt.mockRejectedValue(new Error('Timed out'))
    let row: Partial<Progress> = {}
    await expect(executeDeposits({ provider: wallet(() => hash), account, settings, atomic: false, calls: [call('a')], update: (_, p) => { row = { ...row, ...p } } })).rejects.toThrow()
    expect(row.status).toBe('unknown'); expect(row.hash).toBe(hash)
  })
  it('does not submit on a wallet chain mismatch', async () => {
    const provider = { request: vi.fn(async ({ method }: { method: string }) => method === 'eth_chainId' ? '0xaa36a7' : [account]) }
    await expect(executeDeposits({ provider, account, settings, atomic: false, calls: [call('a')], update: vi.fn() })).rejects.toThrow('Switch your wallet')
    expect(provider.request.mock.calls).toHaveLength(2)
  })
  it.each([true, false])('stops when a different account becomes selected even if the original remains authorized (atomic: %s)', async atomic => {
    const provider = { request: vi.fn(async ({ method }: { method: string }) => method === 'eth_chainId' ? '0x1'
      : method === 'eth_accounts' ? ['0x2222222222222222222222222222222222222222', account] : hash) }
    await expect(executeDeposits({ provider, account, settings, atomic, calls: [call('a')], update: vi.fn() })).rejects.toThrow('account changed')
    expect(provider.request.mock.calls.some(([call]) => ['wallet_sendCalls', 'eth_sendTransaction'].includes(call.method))).toBe(false)
  })
})
describe('ERC-20 deposit approvals', () => {
  it('resets nonzero allowances and approves only the exact combined amount', async () => {
    const pool = poolFor(1, '100', 'USDT')!
    const notes = await Promise.all([generateNote(pool), generateNote(pool)])
    readContract.mockImplementation(async ({ functionName }) => functionName === 'denomination' ? pool.amount : 1n)
    const calls = await depositCalls(notes, settings, account)
    expect(calls).toHaveLength(4)
    const approvals = calls.slice(0, 2).map(c => decodeFunctionData({ abi: erc20Abi, data: c.data }))
    expect(approvals.map(a => a.args![1])).toEqual([0n, pool.amount * 2n])
    expect(calls.every(c => c.value === 0n)).toBe(true)
  })
  it('adds no approval when the allowance already covers the cart', async () => {
    const pool = poolFor(1, '100', 'USDC')!
    readContract.mockResolvedValue(pool.amount)
    expect(await depositCalls([await generateNote(pool)], settings, account)).toHaveLength(1)
  })
})
