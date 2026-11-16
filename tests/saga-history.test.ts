import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from 'viem'
import type { ExternalRawEvent, ExternalSyncProvider } from '@kohaku-eth/plugins'
import { poolFor } from '../src/core/catalog'
import { createSagaHistory, SAGA_URLS } from '../src/core/saga-history'
import { historyDigest } from '../src/core/history-codec'
import type { PublicSnapshot } from '../src/core/withdrawals'

const pool = poolFor(11155111, '1')!
const params = { chainId: '0xaa36a7', address: pool.address } as const
const abi = parseAbi(['event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)'])
const hex = (n: number): Hex => `0x${n.toString(16)}`
function snapshot(): PublicSnapshot {
  return { 'tornado-cash-state-11155111-1': { pools: { poolsTuples: [[pool.address, { registeredBlock: '0x1', lastSyncedBlock: '0x64' }]] } } } as unknown as PublicSnapshot
}
function event(block: number, log = 0): ExternalRawEvent {
  const topics = encodeEventTopics({ abi, eventName: 'Deposit', args: { commitment: `0x${'ab'.repeat(32)}` } }) as Hex[]
  return { contractAddress: pool.address.toLowerCase() as Hex, eventTopic: topics[0]!, topics,
    data: encodeAbiParameters([{ type: 'uint32' }, { type: 'uint256' }], [1, 1n]), blockNumber: hex(block), logIndex: hex(log) }
}
async function fixture(records = [[event(101), event(109)], [event(110), event(115), event(119)]]) {
  const files = new Map<string, Uint8Array>()
  const segments = []
  for (const [i, events] of records.entries()) {
    const raw = new TextEncoder().encode(events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''))
    const file = `part-${i}.jsonl.gz`
    files.set(file, new Uint8Array(gzipSync(raw)))
    segments.push({ fromBlock: hex(i === 0 ? 101 : 110), toBlock: hex(i === 0 ? 110 : 121), file, digest: { type: 'sha256', data: `0x${await historyDigest(raw)}` } })
  }
  const entry = { protocol: 'tornado-cash', chainId: params.chainId, trackedAddresses: [params.address], chunks: [
    // Entirely cached ancient chunk must never be downloaded.
    { fromBlock: '0x1', toBlock: '0x65', file: 'ancient.jsonl.gz', digest: { type: 'sha256', data: `0x${'00'.repeat(32)}` } },
    segments[0]!,
  ], hotHead: segments[1]! }
  const index = { version: 1, compression: 'gzip', availableProtocols: { unrelatedDerivedStream: { protocol: 'railgun', chainId: params.chainId, chunks: [] }, pool: entry } }
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const file = String(input).slice(SAGA_URLS[11155111].length + 1)
    if (file === 'index.json') return Response.json(index)
    const body = files.get(file)
    return body ? new Response(new Uint8Array(body)) : new Response(null, { status: 404 })
  })
  return { fetcher, files, index, entry, segments }
}
async function events(provider: ExternalSyncProvider, to = 115) {
  const result = []
  for await (const value of provider.streamEvents({ ...params, fromBlock: '0x64', toBlock: hex(to) })) result.push(value)
  return result
}

describe('Saga between the bundled cache and RPC tail', () => {
  it('fetches both the index and verified chunks through a custom mirror base path', async () => {
    const f = await fixture(), root = 'https://mirror.example/history/sepolia/'
    const fetcher = vi.fn(async (url: RequestInfo | URL) => f.fetcher(String(url).replace(root, `${SAGA_URLS[11155111]}/`)))
    const provider = createSagaHistory(11155111, snapshot(), 115n, vi.fn(), fetcher, vi.fn(), root)
    expect(await provider.lastCoveredBlock(params)).toBe(hex(115))
    expect(await events(provider)).toHaveLength(4)
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(root))).toBe(true)
  })
  it('makes no network request when disabled and leaves all newer blocks to RPC', async () => {
    const fetcher = vi.fn(), progress = vi.fn()
    const provider = createSagaHistory(11155111, snapshot(), 115n, progress, fetcher, vi.fn(), null)
    expect(await provider.lastCoveredBlock(params)).toBe('0x64')
    await expect(events(provider)).rejects.toThrow('Saga is disabled')
    expect(fetcher).not.toHaveBeenCalled()
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('Saga disabled'))
  })
  it('accepts the current v2 index and immutable chunk filenames containing half-open block ranges', async () => {
    const f = await fixture()
    f.index.version = 2
    for (const segment of f.segments) {
      const old = segment.file
      segment.file = `pool-[${segment.fromBlock},${segment.toBlock}).jsonl.gz`
      f.files.set(segment.file, f.files.get(old)!)
      f.files.delete(old)
    }
    const provider = createSagaHistory(11155111, snapshot(), 115n, vi.fn(), f.fetcher, vi.fn())
    expect(await provider.lastCoveredBlock(params)).toBe(hex(115))
    expect((await events(provider)).map(e => BigInt(e.blockNumber))).toEqual([101n, 109n, 110n, 115n])
  })
  it('downloads only overlapping new chunks, clips to the chain head and serves a fully verified range', async () => {
    const f = await fixture(), warn = vi.fn()
    const provider = createSagaHistory(11155111, snapshot(), 115n, vi.fn(), f.fetcher, warn)
    expect(await provider.firstCoveredBlock(params)).toBe('0x1')
    expect(await provider.lastCoveredBlock(params)).toBe(hex(115))
    expect((await events(provider)).map(e => BigInt(e.blockNumber))).toEqual([101n, 109n, 110n, 115n])
    expect(f.fetcher).toHaveBeenCalledTimes(3) // one index, two newer chunks
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes('ancient'))).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    await provider.lastCoveredBlock(params)
    expect(f.fetcher).toHaveBeenCalledTimes(3)
  })
  it('falls back on CORS/index errors once per preparation and retries Saga in the next preparation', async () => {
    const warn = vi.fn(), fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const provider = createSagaHistory(11155111, snapshot(), 115n, vi.fn(), fetcher, warn)
    await expect(provider.lastCoveredBlock(params)).rejects.toThrow('index unavailable')
    await expect(provider.lastCoveredBlock(params)).rejects.toThrow('index unavailable')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toMatch(/Skipping Saga.*CORS.*cached history \+ RPC/)
    const f = await fixture()
    expect(await createSagaHistory(11155111, snapshot(), 115n, vi.fn(), f.fetcher, warn).lastCoveredBlock(params)).toBe(hex(115))
  })
  it('does not advertise partial coverage if a later chunk fails or has a bad digest', async () => {
    for (const invalid of ['missing', 'checksum']) {
      const f = await fixture(), original = JSON.stringify(snapshot()), warn = vi.fn()
      if (invalid === 'missing') f.files.delete('part-1.jsonl.gz')
      else f.segments[1]!.digest.data = `0x${'00'.repeat(32)}`
      const seed = snapshot(), provider = createSagaHistory(11155111, seed, 115n, vi.fn(), f.fetcher, warn)
      await expect(provider.lastCoveredBlock(params)).rejects.toThrow(invalid === 'missing' ? 'HTTP 404' : 'checksum mismatch')
      expect(JSON.stringify(seed)).toBe(original)
      expect(warn).toHaveBeenCalledOnce()
    }
  })
  it('rejects gaps, overlaps, misordered logs and wrong-pool logs before the SDK can advance', async () => {
    for (const kind of ['gap', 'overlap', 'ordering', 'wrong-pool']) {
      const wrong = event(110); wrong.contractAddress = '0x1111111111111111111111111111111111111111'
      const f = await fixture(kind === 'ordering' ? [[event(109), event(101)], [event(110)]] : kind === 'wrong-pool' ? [[event(101)], [wrong]] : undefined)
      if (kind === 'gap') f.segments[1]!.fromBlock = hex(111)
      if (kind === 'overlap') f.segments[1]!.fromBlock = hex(109)
      const provider = createSagaHistory(11155111, snapshot(), 115n, vi.fn(), f.fetcher, vi.fn())
      await expect(provider.lastCoveredBlock(params)).rejects.toThrow()
    }
  })
  it('accepts empty verified ranges and leaves newer RPC blocks to the SDK', async () => {
    const f = await fixture([[], []])
    const provider = createSagaHistory(11155111, snapshot(), 115n, vi.fn(), f.fetcher, vi.fn())
    const coverage = BigInt(await provider.lastCoveredBlock(params))
    expect(coverage + 1n).toBe(116n)
    expect(await events(provider)).toEqual([])
  })
  it('uses RPC directly when Saga is older than the cache, without downloading old chunks', async () => {
    const f = await fixture()
    f.entry.chunks.pop(); delete (f.entry as { hotHead?: unknown }).hotHead
    const provider = createSagaHistory(11155111, snapshot(), 115n, vi.fn(), f.fetcher, vi.fn())
    expect(await provider.lastCoveredBlock(params)).toBe('0x64')
    expect(f.fetcher).toHaveBeenCalledOnce()
  })
})
