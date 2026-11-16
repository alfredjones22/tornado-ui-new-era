import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { history, offlineFiles, root, verifyOfflineBytes } from './offline-assets.mjs'

const bootstrap = { version: 1, chains: {} }
const sources = process.argv.slice(2)
if (sources.length > 1) throw new Error('Usage: node scripts/prepare-offline-assets.mjs [local-tornado-circuit-directory]')
for (const descriptor of offlineFiles()) {
  const target = resolve(root, 'offline-assets', descriptor.target)
  let bytes
  if (existsSync(target)) bytes = readFileSync(target)
  else if (descriptor.target.startsWith('history/') && existsSync(resolve(root, 'history-export', descriptor.file))) {
    bytes = readFileSync(resolve(root, 'history-export', descriptor.file))
  } else if (descriptor.target.startsWith('proving/')) {
    const local = resolve(sources[0] ?? resolve(root, '../kohaku-cli/node_modules/kohaku-artifacts/artifacts/tornado'), descriptor.source.split('/').at(-1))
    if (existsSync(local)) bytes = gzipSync(readFileSync(local), { level: 9 })
  }
  if (!bytes) {
    console.log(`Downloading public asset ${descriptor.target}`)
    const response = await fetch(descriptor.source, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`Download failed for ${descriptor.target}: HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  const raw = verifyOfflineBytes(bytes, descriptor)
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) bytes = gzipSync(raw, { level: 9 })
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(`${target}.tmp`, bytes)
  renameSync(`${target}.tmp`, target)
  if (descriptor.target.startsWith('history/')) {
    const chainId = descriptor.file.split('/')[0], chain = history.chains[chainId]
    const state = JSON.parse(raw.toString('utf8'))[chain.stateKey]
    const saved = bootstrap.chains[chainId] ??= { stateKey: chain.stateKey, instanceRegistryInfo: state.instanceRegistryInfo,
      relayers: state.relayers, assets: { assetsTuples: [] }, pools: { poolsTuples: [] } }
    // Only public metadata needed to start a full chain scan. Never bootstrap
    // a sync checkpoint without the matching event history.
    saved.pools.poolsTuples.push(...state.pools.poolsTuples.map(([key, { lastSyncedBlock, ...pool }]) => [key, pool]))
    saved.assets.assetsTuples = [...new Map([...saved.assets.assetsTuples, ...state.assets.assetsTuples])]
  }
  console.log(`Verified ${descriptor.target}`)
}
const target = resolve(root, 'src/core/history-bootstrap.json')
writeFileSync(`${target}.tmp`, `${JSON.stringify(bootstrap, null, 2)}\n`)
renameSync(`${target}.tmp`, target)
console.log('Offline assets and public bootstrap metadata are ready. npm run build:ipfs will include every verified file.')
