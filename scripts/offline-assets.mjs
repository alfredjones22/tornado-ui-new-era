import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const json = file => JSON.parse(readFileSync(resolve(root, `src/core/${file}.json`), 'utf8'))
export const history = json('history-manifest'), relayers = json('relayer-history-manifest'), proving = json('proving-manifest')
export const offlineFiles = () => [
  ...Object.values(history.chains).flatMap(chain => Object.values(chain.pools).map(pool => ({ ...pool, target: `history/${pool.file}`,
    source: `https://artifacts.0000000000.org/tornado-history/v1/${pool.file}` }))),
  ...relayers.chunks.map(chunk => ({ ...chunk, target: `relayers/${chunk.file}`, source: `https://artifacts.0000000000.org/sync-cache/v2/saga/${chunk.file}` })),
  ...[proving.circuit, proving.key].map(file => ({ ...file, target: file.file, source: new URL(file.source, proving.baseUrl).href })),
]
export function verifyOfflineBytes(compressed, descriptor) {
  const bytes = compressed[0] === 0x1f && compressed[1] === 0x8b ? gunzipSync(compressed, { maxOutputLength: descriptor.jsonBytes }) : compressed
  assert(bytes.length === descriptor.jsonBytes && createHash('sha256').update(bytes).digest('hex') === descriptor.sha256,
    `Offline asset integrity check failed: ${descriptor.target}`)
  return bytes
}
export function readOfflineAssets() {
  return offlineFiles().map(file => {
    let bytes
    try { bytes = readFileSync(resolve(root, 'offline-assets', file.target)) }
    catch { throw new Error(`Missing offline asset ${file.target}. Run npm run prepare:offline before building.`) }
    verifyOfflineBytes(bytes, file)
    return { fileName: `offline/${file.target}`, bytes }
  })
}
