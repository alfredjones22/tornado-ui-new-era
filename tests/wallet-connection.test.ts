import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWalletConnection } from '../src/core/wallet-connection'
import type { WalletOption } from '../src/core/wallet'

const first = '0x1111111111111111111111111111111111111111'
const second = '0x2222222222222222222222222222222222222222'
function wallet(id = 'test') {
  let accounts = [first]
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const request = vi.fn(async ({ method }: { method: string }): Promise<unknown> => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return accounts
    if (method === 'eth_chainId') return '0xaa36a7'
    throw new Error('Unsupported method')
  })
  const option: WalletOption = { id, name: id, provider: { request,
    on(event, listener) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(listener) },
    removeListener(event, listener) { listeners.get(event)?.delete(listener) },
  } }
  return { option, request, setAccounts: (next: string[]) => { accounts = next }, emit: (event: string, ...args: unknown[]) => listeners.get(event)?.forEach(fn => fn(...args)), listeners }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const monitored: ReturnType<typeof createWalletConnection>[] = []
afterEach(() => { monitored.splice(0).forEach(connection => connection.dispose()); vi.useRealTimers(); vi.unstubAllGlobals() })
function watching() {
  vi.useFakeTimers()
  const browser = new EventTarget(), document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('window', browser); vi.stubGlobal('document', document)
  const connection = createWalletConnection(); monitored.push(connection)
  connection.startWatching()
  return { connection, browser, document }
}

describe('browser wallet connection state', () => {
  it('silently restores existing permissions without requesting permissions or capabilities', async () => {
    const w = wallet(), connection = createWalletConnection()
    await connection.restore(w.option)
    expect(connection.state.value).toMatchObject({ wallet: w.option, account: first, chainId: 11155111 })
    expect(w.request.mock.calls.map(([q]) => q.method)).toEqual(['eth_accounts', 'eth_chainId'])
    connection.dispose()
  })
  it.each(['locked', 'empty'])('keeps an %s wallet disconnected without a prompt', async mode => {
    const w = wallet(), connection = createWalletConnection()
    w.request.mockImplementation(async ({ method }) => { if (mode === 'locked') throw new Error('Locked'); return method === 'eth_accounts' ? [] : '0xaa36a7' })
    await connection.restore(w.option)
    expect(connection.state.value.account).toBeNull()
    expect(w.request.mock.calls.some(([q]) => q.method === 'eth_requestAccounts')).toBe(false)
    connection.dispose()
  })
  it('requires explicit selection when several providers are authorized, and deduplicates aliases', async () => {
    const a = wallet('a'), b = wallet('b'), connection = createWalletConnection()
    await connection.restore(a.option)
    await connection.restore({ ...a.option, id: 'alias' })
    expect(connection.state.value.account).toBe(first)
    await connection.restore(b.option)
    expect(connection.state.value.account).toBeNull()
    await connection.connect(b.option)
    expect(connection.state.value.wallet?.id).toBe('b')
    connection.dispose()
  })
  it('updates the selected account and keeps it connected when the chain changes', async () => {
    const w = wallet(), connection = createWalletConnection()
    await connection.connect(w.option)
    const revision = connection.state.value.revision
    w.emit('accountsChanged', [second]); w.emit('chainChanged', '0x1')
    expect(connection.state.value).toMatchObject({ account: second, chainId: 1, revision: revision + 2 })
    w.emit('accountsChanged', [])
    expect(connection.state.value.account).toBeNull()
    connection.dispose()
  })
  it('does not invalidate a session when the provider repeats the same connection context', async () => {
    const w = wallet(), connection = createWalletConnection()
    await connection.restore(w.option)
    const revision = connection.state.value.revision
    w.emit('connect'); await tick()
    w.emit('accountsChanged', [first, second]); w.emit('chainChanged', '0xaa36a7')
    expect(connection.state.value.revision).toBe(revision)
    expect(connection.state.value).toMatchObject({ account: first, chainId: 11155111 })
    // A real change away and back must still invalidate the previous session.
    w.emit('accountsChanged', [second]); w.emit('accountsChanged', [first])
    expect(connection.state.value.revision).toBe(revision + 2)
    connection.dispose()
  })
  it('does not let stale account reads overwrite an account-change event', async () => {
    const w = wallet(), connection = createWalletConnection()
    let resolveAccounts!: (value: string[]) => void
    w.request.mockImplementation(async ({ method }) => method === 'eth_accounts' ? new Promise<string[]>(resolve => { resolveAccounts = resolve }) : method === 'eth_chainId' ? '0xaa36a7' : [first])
    const pending = connection.connect(w.option)
    await tick()
    w.emit('accountsChanged', [second]); resolveAccounts([first])
    await pending
    expect(connection.state.value.account).toBe(second)
    connection.dispose()
  })
  it('uses the account read even if a chain event arrives during connection', async () => {
    const w = wallet(), connection = createWalletConnection()
    let resolveChain!: (value: string) => void
    w.request.mockImplementation(async ({ method }) => method === 'eth_chainId' ? new Promise<string>(resolve => { resolveChain = resolve }) : [first])
    const pending = connection.connect(w.option)
    await tick()
    w.emit('chainChanged', '0x1'); resolveChain('0xaa36a7')
    await pending
    expect(connection.state.value).toMatchObject({ account: first, chainId: 1 })
    connection.dispose()
  })
  it('restores accounts after provider reconnection and handles an unavailable reconnect RPC', async () => {
    const w = wallet(), connection = createWalletConnection()
    await connection.connect(w.option)
    w.emit('disconnect'); expect(connection.state.value.account).toBeNull()
    w.request.mockRejectedValueOnce(new Error('Offline'))
    w.emit('connect'); await tick(); expect(connection.state.value.account).toBeNull()
    w.emit('connect'); await tick(); expect(connection.state.value.account).toBe(first)
    connection.dispose()
  })
  it.each(['disconnect', 'dispose'] as const)('cancels pending restoration on %s', async action => {
    const w = wallet(), connection = createWalletConnection()
    let resolveAccounts!: (value: string[]) => void
    w.request.mockImplementation(async ({ method }) => method === 'eth_accounts' ? new Promise<string[]>(resolve => { resolveAccounts = resolve }) : '0xaa36a7')
    const pending = connection.restore(w.option)
    connection[action](); resolveAccounts([first]); await pending
    expect(connection.state.value.account).toBeNull()
  })
  it('cleans listeners on disconnect and leaves a rejected selection disconnected', async () => {
    const w = wallet(), connection = createWalletConnection()
    await connection.connect(w.option)
    connection.disconnect()
    expect([...w.listeners.values()].every(set => set.size === 0)).toBe(true)
    w.request.mockRejectedValueOnce(new Error('User rejected'))
    await expect(connection.connect(w.option)).rejects.toThrow('User rejected')
    expect(connection.state.value.account).toBeNull()
    expect([...w.listeners.values()].every(set => set.size === 0)).toBe(true)
    connection.dispose()
  })

  it('picks up an explicitly changed account without an accountsChanged event while the tab stays visible', async () => {
    const w = wallet(), { connection } = watching()
    await connection.restore(w.option)
    const revision = connection.state.value.revision
    w.setAccounts([second, first])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(connection.state.value).toMatchObject({ account: second, revision: revision + 1 })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(connection.state.value.revision).toBe(revision + 1)
    expect(w.request.mock.calls.every(([call]) => ['eth_accounts', 'eth_chainId'].includes(call.method))).toBe(true)
  })

  it.each(['focus', 'pageshow'])('refreshes the selected provider immediately on %s without new permissions', async event => {
    const w = wallet(), { connection, browser } = watching()
    await connection.restore(w.option)
    w.setAccounts([second])
    browser.dispatchEvent(new Event(event)); await vi.advanceTimersByTimeAsync(0)
    expect(connection.state.value.account).toBe(second)
    expect(w.request.mock.calls.some(([call]) => call.method === 'eth_requestAccounts')).toBe(false)
  })

  it('pauses reads in a hidden tab and refreshes when it becomes visible', async () => {
    const w = wallet(), { connection, browser, document } = watching()
    await connection.restore(w.option)
    document.visibilityState = 'hidden'; w.setAccounts([second])
    browser.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(connection.state.value.account).toBe(first)
    expect(w.request).toHaveBeenCalledTimes(2)
    document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.state.value.account).toBe(second)
  })

  it('coalesces overlapping passive reads and keeps a newer account event', async () => {
    const w = wallet(), { connection, browser } = watching()
    await connection.restore(w.option)
    let finish!: (accounts: string[]) => void
    w.request.mockImplementation(async ({ method }) => method === 'eth_accounts' ? new Promise<string[]>(resolve => { finish = resolve }) : '0xaa36a7')
    const one = connection.refresh(), two = connection.refresh()
    browser.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(4_000)
    expect(w.request.mock.calls.filter(([call]) => call.method === 'eth_accounts')).toHaveLength(2) // restoration + one shared read
    w.emit('accountsChanged', [second]); finish([first]); await Promise.all([one, two])
    expect(connection.state.value.account).toBe(second)
  })

  it('updates the account even if the independent network read fails, and keeps it when the next account read fails', async () => {
    const w = wallet(), { connection } = watching()
    await connection.restore(w.option)
    w.request.mockImplementation(async ({ method }) => { if (method === 'eth_chainId') throw new Error('Temporary network read failure'); return [second] })
    await connection.refresh()
    expect(connection.state.value).toMatchObject({ account: second, chainId: 11155111 })
    const revision = connection.state.value.revision
    w.request.mockImplementation(async () => { throw new Error('Wallet temporarily unavailable') })
    await connection.refresh()
    expect(connection.state.value).toMatchObject({ account: second, chainId: 11155111, revision })
  })

  it('reflects revoked account access without requesting it again', async () => {
    const w = wallet(), { connection } = watching()
    await connection.restore(w.option)
    w.setAccounts([]); await vi.advanceTimersByTimeAsync(2_000)
    expect(connection.state.value.account).toBeNull()
    expect(w.request.mock.calls.some(([call]) => call.method === 'eth_requestAccounts')).toBe(false)
  })

  it('does not poll while an explicit permission request is pending', async () => {
    const w = wallet(), { connection, browser } = watching()
    let approve!: (accounts: string[]) => void
    w.request.mockImplementation(async ({ method }) => method === 'eth_requestAccounts' ? new Promise<string[]>(resolve => { approve = resolve })
      : method === 'eth_accounts' ? [second] : '0xaa36a7')
    const pending = connection.connect(w.option)
    browser.dispatchEvent(new Event('focus')); w.emit('connect')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(w.request.mock.calls.map(([call]) => call.method)).toEqual(['eth_requestAccounts'])
    approve([second]); await pending
    expect(connection.state.value.account).toBe(second)
  })

  it('drops a late passive response after switching to a different wallet', async () => {
    const a = wallet('a'), b = wallet('b'), { connection } = watching()
    await connection.restore(a.option)
    let finish!: (accounts: string[]) => void
    a.request.mockImplementation(async ({ method }) => method === 'eth_accounts' ? new Promise<string[]>(resolve => { finish = resolve }) : '0xaa36a7')
    const old = connection.refresh()
    await connection.connect(b.option)
    finish([second]); await old
    expect(connection.state.value).toMatchObject({ wallet: b.option, account: first })
  })

  it('does not poll disconnected/ambiguous wallets and removes browser listeners on disposal', async () => {
    const a = wallet('a'), b = wallet('b'), { connection, browser, document } = watching()
    connection.startWatching() // Idempotent; no duplicate polling/listeners.
    expect(vi.getTimerCount()).toBe(1)
    await connection.restore(a.option); await connection.restore(b.option)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(a.request).toHaveBeenCalledTimes(2); expect(b.request).toHaveBeenCalledTimes(2)
    await connection.connect(b.option); connection.disconnect()
    const count = b.request.mock.calls.length
    await vi.advanceTimersByTimeAsync(4_000)
    expect(b.request).toHaveBeenCalledTimes(count)
    connection.dispose()
    expect(vi.getTimerCount()).toBe(0)
    browser.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(b.request).toHaveBeenCalledTimes(count)
  })
})
