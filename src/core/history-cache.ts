import manifest from './history-manifest.json'
import type { ChainId, Pool } from './catalog'
import type { PublicSnapshot } from './withdrawals'
import { decompressHistory, historyDigest, readHistoryBytes } from './history-codec'
import bootstrap from './history-bootstrap.json'
import { appAssetUrl } from './app-assets'
import { ARTIFACTS_URL, sourceUrl } from './data-sources'

type State = PublicSnapshot[keyof PublicSnapshot]
type Descriptor = { file: string; sha256: string; jsonBytes: number; gzipBytes: number; fromBlock: string; toBlock: string }
export const HISTORY_BASE_URL = sourceUrl('tornado-history/v1/', ARTIFACTS_URL)
const SNAPSHOT_CONCURRENCY = 4
const addressKey = (value: string) => `0x${BigInt(value).toString(16).padStart(40, '0')}`

function scanFromDeployment(chainId: ChainId, pool: Pool, descriptor: Descriptor): State {
  const chain = bootstrap.chains[chainId]
  const saved = chain.pools.poolsTuples.find(([key]) => BigInt(key as string) === BigInt(pool.address))
  if (!saved) throw new Error('Missing public pool bootstrap metadata. Rebuild the interface.')
  const checkpoint = `0x${(BigInt(descriptor.fromBlock) - 1n).toString(16)}`
  const state = { instanceRegistryInfo: chain.instanceRegistryInfo, relayers: chain.relayers,
    pools: { poolsTuples: [[saved[0], { ...saved[1] as object, lastSyncedBlock: checkpoint }]] },
    assets: chain.assets, deposits: { depositsTuples: [] }, withdrawals: { withdrawalsTuples: [] },
    sync: { lastSyncedBlock: checkpoint, relayerRegistrySyncedBlock: '0x0' },
  } as unknown as State
  validatePool(state, pool, checkpoint)
  return state
}

function poolState(state: State, address: string): State {
  return {
    pools: { poolsTuples: state.pools.poolsTuples.filter(([key]: [string, unknown]) => BigInt(key) === BigInt(address)) },
    deposits: { depositsTuples: state.deposits.depositsTuples.filter(([key]: [string, unknown]) => BigInt(key) === BigInt(address)) },
    withdrawals: { withdrawalsTuples: state.withdrawals.withdrawalsTuples.filter(([, event]: [string, { pool: string }]) => BigInt(event.pool) === BigInt(address)) },
    assets: state.assets, relayers: state.relayers, instanceRegistryInfo: state.instanceRegistryInfo, sync: state.sync,
  } as State
}

function validatePool(state: State, pool: Pool, checkpoint: string) {
  const saved = state.pools.poolsTuples
  if (saved.length !== 1 || BigInt(saved[0]![0]) !== BigInt(pool.address) || saved[0]![1].lastSyncedBlock === undefined ||
    BigInt(saved[0]![1].lastSyncedBlock!) !== BigInt(checkpoint) || BigInt(saved[0]![1].denomination) !== pool.amount ||
    BigInt(saved[0]![1].asset) !== BigInt(pool.asset.token ?? 0) || Boolean(saved[0]![1].isERC20) !== Boolean(pool.asset.token)) {
    throw new Error('Cached pool history does not match the selected pool.')
  }
}

/** Load only selected pools. Files are pinned by the application's manifest. */
export async function loadCachedHistory(chainId: ChainId, selected: readonly Pool[], initialState: PublicSnapshot | undefined,
  progress: (message: string) => void, fetcher: typeof fetch = fetch, artifactsUrl: string | null = ARTIFACTS_URL): Promise<PublicSnapshot> {
  const chain = manifest.chains[chainId] as { stateKey: keyof PublicSnapshot; pools: Record<string, Descriptor> }
  const pools = [...new Map(selected.map(pool => [pool.address.toLowerCase(), pool])).values()]
  const states = new Array<State>(pools.length)
  const controller = new AbortController()
  let next = 0, completed = 0
  async function load(pool: Pool): Promise<State> {
    const descriptor = chain.pools[addressKey(pool.address)]
    if (!descriptor) throw new Error('The history manifest is missing a selected pool.')
    const memory = initialState?.[chain.stateKey]
    const checkpoint = memory?.pools.poolsTuples.find(([key]: [string, unknown]) => BigInt(key) === BigInt(pool.address))?.[1].lastSyncedBlock
    if (memory && checkpoint !== undefined && BigInt(checkpoint) >= BigInt(descriptor.toBlock)) {
      const scoped = poolState(memory, pool.address)
      validatePool(scoped, pool, checkpoint)
      return scoped
    }
    const sources = [appAssetUrl(`offline/history/${descriptor.file}`), ...(artifactsUrl === null ? [] : [sourceUrl(`tornado-history/v1/${descriptor.file}`, artifactsUrl)])]
    for (const [index, url] of sources.entries()) {
      try {
        const response = await fetcher(url, {
          credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(index === 0 ? 120_000 : 30_000)]),
        })
        if (!response.ok) throw new Error('Snapshot unavailable')
        const bytes = await decompressHistory(await readHistoryBytes(response.body, Math.max(descriptor.jsonBytes, descriptor.gzipBytes)), descriptor.jsonBytes)
        if (bytes.length !== descriptor.jsonBytes || await historyDigest(bytes) !== descriptor.sha256) throw new Error('Snapshot integrity check failed')
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as PublicSnapshot
        if (Object.keys(parsed).length !== 1 || !parsed[chain.stateKey] || BigInt(parsed[chain.stateKey]!.instanceRegistryInfo.chainId) !== BigInt(chainId)) throw new Error('Snapshot network mismatch')
        const scoped = poolState(parsed[chain.stateKey]!, pool.address)
        validatePool(scoped, pool, descriptor.toBlock)
        return scoped
      } catch {
        if (controller.signal.aborted) throw new Error('History loading cancelled.')
        console.warn(`[Tornado sync] ${index === 0 ? 'Bundled' : 'Hosted'} snapshot unavailable or invalid for ${addressKey(pool.address)} on chain ${chainId}; trying ${index === 0 && sources.length > 1 ? 'the hosted backup' : 'Saga and RPC history'}.`)
      }
    }
    if (memory && checkpoint !== undefined) {
      const scoped = poolState(memory, pool.address)
      validatePool(scoped, pool, checkpoint)
      return scoped
    }
    progress('Snapshots unavailable. Rebuilding pool history from Saga or RPC; a full scan may take longer…')
    return scanFromDeployment(chainId, pool, descriptor)
  }
  progress(`Loading cached pool history… 0/${pools.length} pools ready.`)
  // Overlap independent downloads without decompressing every pool at once.
  // Store by selection index so completion order cannot change the merged state.
  await Promise.all(Array.from({ length: Math.min(SNAPSHOT_CONCURRENCY, pools.length) }, async () => {
    try {
      while (!controller.signal.aborted) {
        const index = next++
        if (index >= pools.length) return
        states[index] = await load(pools[index]!)
        if (!controller.signal.aborted) progress(`Loading cached pool history… ${++completed}/${pools.length} pools ready.`)
      }
    } catch (error) { controller.abort(); throw error }
  }))
  if (!states.length) throw new Error('Select at least one pool to load its history.')
  const base = states[0]!
  const assets = new Map(states.flatMap(state => state.assets.assetsTuples))
  const allPools = states.flatMap(state => state.pools.poolsTuples)
  const latest = allPools.reduce((head, [, pool]) => BigInt(pool.lastSyncedBlock!) > head ? BigInt(pool.lastSyncedBlock!) : head, 0n)
  return { [chain.stateKey]: {
    instanceRegistryInfo: base.instanceRegistryInfo, relayers: base.relayers,
    pools: { poolsTuples: allPools }, assets: { assetsTuples: [...assets] },
    deposits: { depositsTuples: states.flatMap(state => state.deposits.depositsTuples) },
    withdrawals: { withdrawalsTuples: states.flatMap(state => state.withdrawals.withdrawalsTuples) },
    sync: { ...base.sync, lastSyncedBlock: `0x${latest.toString(16)}` },
  } as State }
}
