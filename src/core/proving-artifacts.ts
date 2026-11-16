import { TORNADO_CIRCUIT_SHA256, TORNADO_PROVING_KEY_SHA256 } from '@kohaku-eth/tornado-cash'
import manifest from './proving-manifest.json'
import { appAssetUrl } from './app-assets'
import { decompressHistory, historyDigest, readHistoryBytes } from './history-codec'
import { sourceUrl } from './data-sources'

export async function loadPinnedProvingFile(file: { file: string; source: string; sha256: string; jsonBytes: number }, fetcher: typeof fetch = fetch, artifactsUrl?: string | null) {
  const backup = artifactsUrl === undefined ? new URL(file.source, manifest.baseUrl).href : artifactsUrl === null ? null : sourceUrl(file.file, artifactsUrl)
  for (const [index, url] of [appAssetUrl(`offline/${file.file}`), ...(backup ? [backup] : [])].entries()) {
    try {
      const response = await fetcher(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error('Proving file unavailable')
      // Gzip headers may make a small file larger than its plaintext.
      const bytes = await decompressHistory(await readHistoryBytes(response.body, file.jsonBytes + 1024), file.jsonBytes)
      if (bytes.length !== file.jsonBytes || await historyDigest(bytes) !== file.sha256) throw new Error('Proving file integrity check failed')
      return bytes
    } catch {
      if (index === 0 && backup) console.warn('[Tornado proofs] Local proving file unavailable or invalid; trying the pinned backup source.')
    }
  }
  throw new Error('Could not load verified proving files from this site or the backup source. Preserve your notes and try another gateway or a complete build.')
}

/** Proving must work from the site's own CID without GitHub/R2. SDK integrity
 * checks still run before the circuit's executable witness templates are used. */
export async function loadProvingArtifacts(progress: (message: string) => void, fetcher: typeof fetch = fetch, artifactsUrl?: string | null) {
  if (manifest.circuit.sha256 !== TORNADO_CIRCUIT_SHA256 || manifest.key.sha256 !== TORNADO_PROVING_KEY_SHA256) {
    throw new Error('The bundled proving files do not match this SDK version. Rebuild the interface.')
  }
  progress('Loading and verifying local proving files…')
  const [circuit, key] = await Promise.all([loadPinnedProvingFile(manifest.circuit, fetcher, artifactsUrl), loadPinnedProvingFile(manifest.key, fetcher, artifactsUrl)])
  return { circuitText: new TextDecoder('utf-8', { fatal: true }).decode(circuit), provingKey: new Uint8Array(key).buffer }
}
