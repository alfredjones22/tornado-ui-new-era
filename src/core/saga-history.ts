import type { ExternalRawEvent, ExternalSyncPoolId, ExternalSyncProvider } from '@kohaku-eth/plugins'
import { decodeEventLog, parseAbi, type Hex } from 'viem'
import type { ChainId } from './catalog'
import type { PublicSnapshot } from './withdrawals'
import { decompressHistory, historyDigest, readHistoryBytes } from './history-codec'
import { SAGA_URLS, sourceUrl } from './data-sources'

export { SAGA_URLS } from './data-sources'
const poolEvents = parseAbi([
  'event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)',
  'event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)',
])
type Segment = { fromBlock: Hex; toBlock: Hex; file: string; digest: { type: string; data: string } }
type Entry = { protocol?: string; chainId: Hex; trackedAddresses?: Hex[]; chunks: Segment[]; hotHead?: Segment; extraLogFields?: string[] }
type Index = { version: number; compression: string; availableProtocols: Record<string, Entry> }
type Prepared = { coverage: bigint; events: ExternalRawEvent[] }
const hex = (value: bigint): Hex => `0x${value.toString(16)}`
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('Invalid Saga block or log position.')
  return BigInt(value)
}

/** Advertise coverage only after every needed chunk has downloaded and verified.
 * The SDK catches lastCoveredBlock failures (RPC fallback), but not stream errors.
 * One provider lives for one disposable preparation, so a later attempt retries
 * Saga automatically after CORS/network problems are fixed.
 */
export function createSagaHistory(chainId: ChainId, snapshot: PublicSnapshot, head: bigint, progress: (message: string) => void,
  fetcher: typeof fetch = fetch, warn: (...args: unknown[]) => void = console.warn, sagaUrl: string | null = SAGA_URLS[chainId]): ExternalSyncProvider {
  const pools = new Map(Object.values(snapshot).flatMap(state => state.pools.poolsTuples).map(([key, pool]) => [BigInt(key), pool]))
  const base = sagaUrl
  let indexPromise: Promise<Index> | undefined, indexFailed = false
  const prepared = new Map<bigint, Promise<Prepared>>()
  async function request(file: string, limit: number, timeout: number, mutable = false) {
    let response: Response
    try { response = await fetcher(sourceUrl(file, base!), { credentials: 'omit', referrerPolicy: 'no-referrer', cache: mutable ? 'no-store' : 'default', signal: AbortSignal.timeout(timeout) }) }
    catch { throw new Error('network, CORS or timeout failure') }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return readHistoryBytes(response.body, limit)
  }
  const index = () => indexPromise ??= (async () => {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(await request('index.json', 2 * 1024 * 1024, 5_000, true))) as Index
      if (![1, 2].includes(parsed.version) || parsed.compression !== 'gzip' || !parsed.availableProtocols || typeof parsed.availableProtocols !== 'object') throw new Error('invalid index')
      return parsed
    } catch (error) {
      indexFailed = true
      warn(`[Tornado sync] Skipping Saga on chain ${chainId}: index unavailable (${error instanceof Error ? error.message : 'request failed'}). Using cached history + RPC.`)
      throw new Error('Saga index unavailable.')
    }
  })()
  function saved(params: ExternalSyncPoolId) {
    const pool = pools.get(BigInt(params.address))
    if (BigInt(params.chainId) !== BigInt(chainId) || !pool || pool.lastSyncedBlock === undefined) throw new Error('Saga requested an unselected pool or network.')
    return pool
  }
  if (base === null) {
    progress('Saga disabled in Settings. Syncing remaining history with RPC…')
    return {
      firstCoveredBlock: async params => hex(BigInt(saved(params).registeredBlock)),
      lastCoveredBlock: async params => hex(BigInt(saved(params).lastSyncedBlock!)),
      async *streamEvents(params) {
        // Advertise only the existing checkpoint, never an unqueried RPC tail.
        if (quantity(params.toBlock) > BigInt(saved(params).lastSyncedBlock!)) throw new Error('Saga is disabled; use RPC for this range.')
      },
    }
  }
  async function prepare(params: ExternalSyncPoolId): Promise<Prepared> {
    const pool = saved(params), cursor = BigInt(pool.lastSyncedBlock!)
    if (cursor >= head) return { coverage: cursor, events: [] }
    const matches = Object.values((await index()).availableProtocols).filter(entry =>
      entry.protocol === 'tornado-cash' && quantity(entry.chainId) === BigInt(chainId) &&
      entry.trackedAddresses?.some(address => BigInt(address) === BigInt(params.address)))
    if (matches.length !== 1) throw new Error('no unique pool stream')
    const entry = matches[0]!
    if (entry.extraLogFields?.some(field => field !== 'transactionHash')) throw new Error('unsupported Saga record fields')
    const segments = [...entry.chunks, ...(entry.hotHead ? [entry.hotHead] : [])]
      .sort((a, b) => Number(quantity(a.fromBlock) - quantity(b.fromBlock)))
      .filter(segment => quantity(segment.toBlock) > cursor + 1n && quantity(segment.fromBlock) <= head)
    if (!segments.length) return { coverage: cursor, events: [] } // Saga is behind the bundled cache.
    let end = cursor + 1n
    for (const [i, segment] of segments.entries()) {
      const from = quantity(segment.fromBlock), to = quantity(segment.toBlock)
      if (to <= from || (i === 0 ? from > end : from !== end)) throw new Error('gap or overlap in Saga coverage')
      if (!/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.\[\](),-]+\.jsonl\.gz$/.test(segment.file) || segment.file.split('/').includes('..') ||
        segment.digest?.type !== 'sha256' || !/^(?:0x)?[0-9a-f]{64}$/i.test(segment.digest.data)) throw new Error('invalid Saga chunk metadata')
      end = to
    }
    const coverage = end - 1n < head ? end - 1n : head
    const events: ExternalRawEvent[] = []
    for (const [i, segment] of segments.entries()) {
      progress(`Syncing newer history from Saga… ${i + 1}/${segments.length} chunks`)
      const bytes = await decompressHistory(await request(segment.file, 64 * 1024 * 1024, 20_000, segment === entry.hotHead), 256 * 1024 * 1024)
      if (await historyDigest(bytes) !== segment.digest.data.replace(/^0x/i, '').toLowerCase()) throw new Error('Saga chunk checksum mismatch')
      let previousBlock = -1n, previousLog = -1n
      for (const line of new TextDecoder().decode(bytes).split('\n')) {
        if (!line) continue
        const event = JSON.parse(line) as ExternalRawEvent & { transactionHash?: Hex }
        const block = quantity(event.blockNumber), log = quantity(event.logIndex)
        if (block < quantity(segment.fromBlock) || block >= quantity(segment.toBlock) || block < previousBlock ||
          (block === previousBlock && log <= previousLog)) throw new Error('invalid Saga event range or ordering')
        previousBlock = block; previousLog = log
        if (!/^0x[0-9a-f]{40}$/i.test(event.contractAddress) || !entry.trackedAddresses?.some(a => BigInt(a) === BigInt(event.contractAddress)) ||
          !Array.isArray(event.topics) || event.topics.some(topic => !/^0x[0-9a-f]{64}$/i.test(topic)) || event.eventTopic !== event.topics[0] ||
          !/^0x(?:[0-9a-f]{2})*$/i.test(event.data) || (entry.extraLogFields?.includes('transactionHash') && !/^0x[0-9a-f]{64}$/i.test(event.transactionHash ?? ''))) {
          throw new Error('invalid Saga event fields')
        }
        // Do not let an undecodable log silently disappear inside SDK parsing.
        decodeEventLog({ abi: poolEvents, data: event.data, topics: event.topics as [Hex, ...Hex[]], strict: true })
        if (BigInt(event.contractAddress) === BigInt(params.address) && block > cursor && block <= coverage) events.push(event)
      }
    }
    return { coverage, events }
  }
  const range = (params: ExternalSyncPoolId) => {
    saved(params)
    const key = BigInt(params.address)
    let promise = prepared.get(key)
    if (!promise) {
      promise = prepare(params).catch(error => {
        if (!indexFailed) warn(`[Tornado sync] Skipping Saga for ${params.address} on chain ${chainId}: ${error instanceof Error ? error.message : 'invalid history'}. Using cached history + RPC.`)
        progress('Saga unavailable for this history range. Syncing the remaining blocks with RPC…')
        throw error
      })
      prepared.set(key, promise)
    }
    return promise
  }
  return {
    firstCoveredBlock: async params => hex(BigInt(saved(params).registeredBlock)),
    lastCoveredBlock: async params => hex((await range(params)).coverage),
    async *streamEvents(params) {
      const result = await range(params)
      const from = quantity(params.fromBlock), to = quantity(params.toBlock)
      if (from < BigInt(saved(params).lastSyncedBlock!) || to > result.coverage) throw new Error('Saga range exceeds validated history.')
      for (const event of result.events) if (quantity(event.blockNumber) >= from && quantity(event.blockNumber) <= to) yield event
    },
  }
}
