import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { poolFor, poolsFor } from '../src/core/catalog'
import { HISTORY_BASE_URL, loadCachedHistory } from '../src/core/history-cache'
import manifest from '../src/core/history-manifest.json'
beforeEach(() => { vi.stubGlobal('location', new URL('https://site.example/ipfs/site/')); vi.stubEnv('BASE_URL', './'); vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

function files() {
  return vi.fn(async (url: RequestInfo | URL) => new Response(readFileSync(`tests/fixtures/history/${new URL(String(url)).pathname.split('/').at(-1)}`))) as unknown as ReturnType<typeof vi.fn> & typeof fetch
}

describe('hosted public pool history', () => {
  it('uses a custom artifact mirror including its base path without contacting the default host', async () => {
    const root = 'https://mirror.example/ipfs/artifact-cid/', pool = poolFor(11155111, '1')!
    const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).startsWith(root) ? files()(url) : new Response(null, { status: 404 }))
    const result = await loadCachedHistory(11155111, [pool], undefined, vi.fn(), fetcher, root)
    expect(Object.values(result)[0]!.deposits.depositsTuples).toHaveLength(1)
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('/offline/history/11155111/'), expect.stringMatching(/^https:\/\/mirror.example\/ipfs\/artifact-cid\/tornado-history\/v1\/11155111\//),
    ])
  })
  it('never requests a remote backup when it is disabled, even if the bundled snapshot is missing', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL) => new Response(null, { status: 404 }))
    const result = await loadCachedHistory(11155111, [poolFor(11155111, '1')!], undefined, vi.fn(), fetcher, null)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(String(fetcher.mock.calls[0]![0])).toContain('/offline/history/')
    expect(Object.values(result)[0]!.deposits.depositsTuples).toEqual([])
  })
  it('covers every paymaster-supported UI pool on both networks', () => {
    for (const chainId of [1, 11155111] as const) {
      const bundled = manifest.chains[chainId].pools as Record<string, { toBlock: string; file: string }>
      for (const pool of poolsFor(chainId)) {
        expect(bundled[pool.address.toLowerCase()]?.file).toMatch(new RegExp(`^${chainId}/`))
        expect(BigInt(bundled[pool.address.toLowerCase()]!.toBlock)).toBeGreaterThan(0n)
      }
    }
  })
  it('loads and verifies only selected pools, merging a multi-note set without duplication', async () => {
    const first = poolFor(11155111, '0.01')!, second = poolFor(11155111, '1')!, fetcher = files()
    const snapshot = await loadCachedHistory(11155111, [first, second, first], undefined, vi.fn(), fetcher)
    const state = Object.values(snapshot)[0]!
    expect(fetcher).toHaveBeenCalledTimes(2)
    for (const [url, options] of fetcher.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/site.example\/ipfs\/site\/offline\/history\/11155111\//)
      expect(options).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' })
    }
    expect(state.pools.poolsTuples.map(([key]: [string, unknown]) => BigInt(key))).toEqual([BigInt(first.address), BigInt(second.address)])
    expect(state.deposits.depositsTuples).toHaveLength(2)
    expect(state.withdrawals.withdrawalsTuples.every(([, event]: [string, { pool: string }]) => [BigInt(first.address), BigInt(second.address)].includes(BigInt(event.pool)))).toBe(true)
    expect(snapshot).not.toHaveProperty('legacySecrets')
    expect(Object.keys(state).sort()).toEqual(['assets', 'deposits', 'instanceRegistryInfo', 'pools', 'relayers', 'sync', 'withdrawals'])
  })
  it('overlaps pool downloads and preserves selection order when the second pool finishes first', async () => {
    const first = poolFor(11155111, '0.01')!, second = poolFor(11155111, '1')!, original = files(), progress = vi.fn()
    const release: (() => void)[] = []
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      await new Promise<void>(resolve => { release.push(resolve) })
      return original(url)
    })
    let finished = false
    const pending = loadCachedHistory(11155111, [first, second, first], undefined, progress, fetcher).then(snapshot => { finished = true; return snapshot })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    release[1]!()
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith('Loading cached pool history… 1/2 pools ready.'))
    expect(finished).toBe(false)
    release[0]!()
    const state = Object.values(await pending)[0]!
    expect(state.pools.poolsTuples.map(([key]: [string, unknown]) => BigInt(key))).toEqual([BigInt(first.address), BigInt(second.address)])
    expect(progress).toHaveBeenLastCalledWith('Loading cached pool history… 2/2 pools ready.')
  })
  it('limits simultaneous snapshots to four while falling back independently for each failed pool', async () => {
    const selected = poolsFor(11155111, 'ETH').slice(0, 5)
    expect(selected).toHaveLength(5)
    let active = 0, maximum = 0
    const fetcher = vi.fn(async () => {
      maximum = Math.max(maximum, ++active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active--; return new Response(null, { status: 503 })
    })
    const result = await loadCachedHistory(11155111, selected, undefined, vi.fn(), fetcher)
    expect(fetcher).toHaveBeenCalledTimes(10)
    expect(maximum).toBe(4)
    expect(Object.values(result)[0]!.pools.poolsTuples).toHaveLength(5)
  })
  it('reuses a newer in-memory pool while stripping secret slices and unrelated pools', async () => {
    const first = poolFor(11155111, '0.01')!, second = poolFor(11155111, '1')!
    const cached = await loadCachedHistory(11155111, [first, second], undefined, vi.fn(), files())
    const state = Object.values(cached)[0]!
    state.pools.poolsTuples[0][1].lastSyncedBlock = '0xffffff'
    state.legacySecrets = { syntheticPrivateMarker: true }
    const fetcher = vi.fn()
    const result = Object.values(await loadCachedHistory(11155111, [first], cached, vi.fn(), fetcher))[0]!
    expect(fetcher).not.toHaveBeenCalled()
    expect(result.pools.poolsTuples).toHaveLength(1)
    expect(result.pools.poolsTuples[0][1].lastSyncedBlock).toBe('0xffffff')
    expect(JSON.stringify(result)).not.toContain('syntheticPrivateMarker')
  })
  it.each([404, 'corrupt'])('uses empty deployment history for unavailable or corrupted copies (%s), never a fabricated synced checkpoint', async failure => {
    const pool = poolFor(11155111, '1')!
    const fetcher = vi.fn(async () => failure === 404 ? new Response(null, { status: 404 }) : new Response('{}'))
    const progress = vi.fn()
    const result = await loadCachedHistory(11155111, [pool], undefined, progress, fetcher)
    const state = Object.values(result)[0]!, saved = state.pools.poolsTuples[0]![1]
    expect(BigInt(saved.lastSyncedBlock!)).toBe(BigInt(manifest.chains[11155111].pools[pool.address.toLowerCase() as keyof typeof manifest.chains[11155111]['pools']].fromBlock) - 1n)
    expect(state.deposits.depositsTuples).toEqual([])
    expect(state.withdrawals.withdrawalsTuples).toEqual([])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('Rebuilding pool history'))
  })
  it('does not require R2 when bundled files are available; falls back to R2 if only the local copy fails', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).startsWith(HISTORY_BASE_URL) ? files()(url) : new Response('{}'))
    const result = await loadCachedHistory(11155111, [poolFor(11155111, '1')!], undefined, vi.fn(), fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(Object.values(result)[0]!.deposits.depositsTuples).toHaveLength(1)
  })
  it('handles network, CORS and timeout failures without preventing a full chain scan', async () => {
    const result = await loadCachedHistory(11155111, [poolFor(11155111, '1')!], undefined, vi.fn(), vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    expect(Object.values(result)[0]!.deposits.depositsTuples).toEqual([])
    expect(console.warn).toHaveBeenCalledTimes(2)
  })
  it('also verifies assets already decoded by a host serving Content-Encoding: gzip', async () => {
    const pool = poolFor(11155111, '1')!
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(new Uint8Array(gunzipSync(readFileSync(`tests/fixtures/history/${new URL(String(url)).pathname.split('/').at(-1)}`)))))
    const snapshot = await loadCachedHistory(11155111, [pool], undefined, vi.fn(), fetcher)
    expect(Object.values(snapshot)[0]!.pools.poolsTuples).toHaveLength(1)
  })
})
