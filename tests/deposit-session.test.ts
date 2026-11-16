import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeFunctionData, erc20Abi, toHex, type Address, type Hex } from 'viem'
import { depositBatches, executeDepositSession, reconcileDepositSession } from '../src/core/deposit-session'
import { poolFor, poolsFor } from '../src/core/catalog'
import { poolAbi, type DepositNote } from '../src/core/notes'
import type { ConnectionSettings } from '../src/core/rpc'
import type { DepositCall, Progress, WalletProvider } from '../src/core/wallet'

const { readContract, waitForTransactionReceipt, getTransactionReceipt } = vi.hoisted(() => ({
  readContract: vi.fn(), waitForTransactionReceipt: vi.fn(), getTransactionReceipt: vi.fn(),
}))
vi.mock('../src/core/rpc', () => ({ publicClientFor: () => ({ readContract, waitForTransactionReceipt, getTransactionReceipt }), validateConnections: vi.fn() }))
const account: Address = '0x1111111111111111111111111111111111111111'
const hash = `0x${'ab'.repeat(32)}` as Hex
const settings: ConnectionSettings = { chainId: 1, rpcUrl: 'https://example.com', bundler: 'pimlico', bundlerUrl: 'https://example.com' }
type Call = { to: Address; data: Hex; value: Hex }

// Public synthetic note payloads for wallet transport tests; cryptographic
// derivation and recovery across these boundaries are covered in seed-bundle.
function notes(count: number, symbol = 'ETH'): DepositNote[] {
  const pool = poolFor(1, symbol === 'ETH' ? '0.01' : '100', symbol)!
  return Array.from({ length: count }, (_, i) => {
    const commitment = toHex(BigInt(i + 1), { size: 32 })
    const preimage = toHex(BigInt(i + 1), { size: 62 }).slice(2)
    return { id: `note-${i}`, raw: `tornado-${symbol.toLowerCase()}-${pool.denomination}-1-0x${preimage}`, preimage, commitment, pool,
      call: { to: pool.address, data: encodeFunctionData({ abi: poolAbi, functionName: 'deposit', args: [commitment] }), value: pool.asset.token ? 0n : pool.amount } }
  })
}
function progressFor(selected: DepositNote[]) {
  const rows: Progress[] = selected.map(note => ({ id: note.id, label: note.id, status: 'ready' }))
  const update = (id: string, patch: Partial<Progress>) => {
    const row = rows.find(row => row.id === id)
    if (row) Object.assign(row, patch)
  }
  return { rows, update }
}
function wallet(send: (args: { method: string; params?: unknown[] | object }) => unknown): WalletProvider {
  return { request: vi.fn(async args => args.method === 'eth_chainId' ? '0x1' : args.method === 'eth_accounts' ? [account] : send(args)) }
}
beforeEach(() => {
  vi.resetAllMocks()
  readContract.mockImplementation(async ({ address, functionName }) => functionName === 'denomination'
    ? poolsFor(1).find(pool => pool.address === address)!.amount : 0n)
  waitForTransactionReceipt.mockResolvedValue({ status: 'success' })
})

describe('deposit sessions split by note count', () => {
  it.each([['ETH', 25, [12, 12, 1]], ['USDC', 11, [5, 5, 1]], ['USDT', 6, [5, 1]]] as const)(
    'splits %s notes without dropping or reordering them', (symbol, count, sizes) => {
      const selected = notes(count, symbol)
      const batches = depositBatches(selected)
      expect(batches.map(batch => batch.length)).toEqual(sizes)
      expect(batches.flat()).toEqual(selected)
    })
  it('rejects empty, mixed-asset, mixed-network and duplicate sessions before sending', () => {
    expect(() => depositBatches([])).toThrow('at least one')
    const eth = notes(1), token = notes(1, 'USDC')
    expect(() => depositBatches([...eth, ...token])).toThrow('one asset')
    expect(() => depositBatches([eth[0]!, { ...eth[0]!, pool: poolFor(11155111, '0.01')! }])).toThrow('one network')
    expect(() => depositBatches([eth[0]!, eth[0]!])).toThrow('duplicate')
  })
  it('sends 25 ETH notes as three wallet batches, including the final single note', async () => {
    const sent: Call[][] = []
    const provider = wallet(({ method, params }) => {
      if (method === 'wallet_sendCalls') { sent.push((params as { calls: Call[] }[])[0]!.calls); return { id: `batch-${sent.length}` } }
      if (method === 'wallet_getCallsStatus') return { status: 200, receipts: [{ status: '0x1', transactionHash: hash }] }
      throw new Error(`Unexpected method: ${method}`)
    })
    const selected = notes(25), progress = progressFor(selected), onBatch = vi.fn()
    await executeDepositSession({ notes: selected, provider, account, settings, atomic: true, ...progress, onBatch })
    expect(sent.map(batch => batch.length)).toEqual([12, 12, 1])
    expect(sent.flat().map(call => call.data)).toEqual(selected.map(note => note.call.data))
    expect(onBatch.mock.calls.map(([number, total]) => [number, total])).toEqual([[1, 3], [2, 3], [3, 3]])
    expect(progress.rows.every(row => row.status === 'confirmed')).toBe(true)
    expect(readContract).toHaveBeenCalledTimes(3)
  })
  it('does not send the next batch before the current receipt confirms', async () => {
    let confirm!: (value: unknown) => void
    let sends = 0
    const provider = wallet(({ method }) => {
      if (method === 'wallet_sendCalls') return { id: `batch-${++sends}` }
      if (method === 'wallet_getCallsStatus' && sends === 1) return new Promise(resolve => { confirm = resolve })
      if (method === 'wallet_getCallsStatus') return { status: 200 }
      throw new Error(`Unexpected method: ${method}`)
    })
    const running = executeDepositSession({ notes: notes(13), provider, account, settings, atomic: true, update: vi.fn(), onBatch: vi.fn() })
    await vi.waitFor(() => expect(confirm).toBeTypeOf('function'))
    expect(sends).toBe(1)
    confirm({ status: 200 })
    await running
    expect(sends).toBe(2)
  })
  it('rechecks token allowances after each confirmation and approves only that batch', async () => {
    const selected = notes(11, 'USDC'), pool = selected[0]!.pool
    let allowance = pool.amount * 5n
    const approvals: bigint[] = []
    const sent: Call[][] = []
    readContract.mockImplementation(async ({ functionName }) => functionName === 'denomination' ? pool.amount : allowance)
    const provider = wallet(({ method, params }) => {
      if (method === 'wallet_getCallsStatus') return { status: 200 }
      if (method !== 'wallet_sendCalls') throw new Error(`Unexpected method: ${method}`)
      const calls = (params as { calls: Call[] }[])[0]!.calls
      sent.push(calls)
      for (const call of calls) {
        if (call.to === pool.asset.token) {
          const approval = decodeFunctionData({ abi: erc20Abi, data: call.data })
          allowance = approval.args![1] as bigint
          approvals.push(allowance)
        } else {
          expect(allowance).toBeGreaterThanOrEqual(pool.amount)
          allowance -= pool.amount
        }
      }
      return { id: `batch-${sent.length}` }
    })
    const onBatch = vi.fn<(number: number, total: number, calls: DepositCall[]) => void>()
    await executeDepositSession({ notes: selected, provider, account, settings, atomic: true, update: vi.fn(), onBatch })
    expect(sent.map(calls => calls.filter(call => call.to === pool.address).length)).toEqual([5, 5, 1])
    expect(approvals).toEqual([pool.amount * 5n, pool.amount])
    expect(allowance).toBe(0n)
    const ids = onBatch.mock.calls.flatMap(([, , calls]) => calls.map(call => call.id))
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('stops on an uncertain second batch and reconciles only that submitted batch', async () => {
    let sends = 0, disconnected = true
    const provider = wallet(({ method }) => {
      if (method === 'wallet_sendCalls') return { id: `batch-${++sends}` }
      if (method === 'wallet_getCallsStatus') {
        if (sends === 2 && disconnected) throw new Error('Disconnected')
        return { status: 200, receipts: [{ status: '0x1', transactionHash: hash }] }
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const selected = notes(25), progress = progressFor(selected)
    await expect(executeDepositSession({ notes: selected, provider, account, settings, atomic: true, ...progress, onBatch: vi.fn() })).rejects.toThrow('Disconnected')
    expect(sends).toBe(2)
    expect(progress.rows.slice(0, 12).every(row => row.status === 'confirmed')).toBe(true)
    expect(progress.rows.slice(12, 24).every(row => row.status === 'unknown' && row.batchId === 'batch-2')).toBe(true)
    expect(progress.rows[24]!.status).toBe('ready')
    vi.mocked(provider.request).mockClear(); disconnected = false
    await reconcileDepositSession({ ...progress, settings, provider, account })
    expect(vi.mocked(provider.request).mock.calls.filter(([args]) => args.method === 'wallet_getCallsStatus').map(([args]) => args.params)).toEqual([['batch-2']])
    expect(progress.rows.slice(0, 24).every(row => row.status === 'confirmed')).toBe(true)
    expect(progress.rows[24]!.status).toBe('ready')
    expect(sends).toBe(2)
  })
  it('stops between batches if the connected account changes', async () => {
    let sends = 0
    const provider: WalletProvider = { request: vi.fn(async ({ method }) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_accounts') return [sends ? '0x2222222222222222222222222222222222222222' : account]
      if (method === 'wallet_sendCalls') return { id: `batch-${++sends}` }
      if (method === 'wallet_getCallsStatus') return { status: 200 }
      throw new Error(`Unexpected method: ${method}`)
    }) }
    await expect(executeDepositSession({ notes: notes(13), provider, account, settings, atomic: true, update: vi.fn(), onBatch: vi.fn() })).rejects.toThrow('account changed')
    expect(sends).toBe(1)
  })
  it('keeps sequential wallet compatibility across batch boundaries', async () => {
    const provider = wallet(({ method }) => { if (method === 'eth_sendTransaction') return hash; throw new Error(`Unexpected method: ${method}`) })
    const selected = notes(25), progress = progressFor(selected)
    await executeDepositSession({ notes: selected, provider, account, settings, atomic: false, ...progress, onBatch: vi.fn() })
    expect(vi.mocked(provider.request).mock.calls.filter(([args]) => args.method === 'eth_sendTransaction')).toHaveLength(25)
    expect(progress.rows.every(row => row.status === 'confirmed')).toBe(true)
  })
  it('never confirms future notes when an uncertain send returned no identifier', async () => {
    const rows: Progress[] = [{ id: 'sent', label: 'Sent note', status: 'unknown' }, { id: 'future', label: 'Unsent note', status: 'ready' }]
    const update = vi.fn()
    await expect(reconcileDepositSession({ rows, settings, update })).rejects.toThrow('no identifier')
    expect(update).not.toHaveBeenCalled()
  })
})
