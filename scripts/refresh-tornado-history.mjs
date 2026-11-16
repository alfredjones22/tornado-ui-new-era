import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { decodeEventLog, decodeFunctionResult, encodeEventTopics, encodeFunctionData, parseAbi } from 'viem'
import { extractPublicSnapshot } from './export-tornado-snapshot.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const abi = parseAbi([
  'event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)',
  'event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)',
  'function nextIndex() view returns (uint32)',
  'function getLastRoot() view returns (bytes32)',
  'function denomination() view returns (uint256)',
  'function levels() view returns (uint32)',
  'function token() view returns (address)',
])
const hex = value => `0x${BigInt(value).toString(16)}`
const address = value => `0x${BigInt(value).toString(16).padStart(40, '0')}`
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export async function sagaDelta(index, base, chainId, pool, start, head, fetcher = fetch) {
  const entries = Object.values(index.availableProtocols).filter(entry => entry.protocol === 'tornado-cash' &&
    BigInt(entry.chainId) === BigInt(chainId) && entry.trackedAddresses?.some(value => BigInt(value) === BigInt(pool)))
  assert(entries.length === 1, 'No unique Saga pool stream')
  const entry = entries[0]
  assert(!entry.extraLogFields?.some(field => field !== 'transactionHash'), 'Unsupported Saga log fields')
  const segments = [...entry.chunks, ...(entry.hotHead ? [entry.hotHead] : [])]
    .sort((a, b) => Number(BigInt(a.fromBlock) - BigInt(b.fromBlock)))
    .filter(segment => BigInt(segment.toBlock) > start && BigInt(segment.fromBlock) <= head)
  let next = start
  const logs = []
  for (const segment of segments) {
    const from = BigInt(segment.fromBlock), to = BigInt(segment.toBlock)
    assert(from <= next && to > next && (next === start || from === next), 'Gap or overlap in Saga coverage')
    assert(typeof segment.file === 'string' && !segment.file.includes('/') && segment.file.endsWith('.jsonl.gz'), 'Invalid Saga filename')
    const response = await fetcher(`${base}/${segment.file}`, { signal: AbortSignal.timeout(30_000), cache: 'no-store' })
    assert(response.ok, `Saga chunk HTTP ${response.status}`)
    const compressed = Buffer.from(await response.arrayBuffer())
    const raw = compressed[0] === 0x1f && compressed[1] === 0x8b ? gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 }) : compressed
    assert(segment.digest?.type === 'sha256' && sha256(raw) === segment.digest.data.replace(/^0x/, ''), 'Saga checksum mismatch')
    let previousBlock = -1n, previousIndex = -1n
    for (const line of raw.toString('utf8').split('\n')) {
      if (!line) continue
      const event = JSON.parse(line), block = BigInt(event.blockNumber), logIndex = BigInt(event.logIndex)
      assert(block >= from && block < to && BigInt(event.contractAddress) === BigInt(pool), 'Saga event outside its pool or range')
      assert(block > previousBlock || (block === previousBlock && logIndex > previousIndex), 'Unordered Saga events')
      previousBlock = block; previousIndex = logIndex
      decodeEventLog({ abi, data: event.data, topics: event.topics, strict: true })
      if (block >= start && block <= head) logs.push({ address: event.contractAddress, blockNumber: event.blockNumber,
        logIndex: event.logIndex, topics: event.topics, data: event.data, removed: false,
        transactionHash: event.transactionHash ?? `0x${'0'.repeat(64)}` })
    }
    next = to < head + 1n ? to : head + 1n
  }
  return { next, logs }
}

export function mergePoolLogs(state, logs, checkpoint) {
  const pools = new Map(state.pools.poolsTuples.map(([key, pool]) => [BigInt(key), { key, pool }]))
  const deposits = new Map(state.deposits.depositsTuples.map(([key, values]) => [BigInt(key), new Map(values)]))
  const withdrawals = new Map(state.withdrawals.withdrawalsTuples)
  const added = { deposits: 0, withdrawals: 0 }
  const seen = new Set()
  let previousBlock = -1n, previousIndex = -1n
  for (const log of logs) {
    const saved = pools.get(BigInt(log.address))
    assert(saved, 'RPC returned a log from an unselected pool')
    const block = BigInt(log.blockNumber), index = BigInt(log.logIndex)
    assert(!log.removed && block > BigInt(saved.pool.lastSyncedBlock) && block <= checkpoint, 'RPC log outside the requested finalized range')
    assert(block > previousBlock || (block === previousBlock && index > previousIndex), 'RPC returned duplicate or unordered logs')
    previousBlock = block; previousIndex = index
    assert(/^0x[0-9a-f]{64}$/i.test(log.transactionHash), 'RPC log is missing its transaction hash')
    const position = `${block}:${index}`
    assert(!seen.has(position), 'Duplicate RPC log')
    seen.add(position)
    const event = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true })
    const common = { blockNumber: hex(block), transactionHash: hex(log.transactionHash), pool: saved.key }
    if (event.eventName === 'Deposit') {
      const commitment = hex(event.args.commitment)
      let poolDeposits = deposits.get(BigInt(saved.key))
      if (!poolDeposits) deposits.set(BigInt(saved.key), poolDeposits = new Map())
      assert(!poolDeposits.has(commitment), 'RPC repeated an existing commitment')
      poolDeposits.set(commitment, { ...common, commitment, leafIndex: Number(event.args.leafIndex), timestamp: hex(event.args.timestamp) })
      added.deposits++
    } else {
      assert(event.eventName === 'Withdrawal', 'Unexpected pool event')
      const nullifierHash = hex(event.args.nullifierHash)
      assert(!withdrawals.has(nullifierHash), 'RPC repeated an existing nullifier')
      withdrawals.set(nullifierHash, { ...common, nullifierHash, to: hex(event.args.to), relayer: hex(event.args.relayer), fee: hex(event.args.fee) })
      added.withdrawals++
    }
  }
  state.deposits.depositsTuples = [...deposits].map(([key, values]) => [pools.get(key).key, [...values].sort((a, b) => a[1].leafIndex - b[1].leafIndex)])
  state.withdrawals.withdrawalsTuples = [...withdrawals]
  for (const [, pool] of state.pools.poolsTuples) {
    assert(BigInt(pool.lastSyncedBlock) <= checkpoint, 'Snapshot is newer than the finalized checkpoint')
    pool.lastSyncedBlock = hex(checkpoint)
  }
  state.sync.lastSyncedBlock = hex(checkpoint)
  return added
}

async function main() {
  const [destination, source = 'history-export'] = process.argv.slice(2)
  if (!destination || process.argv.length > 4) throw new Error('Usage: node scripts/refresh-tornado-history.mjs <new-output-directory> [existing-pool-directory]')
  const output = resolve(destination), input = resolve(source)
  assert(!existsSync(output) || readdirSync(output).length === 0, 'Choose a new output directory; previous snapshots are never overwritten')
  const manifest = JSON.parse(readFileSync(resolve(root, 'src/core/history-manifest.json'), 'utf8'))
  // Use the same locally built MiMC implementation as the SDK, without importing
  // its wallet/state manager or generating any keys. This script is read-only RPC.
  const { buildTree } = await import(new URL('./merkle-tree.node.js', import.meta.resolve('@kohaku-eth/tornado-cash')).href)
  const summary = { generatedAt: new Date().toISOString(), chains: {} }
  mkdirSync(output, { recursive: true })
  for (const chainId of [1, 11155111]) {
    const endpoint = chainId === 1 ? 'https://rpc.flashbots.net' : 'https://0xrpc.io/sep'
    let nextId = 0
    async function rpc(method, params) {
      for (let attempt = 0; ; attempt++) {
        try {
          const url = chainId === 1 && method === 'eth_call' ? 'https://ethereum.publicnode.com' : endpoint
          const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }), signal: AbortSignal.timeout(30_000) })
          const body = await response.json()
          if (body.error) throw new Error(`${method}: ${body.error.message}`)
          assert(response.ok, `RPC HTTP ${response.status}`)
          assert(body.result !== undefined && body.result !== null, `${method}: missing result`)
          return body.result
        } catch (error) {
          if (attempt >= 3) throw error
          await new Promise(done => setTimeout(done, 500 * 2 ** attempt))
        }
      }
    }
    assert(BigInt(await rpc('eth_chainId', [])) === BigInt(chainId), 'RPC network mismatch')
    const checkpoint = await rpc('eth_getBlockByNumber', ['finalized', false])
    const head = BigInt(checkpoint.number)
    console.log(`Chain ${chainId}: finalized checkpoint ${head} (${new Date(Number(BigInt(checkpoint.timestamp)) * 1000).toISOString()})`)
    const sagaBase = `https://saga.gordosoluciones.xyz${chainId === 1 ? '' : '/sepolia'}`
    let sagaIndex
    try {
      const response = await fetch(`${sagaBase}/index.json`, { signal: AbortSignal.timeout(15_000), cache: 'no-store' })
      assert(response.ok, `Saga index HTTP ${response.status}`)
      const parsed = await response.json()
      assert([1, 2].includes(parsed.version) && parsed.compression === 'gzip' && parsed.availableProtocols, 'Unsupported Saga index')
      sagaIndex = parsed
    } catch (error) { console.warn(`Chain ${chainId}: skipping Saga (${error.message})`) }
    const chain = manifest.chains[chainId]
    let state
    for (const [poolAddress, descriptor] of Object.entries(chain.pools)) {
      const compressed = readFileSync(resolve(input, descriptor.file)), raw = gunzipSync(compressed)
      assert(compressed.length === descriptor.gzipBytes && raw.length === descriptor.jsonBytes && sha256(raw) === descriptor.sha256,
        `Source snapshot checksum mismatch for ${poolAddress}`)
      const parsed = JSON.parse(raw), saved = parsed[chain.stateKey]
      assert(Object.keys(parsed).length === 1 && saved && BigInt(saved.instanceRegistryInfo.chainId) === BigInt(chainId), 'Wrong snapshot network')
      assert(saved.pools.poolsTuples.length === 1 && BigInt(saved.pools.poolsTuples[0][0]) === BigInt(poolAddress) &&
        BigInt(saved.pools.poolsTuples[0][1].lastSyncedBlock) === BigInt(descriptor.toBlock), 'Wrong source pool checkpoint')
      if (!state) state = { ...saved, pools: { poolsTuples: [] }, deposits: { depositsTuples: [] }, withdrawals: { withdrawalsTuples: [] }, assets: { assetsTuples: [] } }
      state.pools.poolsTuples.push(...saved.pools.poolsTuples)
      state.deposits.depositsTuples.push(...saved.deposits.depositsTuples)
      state.withdrawals.withdrawalsTuples.push(...saved.withdrawals.withdrawalsTuples)
      state.assets.assetsTuples.push(...saved.assets.assetsTuples)
    }
    state.assets.assetsTuples = [...new Map(state.assets.assetsTuples)]
    const groups = new Map()
    for (const [key, pool] of state.pools.poolsTuples) {
      const start = BigInt(pool.lastSyncedBlock) + 1n
      assert(start <= head + 1n, 'Source snapshot is newer than finalized history')
      const group = groups.get(start) ?? []
      group.push(address(key)); groups.set(start, group)
    }
    const topics = [['Deposit', 'Withdrawal'].map(eventName => encodeEventTopics({ abi, eventName })[0])]
    const logs = []
    async function range(addresses, from, to) {
      try { return await rpc('eth_getLogs', [{ address: addresses.length === 1 ? addresses[0] : addresses, fromBlock: hex(from), toBlock: hex(to), topics }]) }
      catch (error) {
        if (from === to || !/range|limit|size|too (?:large|many)|more than/i.test(error.message)) throw error
        const mid = (from + to) / 2n
        return [...await range(addresses, from, mid), ...await range(addresses, mid + 1n, to)]
      }
    }
    // Query pools separately: some public RPCs returned incomplete results for
    // a multi-address filter even though they accepted the request.
    const jobs = [...groups].flatMap(([start, addresses]) => addresses.map(pool => ({ start, pool })))
    let next = 0
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (next < jobs.length) {
        const { start: originalStart, pool } = jobs[next++]
        let start = originalStart
        let count = 0
        if (sagaIndex) {
          try {
            const delta = await sagaDelta(sagaIndex, sagaBase, chainId, pool, start, head)
            logs.push(...delta.logs); count += delta.logs.length; start = delta.next
          } catch (error) { console.warn(`Chain ${chainId}: skipping Saga for ${pool} (${error.message})`) }
        }
        for (let from = start; from <= head; from += 2_000n) {
          const to = from + 1_999n < head ? from + 1_999n : head
          const result = await range([pool], from, to)
          assert(Array.isArray(result), 'Invalid RPC logs result')
          logs.push(...result); count += result.length
        }
        console.log(`Chain ${chainId}: synced ${pool} (${count} new events)`)
      }
    }))
    logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)))
    writeFileSync(resolve(output, '../', `rpc-logs-${chainId}.json`), JSON.stringify({ checkpoint, logs }))
    const added = mergePoolLogs(state, logs, head)
    const verified = []
    for (const [key, pool] of state.pools.poolsTuples) {
      const read = async functionName => decodeFunctionResult({ abi, functionName, data: await rpc('eth_call', [{ to: address(key),
        data: encodeFunctionData({ abi, functionName }) }, checkpoint.number]) })
      const leaves = state.deposits.depositsTuples.find(([poolKey]) => BigInt(poolKey) === BigInt(key))?.[1] ?? []
      const invalid = leaves.findIndex(([commitment, event], index) => event.leafIndex !== index || BigInt(commitment) !== BigInt(event.commitment))
      assert(invalid === -1, `Incomplete deposit sequence for ${address(key)} at index ${invalid} (got ${leaves[invalid]?.[1].leafIndex})`)
      const [count, rootOnchain, denomination, levels] = await Promise.all(['nextIndex', 'getLastRoot', 'denomination', 'levels'].map(read))
      assert(Number(count) === leaves.length, `Deposit count mismatch for ${address(key)}`)
      assert(denomination === BigInt(pool.denomination) && Number(levels) === 20, `Pool configuration mismatch for ${address(key)}`)
      if (pool.isERC20) assert(BigInt(await read('token')) === BigInt(pool.asset), 'Pool token mismatch')
      console.log(`Chain ${chainId}: checking ${address(key)} Merkle root (${leaves.length} deposits)…`)
      const tree = await buildTree(leaves.map(([commitment]) => BigInt(commitment)))
      assert(BigInt(tree.root) === BigInt(rootOnchain), `Merkle root mismatch for ${address(key)}`)
      const withdrawals = state.withdrawals.withdrawalsTuples.filter(([, event]) => BigInt(event.pool) === BigInt(key)).length
      verified.push({ address: address(key), deposits: leaves.length, withdrawals, root: rootOnchain })
      console.log(`Chain ${chainId}: verified ${address(key)} (${leaves.length} deposits, ${withdrawals} withdrawals)`)
    }
    assert((await rpc('eth_getBlockByNumber', [checkpoint.number, false])).hash === checkpoint.hash, 'Checkpoint changed during refresh')
    const { snapshot, summary: counts } = extractPublicSnapshot({ [chain.stateKey]: JSON.stringify(state) }, chainId)
    const raw = Buffer.from(`${JSON.stringify(snapshot)}\n`), compressed = gzipSync(raw, { level: 9 })
    const filename = `tornado-${chainId === 1 ? 'mainnet' : 'sepolia'}.json.gz`
    writeFileSync(resolve(output, filename), compressed, { flag: 'wx' })
    summary.chains[chainId] = { ...counts, added, block: Number(head), blockHash: checkpoint.hash,
      blockTimestamp: new Date(Number(BigInt(checkpoint.timestamp)) * 1000).toISOString(), sha256: sha256(raw),
      jsonBytes: raw.length, gzipBytes: compressed.length, file: filename, verified }
    writeFileSync(resolve(output, 'refresh-summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(`Chain ${chainId}: saved ${filename}; added ${added.deposits} deposits and ${added.withdrawals} withdrawals`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
