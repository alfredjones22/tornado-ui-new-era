import { describe, expect, it, vi } from 'vitest'
import { createSagaProxy } from '../deployment/saga-proxy/worker.js'

const base = 'https://saga.0000000000.org'
describe('fixed-upstream Saga CORS proxy', () => {
  it('streams the original bytes with CORS and never forwards browser credentials or headers', async () => {
    const bytes = new Uint8Array([31, 139, 8, 0, 1, 2, 3])
    const fetcher = vi.fn(async () => new Response(bytes, { headers: { 'Content-Type': 'application/gzip', 'Set-Cookie': 'upstream-cookie=private' } }))
    const response = await createSagaProxy(fetcher)(new Request(`${base}/sepolia/pool-[0x1,0x2).jsonl.gz`, {
      headers: { Authorization: 'secret fixture', Cookie: 'private fixture', Origin: 'https://ui.example', 'X-Forwarded-For': '192.0.2.1' },
    }))
    expect(await response.bytes()).toEqual(bytes)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.has('Set-Cookie')).toBe(false)
    expect(fetcher.mock.calls[0][0]).toBe('https://saga.gordosoluciones.xyz/sepolia/pool-[0x1,0x2).jsonl.gz')
    expect(fetcher.mock.calls[0][1].headers).toEqual({ Accept: 'application/json, application/gzip, application/octet-stream' })
    expect(fetcher.mock.calls[0][1].redirect).toBe('manual')
  })
  it.each(['/index.json', '/sepolia/index.json', '/pool.hot.jsonl.gz', '/sepolia/pool.hot.jsonl.gz'])('keeps mutable file %s on a short cache TTL', async path => {
    const fetcher = vi.fn(async () => new Response('{}'))
    const response = await createSagaProxy(fetcher)(new Request(base + path))
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=30')
    expect(fetcher.mock.calls[0][1].cf.cacheTtlByStatus).toEqual({ '200-299': 30, '300-599': 0 })
  })
  it('caches sealed chunks longer and answers preflight without an upstream request', async () => {
    const fetcher = vi.fn(async () => new Response('{}')), proxy = createSagaProxy(fetcher)
    expect((await proxy(new Request(`${base}/pool.jsonl.gz`))).headers.get('Cache-Control')).toBe('public, max-age=86400')
    const response = await proxy(new Request(`${base}/index.json`, { method: 'OPTIONS' }))
    expect(response.status).toBe(204); expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it.each(['/https://evil.example/index.json', '/index.json?url=https://evil.example', '/sepolia/%2e%2e%2findex.json', '/unknown', '/%ff'])('refuses unsupported paths and query forwarding: %s', async path => {
    const fetcher = vi.fn()
    expect((await createSagaProxy(fetcher)(new Request(base + path))).status).toBeGreaterThanOrEqual(400)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('refuses writes and returns CORS-enabled non-cacheable errors on upstream failure', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('private upstream error')), proxy = createSagaProxy(fetcher)
    expect((await proxy(new Request(`${base}/index.json`, { method: 'POST', body: 'secret fixture' }))).status).toBe(405)
    expect(fetcher).not.toHaveBeenCalled()
    const response = await proxy(new Request(`${base}/index.json`))
    expect(response.status).toBe(502); expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(await response.text()).not.toContain('private upstream error')
  })
  it('uses a Workers-supported redirect mode and refuses to follow an upstream redirect', async () => {
    const fetcher = vi.fn(async (_url, options) => {
      if (!['manual', 'follow'].includes(options.redirect)) throw new TypeError('Unsupported Workers redirect mode')
      return new Response(null, { status: 302, headers: { Location: 'https://unexpected.example/history' } })
    })
    const response = await createSagaProxy(fetcher)(new Request(`${base}/index.json`))
    expect(fetcher).toHaveBeenCalledOnce()
    expect(response.status).toBe(502)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.has('Location')).toBe(false)
    expect(await response.text()).toContain('unexpected redirect')
  })
  it('does not cache origin errors and returns no body for HEAD', async () => {
    const fetcher = vi.fn(async () => new Response('not found', { status: 404 })), proxy = createSagaProxy(fetcher)
    const response = await proxy(new Request(`${base}/index.json`, { method: 'HEAD' }))
    expect(response.status).toBe(404); expect(await response.text()).toBe('')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})
