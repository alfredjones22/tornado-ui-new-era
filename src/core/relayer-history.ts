import type { ExternalRawEvent, ExternalSyncPoolId, ExternalSyncProvider } from '@kohaku-eth/plugins'
import { decodeEventLog, parseAbi, toEventSelector, type Hex } from 'viem'
import manifest from './relayer-history-manifest.json'
import { decompressHistory, historyDigest, readHistoryBytes } from './history-codec'
import type { ChainId } from './catalog'
import { appAssetUrl } from './app-assets'
import { ARTIFACTS_URL, sourceUrl } from './data-sources'

const registryEvents = parseAbi(['event RelayerRegistered(bytes32 relayer, string ensName, address relayerAddress, uint256 stakedAmount)'])
const registrationTopic = toEventSelector(registryEvents[0])
type Manifest = typeof manifest

/** Reuse the CLI's public registry cache; the SDK verifies current ENS/stake
 * through its aggregator and reads the RPC tail after these immutable chunks.
 */
export function withRelayerHistory(base: ExternalSyncProvider, chainId: ChainId, head: bigint, progress: (message: string) => void,
  fetcher: typeof fetch = fetch, pinned: Manifest = manifest, artifactsUrl: string | null = ARTIFACTS_URL): ExternalSyncProvider {
  let downloaded: Promise<ExternalRawEvent[]> | undefined
  const matches = (p: ExternalSyncPoolId) => chainId === pinned.chainId && BigInt(p.chainId) === BigInt(chainId) && p.address.toLowerCase() === pinned.address.toLowerCase()
  const covered = BigInt(pinned.chunks.at(-1)!.toBlock) - 1n
  const load = () => downloaded ??= (async () => {
    const events: ExternalRawEvent[] = []
    let end = BigInt(pinned.chunks[0]!.fromBlock)
    for (const [index, chunk] of pinned.chunks.entries()) {
      if (BigInt(chunk.fromBlock) !== end || BigInt(chunk.toBlock) <= end) throw new Error('Invalid relayer-history coverage.')
      end = BigInt(chunk.toBlock)
      progress(`Loading TORN relayer registrations… ${index + 1}/${pinned.chunks.length}`)
      let bytes: Uint8Array | undefined
      for (const url of [appAssetUrl(`offline/relayers/${chunk.file}`), ...(artifactsUrl === null ? [] : [sourceUrl(`sync-cache/v2/saga/${chunk.file}`, artifactsUrl)])]) {
        try {
          const response = await fetcher(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20_000) })
          if (!response.ok) continue
          const candidate = await decompressHistory(await readHistoryBytes(response.body, chunk.jsonBytes), chunk.jsonBytes)
          if (candidate.length === chunk.jsonBytes && await historyDigest(candidate) === chunk.sha256) { bytes = candidate; break }
        } catch { /* The SDK can scan registrations directly when both copies fail. */ }
      }
      if (!bytes) throw new Error('No verified relayer registry snapshot is available.')
      let lastBlock = -1n, lastLog = -1n
      for (const line of new TextDecoder().decode(bytes).split('\n')) {
        if (!line) continue
        const event = JSON.parse(line) as ExternalRawEvent
        const block = BigInt(event.blockNumber), log = BigInt(event.logIndex)
        if (event.contractAddress.toLowerCase() !== pinned.address.toLowerCase() || block < BigInt(chunk.fromBlock) || block >= end ||
          block < lastBlock || block === lastBlock && log <= lastLog) throw new Error('Invalid relayer registry event range or ordering.')
        lastBlock = block; lastLog = log
        // Other verified registry logs concern workers/staking, not registrations.
        if (event.topics[0] !== registrationTopic) continue
        decodeEventLog({ abi: registryEvents, data: event.data, topics: event.topics as [Hex, ...Hex[]], strict: true })
        events.push(event)
      }
    }
    return events
  })().catch(error => { console.warn('[Tornado relayers] Registry snapshot unavailable; using RPC history.'); throw error })
  return {
    firstCoveredBlock: p => matches(p) ? Promise.resolve(pinned.chunks[0]!.fromBlock as Hex) : base.firstCoveredBlock(p),
    lastCoveredBlock: async p => {
      if (!matches(p)) return base.lastCoveredBlock(p)
      await load()
      return `0x${(covered < head ? covered : head).toString(16)}`
    },
    async *streamEvents(p) {
      if (!matches(p)) { yield* base.streamEvents(p); return }
      if (BigInt(p.fromBlock) < BigInt(pinned.chunks[0]!.fromBlock) || BigInt(p.toBlock) > covered || BigInt(p.toBlock) > head) throw new Error('Relayer history range exceeds verified coverage.')
      for (const event of await load()) if (BigInt(event.blockNumber) >= BigInt(p.fromBlock) && BigInt(event.blockNumber) <= BigInt(p.toBlock)) yield event
    },
  }
}
