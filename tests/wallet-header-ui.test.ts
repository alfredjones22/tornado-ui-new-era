import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import App from '../src/App.vue'
import { Element, renderer, content, descendants, button } from './fixtures/vue-renderer'
import type { WalletOption } from '../src/core/wallet'

vi.mock('../src/core/rpc', async original => ({ ...await original<object>(), publicClientFor: vi.fn(() => ({ readContract: vi.fn(async () => 0) })) }))
const first = '0x1111111111111111111111111111111111111111', second = '0x2222222222222222222222222222222222222222'
let cleanup: (() => void) | undefined
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('Document', class {}); vi.stubGlobal('ShadowRoot', class {})
  vi.stubGlobal('location', new URL('http://localhost:4174/'))
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
})
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.unstubAllGlobals() })

describe('connected account in the actual site header', () => {
  it.each(['', '#multi-withdraw', '#smart-account'])('never contacts or restores injected wallets on arrival, focus or discovery (%s)', async hash => {
    vi.stubGlobal('location', new URL(`http://localhost:4174/${hash}`))
    const provider = { request: vi.fn(async () => [first]), on: vi.fn(), removeListener: vi.fn() }
    const other = { request: vi.fn(async () => [second]), on: vi.fn(), removeListener: vi.fn() }
    const browser = new EventTarget(), legacyGetter = vi.fn(() => provider), discoveryRequest = vi.fn()
    Object.defineProperty(browser, 'ethereum', { get: legacyGetter })
    browser.addEventListener('eip6963:requestProvider', discoveryRequest)
    vi.stubGlobal('window', browser)
    const app = renderer.createApp(App), root = new Element('root')
    app.mount(root); cleanup = () => app.unmount()
    // Extensions may announce themselves and expose already-authorized accounts.
    // Neither event is consent to interact with them or restore their accounts.
    for (const [uuid, announced] of [['first', provider], ['other', other]] as const) {
      browser.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid, name: uuid }, provider: announced } }))
    }
    browser.dispatchEvent(new Event('focus')); browser.dispatchEvent(new Event('pageshow'))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(30_000); await nextTick()
    expect(provider.request).not.toHaveBeenCalled(); expect(other.request).not.toHaveBeenCalled()
    expect(provider.on).not.toHaveBeenCalled(); expect(other.on).not.toHaveBeenCalled()
    expect(legacyGetter).not.toHaveBeenCalled(); expect(discoveryRequest).not.toHaveBeenCalled()
    expect(button(root, 'Connect wallet')).toBeDefined()
    expect(descendants(root).some(node => String(node.props['aria-label']).startsWith('Connected wallet'))).toBe(false)
    // Opening the chooser discovers providers but still does not query accounts.
    ;(button(root, 'Connect wallet')!.props.onClick as () => void)()
    await vi.advanceTimersByTimeAsync(0); await nextTick()
    expect(legacyGetter).toHaveBeenCalledOnce(); expect(discoveryRequest).toHaveBeenCalledOnce()
    expect(provider.request).not.toHaveBeenCalled(); expect(other.request).not.toHaveBeenCalled()
  })

  it('connects only the wallet explicitly selected from the chooser', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => method === 'eth_chainId' ? '0x1'
      : method === 'wallet_getCapabilities' ? {} : [first])
    const other = vi.fn(async () => [second]), browser = new EventTarget()
    vi.stubGlobal('window', browser)
    const app = renderer.createApp(App), root = new Element('root')
    app.mount(root); cleanup = () => app.unmount()
    for (const [uuid, provider] of [['Chosen wallet', { request }], ['Other wallet', { request: other }]] as const) {
      browser.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid, name: uuid }, provider } }))
    }
    ;(button(root, 'Connect wallet')!.props.onClick as () => void)(); await vi.advanceTimersByTimeAsync(0); await nextTick()
    expect(request).not.toHaveBeenCalled(); expect(other).not.toHaveBeenCalled()
    await (button(root, 'Chosen wallet')!.props.onClick as () => Promise<void>)(); await vi.advanceTimersByTimeAsync(0); await nextTick()
    expect(request.mock.calls[0]![0].method).toBe('eth_requestAccounts')
    expect(request.mock.calls.filter(([call]) => call.method === 'eth_requestAccounts')).toHaveLength(1)
    expect(other).not.toHaveBeenCalled()
    expect(content(descendants(root).find(node => String(node.props['aria-label']).startsWith('Connected wallet'))!)).toContain('0x1111…1111')
  })

  it.each(['focus', 'poll'])('follows a silently changed authorized account through %s', async method => {
    let selected = first
    const provider: WalletOption['provider'] = {
      request: vi.fn(async ({ method }) => {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [selected]
        if (method === 'eth_chainId') return '0x1'
        if (method === 'wallet_getCapabilities') return {}
        throw new Error(`Unexpected method ${method}`)
      }),
      on: vi.fn(), removeListener: vi.fn(), // Reproduce the missing accountsChanged event.
    }
    const browser = new EventTarget()
    browser.addEventListener('eip6963:requestProvider', () => browser.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: 'test-wallet', name: 'Test wallet' }, provider },
    })))
    vi.stubGlobal('window', browser)
    const app = renderer.createApp(App), root = new Element('root')
    app.mount(root); cleanup = () => app.unmount()
    await vi.advanceTimersByTimeAsync(0); await nextTick()
    expect(provider.request).not.toHaveBeenCalled()
    ;(button(root, 'Connect wallet')!.props.onClick as () => void)(); await vi.advanceTimersByTimeAsync(0); await nextTick()
    await (button(root, 'Test wallet')!.props.onClick as () => Promise<void>)(); await vi.advanceTimersByTimeAsync(0); await nextTick()
    vi.mocked(provider.request).mockClear()
    const header = () => descendants(root).find(node => node.tag === 'button' && String(node.props['aria-label']).startsWith('Connected wallet'))
    expect(content(header()!)).toContain('0x1111…1111')
    selected = second
    if (method === 'focus') browser.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(method === 'poll' ? 2_000 : 0); await nextTick()
    expect(content(header()!)).toContain('0x2222…2222')
    expect(content(header()!)).not.toContain('0x1111…1111')
    expect(vi.mocked(provider.request).mock.calls.some(([call]) => /requestAccounts|sign|send/i.test(call.method))).toBe(false)
  })
})
