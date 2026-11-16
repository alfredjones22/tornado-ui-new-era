import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { extractPublicSnapshot } from './export-tornado-snapshot.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inputs = process.argv.slice(2)
if (inputs.length < 2 || inputs.length > 3) throw new Error('Usage: node scripts/prepare-tornado-cache.mjs <mainnet.json.gz> <sepolia.json.gz> [output-directory]')
const output = resolve(inputs[2] ?? resolve(root, 'history-export'))
const manifest = { version: 1, chains: {} }
for (const [index, chainId] of [1, 11155111].entries()) {
  const raw = gunzipSync(readFileSync(inputs[index]))
  const input = JSON.parse(raw.toString('utf8'))
  const { snapshot } = extractPublicSnapshot(Object.fromEntries(Object.entries(input).map(([key, value]) => [key, JSON.stringify(value)])), chainId)
  const [[stateKey, state]] = Object.entries(snapshot)
  const directory = resolve(output, String(chainId))
  mkdirSync(directory, { recursive: true })
  const pools = {}, files = new Set()
  for (const [poolKey, pool] of state.pools.poolsTuples) {
    const address = `0x${BigInt(poolKey).toString(16).padStart(40, '0')}`
    const isPool = value => BigInt(value) === BigInt(poolKey)
    const deposits = state.deposits.depositsTuples.filter(([key]) => isPool(key))
    const withdrawals = state.withdrawals.withdrawalsTuples.filter(([, event]) => isPool(event.pool))
    const events = deposits.flatMap(([, events]) => events).sort((a, b) => a[1].leafIndex - b[1].leafIndex)
    if (events.some(([commitment, event], i) => event.leafIndex !== i || BigInt(commitment) !== BigInt(event.commitment) ||
      !isPool(event.pool) || BigInt(event.blockNumber) > BigInt(pool.lastSyncedBlock))) throw new Error(`Incomplete deposit sequence for ${address}`)
    if (withdrawals.some(([nullifier, event]) => BigInt(nullifier) !== BigInt(event.nullifierHash) ||
      BigInt(event.blockNumber) > BigInt(pool.lastSyncedBlock))) throw new Error(`Invalid withdrawals for ${address}`)
    const single = { [stateKey]: { ...state,
      pools: { poolsTuples: [[poolKey, pool]] }, deposits: { depositsTuples: events.length ? [[poolKey, events]] : [] },
      withdrawals: { withdrawalsTuples: withdrawals },
      assets: { assetsTuples: state.assets.assetsTuples.filter(([key]) => BigInt(key) === BigInt(pool.asset)) },
      sync: { ...state.sync, lastSyncedBlock: pool.lastSyncedBlock },
    } }
    const json = Buffer.from(`${JSON.stringify(single)}\n`)
    const sha256 = createHash('sha256').update(json).digest('hex')
    const filename = `${address}-${sha256.slice(0, 16)}.json.gz`
    const compressed = gzipSync(json, { level: 9 })
    writeFileSync(resolve(directory, filename), compressed)
    files.add(filename)
    pools[address] = { file: `${chainId}/${filename}`, sha256, jsonBytes: json.length, gzipBytes: compressed.length,
      fromBlock: pool.registeredBlock, toBlock: pool.lastSyncedBlock, deposits: events.length, withdrawals: withdrawals.length }
  }
  manifest.chains[chainId] = { stateKey, sourceSha256: createHash('sha256').update(raw).digest('hex'), pools }
  console.log(`Chain ${chainId}: ${files.size} pool files, ${Object.values(pools).reduce((n, p) => n + p.gzipBytes, 0)} compressed bytes`)
}
const target = resolve(root, 'src/core/history-manifest.json')
writeFileSync(`${target}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`)
renameSync(`${target}.tmp`, target)
console.log(`Upload ${output}/1 and ${output}/11155111 to https://artifacts.0000000000.org/tornado-history/v1/ before deploying the updated manifest. Keep existing hashed objects.`)
