import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Host } from '@kohaku-eth/plugins'
import { assertImportedNotes, assertPoolHistoryComplete, checkedHistoryProvider } from '../src/core/pool-history'
import { parseNote } from '../src/core/notes'
import type { PublicSnapshot } from '../src/core/withdrawals'
const note = parseNote(`tornado-eth-1-11155111-0x${'ab'.repeat(62)}`, 11155111)
function snapshot(block: string | undefined): PublicSnapshot {
  return { test: { pools: { poolsTuples: [[note.pool.address, { lastSyncedBlock: block }]] } } } as unknown as PublicSnapshot
}
afterEach(() => vi.useRealTimers())

describe('complete pool history before withdrawal preparation', () => {
  it('accepts a selected pool synced at least through the head at sync start', () => {
    expect(() => assertPoolHistoryComplete(snapshot('0x64'), [note], 100n)).not.toThrow()
    expect(() => assertPoolHistoryComplete(snapshot('0x65'), [note], 100n)).not.toThrow()
  })
  it('rejects silently failed pool syncs even if another pool or global cursor is current', () => {
    for (const state of [{}, snapshot(undefined), snapshot('0x63')]) {
      expect(() => assertPoolHistoryComplete(state, [note], 100n)).toThrow('history is incomplete')
    }
    const wrongPool = snapshot('0x64'); Object.values(wrongPool)[0]!.pools.poolsTuples[0]![0] = '0x1'
    expect(() => assertPoolHistoryComplete(wrongPool, [note], 100n)).toThrow('history is incomplete')
  })
  it('keeps historical RPC errors visible when the SDK swallows the failed pool task', async () => {
    const original = new Error('RPC Request failed', { cause: new Error('pruned history unavailable') })
    const getLogs = vi.fn().mockRejectedValue(original), progress = vi.fn()
    const history = checkedHistoryProvider({ getLogs } as unknown as Host['provider'], progress)
    await expect(history.provider.getLogs({})).rejects.toBe(original)
    expect(() => history.assertHealthy()).toThrow('RPC has pruned the pool history')
    expect(progress).not.toHaveBeenCalled()
  })
  it('reports other history failures without exposing endpoint credentials or request data', async () => {
    const history = checkedHistoryProvider({ getLogs: vi.fn().mockRejectedValue(new Error('https://private.example/key request body secret')) } as unknown as Host['provider'], vi.fn())
    await expect(history.provider.getLogs({})).rejects.toThrow('private.example')
    expect(() => history.assertHealthy()).toThrow('Pool history could not be downloaded')
    try { history.assertHealthy() } catch (e) { expect((e as Error).message).not.toMatch(/private|secret/) }
  })
  it('reports real sync activity and preserves successful RPC results', async () => {
    const logs: never[] = [], progress = vi.fn()
    const history = checkedHistoryProvider({ getLogs: vi.fn().mockResolvedValue(logs) } as unknown as Host['provider'], progress)
    expect(await history.provider.getLogs({})).toBe(logs)
    expect(progress).toHaveBeenCalledWith('Syncing pool history… 1 block range checked.')
    expect(() => history.assertHealthy()).not.toThrow()
  })
  it('backs off for temporary rate limits without hiding a recovered read', async () => {
    vi.useFakeTimers()
    const getLogs = vi.fn().mockRejectedValueOnce(new Error('Rate limited')).mockResolvedValue([])
    const history = checkedHistoryProvider({ getLogs } as unknown as Host['provider'], vi.fn())
    const read = history.provider.getLogs({})
    await vi.runAllTimersAsync(); await expect(read).resolves.toEqual([])
    expect(getLogs).toHaveBeenCalledTimes(2)
    expect(() => history.assertHealthy()).not.toThrow()
  })
  it('bounds rate-limit retries and retains an explicit sync failure', async () => {
    vi.useFakeTimers()
    const error = new Error('Rate limited'), getLogs = vi.fn().mockRejectedValue(error)
    const history = checkedHistoryProvider({ getLogs } as unknown as Host['provider'], vi.fn())
    const result = history.provider.getLogs({}).catch(value => value)
    await vi.runAllTimersAsync()
    expect(await result).toBe(error)
    expect(getLogs).toHaveBeenCalledTimes(4)
    expect(() => history.assertHealthy()).toThrow('Pool history could not be downloaded')
  })
  it('paces parallel pool reads through a shared request interval', async () => {
    vi.useFakeTimers()
    const starts: number[] = []
    const getLogs = vi.fn(async () => { starts.push(Date.now()); return [] })
    const history = checkedHistoryProvider({ getLogs } as unknown as Host['provider'], vi.fn(), 250)
    const results = Promise.all([history.provider.getLogs({}), history.provider.getLogs({})])
    await vi.runAllTimersAsync(); await results
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(250)
  })
  it('allows independent pools to read RPC history concurrently', async () => {
    const finish: ((logs: []) => void)[] = []
    const getLogs = vi.fn(() => new Promise<[]>(resolve => { finish.push(resolve) }))
    const history = checkedHistoryProvider({ getLogs } as unknown as Host['provider'], vi.fn())
    const reads = Promise.all([history.provider.getLogs({ address: note.pool.address }), history.provider.getLogs({ address: '0x1111111111111111111111111111111111111111' })])
    expect(getLogs).toHaveBeenCalledTimes(2)
    finish[1]!([]); finish[0]!([])
    await expect(reads).resolves.toEqual([[], []])
    expect(() => history.assertHealthy()).not.toThrow()
  })
  it('distinguishes a missing deposit from wrong-network and wrong-pool imports', () => {
    expect(() => assertImportedNotes([{ status: 'imported', poolAddress: BigInt(note.pool.address) }], [note])).not.toThrow()
    expect(() => assertImportedNotes([{ status: 'not-found' }], [note])).toThrow('No matching deposit')
    expect(() => assertImportedNotes([{ status: 'wrong-chain' }], [note])).toThrow('different network')
    expect(() => assertImportedNotes([{ status: 'imported', poolAddress: 1n }], [note])).toThrow('expected pool')
    expect(() => assertImportedNotes([], [note])).toThrow('did not finish importing')
  })
})
