// Fixed public upstream: this is not an arbitrary-URL proxy. No incoming
// browser headers are copied upstream; Cloudflare adds its own network headers.
const UPSTREAM = 'https://saga.gordosoluciones.xyz'
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

export function createSagaProxy(fetcher = fetch) {
  return async request => {
    const fail = (status, message) => new Response(message, { status, headers: { ...cors, 'Cache-Control': 'no-store' } })
    const url = new URL(request.url)
    let path
    try { path = decodeURIComponent(url.pathname) } catch { return fail(400, 'Invalid path.') }
    if (url.search || path.includes('..') || !/^\/(?:sepolia\/)?(?:index\.json|[a-zA-Z0-9_.\[\](),-]+\.jsonl\.gz)$/.test(path)) {
      return fail(404, 'Unknown history file.')
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (!['GET', 'HEAD'].includes(request.method)) return fail(405, 'Read-only endpoint.')
    // An index or hot-head filename can change contents. Never cache either
    // for a long time. Sealed chunks benefit from a longer shared edge cache.
    const ttl = path.endsWith('/index.json') || path.endsWith('.hot.jsonl.gz') ? 30 : 86_400
    try {
      const upstream = await fetcher(new URL(path, UPSTREAM).href, {
        // Workers supports follow/manual, but rejects redirect: 'error'. Keep
        // redirects manual and reject them below so the upstream stays fixed.
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'application/json, application/gzip, application/octet-stream' },
        cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': ttl, '300-599': 0 } },
      })
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel()
        return fail(502, 'Saga upstream returned an unexpected redirect.')
      }
      const headers = new Headers(upstream.headers)
      for (const [name, value] of Object.entries(cors)) headers.set(name, value)
      headers.delete('Set-Cookie')
      headers.set('Cache-Control', upstream.ok ? `public, max-age=${ttl}` : 'no-store')
      if (request.method === 'HEAD') await upstream.body?.cancel()
      return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers })
    } catch { return fail(502, 'Saga upstream unavailable. The interface can continue with bundled history and RPC.') }
  }
}

export default { fetch: createSagaProxy() }
