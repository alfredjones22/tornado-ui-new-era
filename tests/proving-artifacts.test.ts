import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPinnedProvingFile, loadProvingArtifacts } from '../src/core/proving-artifacts'
import { historyDigest } from '../src/core/history-codec'

beforeEach(() => { vi.stubGlobal('location', new URL('https://gateway.example/ipfs/site/withdraw-frame.html')); vi.stubEnv('BASE_URL', './'); vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
describe('self-contained proving files', () => {
  it('uses a custom pinned-file mirror instead of the default GitHub backup', async () => {
    const bytes = new TextEncoder().encode('synthetic pinned public artifact')
    const file = { source: 'synthetic.bin', file: 'proving/synthetic.bin.gz', jsonBytes: bytes.length, sha256: await historyDigest(bytes) }
    const root = 'https://mirror.example/ipfs/artifact-cid/'
    const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).startsWith(root) ? new Response(gzipSync(bytes)) : new Response(null, { status: 404 }))
    expect(await loadPinnedProvingFile(file, fetcher, root)).toEqual(bytes)
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://gateway.example/ipfs/site/offline/proving/synthetic.bin.gz', `${root}proving/synthetic.bin.gz`,
    ])
  })
  it('fails closed without contacting GitHub or another helper when remote backups are disabled', async () => {
    const bytes = new TextEncoder().encode('synthetic pinned public artifact')
    const file = { source: 'synthetic.bin', file: 'proving/synthetic.bin.gz', jsonBytes: bytes.length, sha256: await historyDigest(bytes) }
    const fetcher = vi.fn(async (_url: RequestInfo | URL) => new Response('corrupt fixture'))
    await expect(loadPinnedProvingFile(file, fetcher, null)).rejects.toThrow('Could not load verified proving files')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(String(fetcher.mock.calls[0]![0])).toContain('/ipfs/site/offline/')
  })
  it('verifies and decompresses local files from the site CID while all helper hosts are offline', async () => {
    const bytes = new TextEncoder().encode('public synthetic proving-file fixture, never executed')
    const file = { source: 'synthetic.bin', file: 'proving/synthetic.bin.gz', jsonBytes: bytes.length, sha256: await historyDigest(bytes) }
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      if (!String(url).startsWith('https://gateway.example/ipfs/site/offline/proving/')) throw new Error('All helper hosts offline')
      return new Response(gzipSync(bytes))
    })
    const result = await Promise.all([loadPinnedProvingFile(file, fetcher), loadPinnedProvingFile(file, fetcher)])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result).toEqual([bytes, bytes])
  })
  it('accepts only the pinned backup bytes when a local file is corrupt', async () => {
    const bytes = new TextEncoder().encode('synthetic public proving-file fixture')
    const file = { source: 'synthetic.bin', file: 'proving/synthetic.bin.gz', jsonBytes: bytes.length, sha256: await historyDigest(bytes) }
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(String(url).startsWith('https://gateway.example') ? new Uint8Array([1, 2]) : bytes))
    expect(await loadPinnedProvingFile(file, fetcher)).toEqual(bytes)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('fails closed when neither source supplies the pinned proving bytes', async () => {
    const fetcher = vi.fn(async () => new Response('corrupted file'))
    await expect(loadProvingArtifacts(vi.fn(), fetcher)).rejects.toThrow('Could not load verified proving files')
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
})
