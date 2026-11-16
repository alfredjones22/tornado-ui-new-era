import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiParameters, toHex } from 'viem'
import type { ExternalSyncProvider } from '@kohaku-eth/plugins'
import { historyDigest } from '../src/core/history-codec'
import { withRelayerHistory } from '../src/core/relayer-history'
beforeEach(() => { vi.stubGlobal('location', new URL('https://site.example/ipfs/site/')); vi.stubEnv('BASE_URL', './') })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

const address = '0x58e8dcc13be9780fc42e8723d8ead4cf46943df2'
const params = { chainId: '0x1' as const, address: address as `0x${string}` }
const base: ExternalSyncProvider = { firstCoveredBlock: vi.fn(async () => '0x1' as const), lastCoveredBlock: vi.fn(async () => '0x2' as const), async *streamEvents() {} }
async function fixture() {
  const abi = parseAbi(['event RelayerRegistered(bytes32 relayer, string ensName, address relayerAddress, uint256 stakedAmount)'])
  const topics = encodeEventTopics({ abi, eventName: 'RelayerRegistered' })
  const event = { contractAddress: address, blockNumber: '0x14', logIndex: '0x0', eventTopic: topics[0], topics,
    data: encodeAbiParameters(parseAbiParameters('bytes32, string, address, uint256'), [toHex(1n, { size: 32 }), 'relay.eth', '0x1111111111111111111111111111111111111111', 100n]) }
  const bytes = new TextEncoder().encode(JSON.stringify(event) + '\n')
  const pinned = { chainId: 1, address, chunks: [{ fromBlock: '0x10', toBlock: '0x20', file: 'fixture.jsonl.gz', jsonBytes: bytes.length, sha256: await historyDigest(bytes) }] }
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(bytes))
  return { event, pinned, fetcher }
}
describe('public relayer registry history', () => {
  it('uses the custom artifact root for registry chunks and can disable remote backups', async () => {
    const { event, pinned } = await fixture(), root = 'https://mirror.example/base/'
    const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).startsWith(root)
      ? new Response(JSON.stringify(event) + '\n') : new Response(null, { status: 404 }))
    const provider = withRelayerHistory(base, 1, 30n, vi.fn(), fetcher, pinned, root)
    expect(await provider.lastCoveredBlock(params)).toBe('0x1e')
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://site.example/ipfs/site/offline/relayers/fixture.jsonl.gz', `${root}sync-cache/v2/saga/fixture.jsonl.gz`,
    ])
    const local = await fixture()
    await withRelayerHistory(base, 1, 30n, vi.fn(), local.fetcher, pinned, null).lastCoveredBlock(params)
    expect(local.fetcher).toHaveBeenCalledOnce()
  })
  it('verifies cached registrations and bounds advertised coverage by the RPC head', async () => {
    const { event, pinned, fetcher } = await fixture()
    const source = withRelayerHistory(base, 1, 30n, vi.fn(), fetcher, pinned)
    expect(await source.firstCoveredBlock(params)).toBe('0x10')
    expect(await source.lastCoveredBlock(params)).toBe('0x1e')
    const events = []
    for await (const e of source.streamEvents({ ...params, fromBlock: '0x10', toBlock: '0x1e' })) events.push(e)
    expect(events).toEqual([event])
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]![0]).toBe('https://site.example/ipfs/site/offline/relayers/fixture.jsonl.gz')
    await expect(async () => { for await (const _ of source.streamEvents({ ...params, fromBlock: '0x10', toBlock: '0x20' })) {} }).rejects.toThrow('verified coverage')
  })
  it('rejects corrupted files before advertising coverage so SDK RPC fallback remains possible', async () => {
    const { pinned } = await fixture(), warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const source = withRelayerHistory(base, 1, 40n, vi.fn(), vi.fn(async () => new Response('{}')), pinned)
      await expect(source.lastCoveredBlock(params)).rejects.toThrow('No verified')
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('using RPC history'))
    } finally { warning.mockRestore() }
  })
  it('leaves pool history and Sepolia history on their existing provider', async () => {
    const { pinned, fetcher } = await fixture()
    const source = withRelayerHistory(base, 11155111, 40n, vi.fn(), fetcher, pinned)
    expect(await source.lastCoveredBlock({ ...params, chainId: '0xaa36a7' })).toBe('0x2')
    const mainnet = withRelayerHistory(base, 1, 40n, vi.fn(), fetcher, pinned)
    expect(await mainnet.lastCoveredBlock({ ...params, address: '0x1111111111111111111111111111111111111111' })).toBe('0x2')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
