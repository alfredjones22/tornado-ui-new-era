import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import App from '../src/App.vue'
import { currentPage, pageUrl } from '../src/core/routes'
import { button, content, descendants, Element, renderer } from './fixtures/vue-renderer'

vi.mock('../src/core/rpc', async original => ({ ...await original<object>(), publicClientFor: vi.fn(() => ({ readContract: vi.fn(async () => 0) })) }))
let cleanup: (() => void) | undefined
let browser: EventTarget
beforeEach(() => {
  vi.stubEnv('BASE_URL', './')
  vi.stubGlobal('Document', class {}); vi.stubGlobal('ShadowRoot', class {})
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible', querySelector: () => null }))
  browser = new EventTarget(); vi.stubGlobal('window', browser)
  vi.stubGlobal('history', {
    pushState: vi.fn((_state: unknown, _title: string, url: string) => vi.stubGlobal('location', new URL(url))),
    replaceState: vi.fn((_state: unknown, _title: string, url: string) => vi.stubGlobal('location', new URL(url))),
  })
})
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllEnvs(); vi.unstubAllGlobals() })
function mount(url: string) {
  vi.stubGlobal('location', new URL(url))
  const root = new Element('root'), app = renderer.createApp(App)
  app.mount(root); cleanup = () => app.unmount()
  return root
}

describe('static /compliance navigation', () => {
  it.each(['https://site.example/compliance', 'https://gateway.example/ipfs/site/compliance/', 'https://site.example/prefix/compliance/index.html'])('opens the read-only compliance view directly at %s', url => {
    const root = mount(url)
    expect(currentPage()).toBe('compliance')
    expect(descendants(root).find(node => node.props.id === 'compliance-title')).toBeDefined()
    expect(content(root)).toContain('No wallet connection or signature is needed')
    expect(button(root, 'Generate report')!.props.disabled).toBe(true)
  })
  it('navigates without reloading the app and retains the deposit cart on return', async () => {
    const root = mount('https://gateway.example/ipfs/site/')
    const add = button(root, '+')! // The first pool quantity control.
    ;(add.props.onClick as () => void)(); await nextTick()
    const link = descendants(root).find(node => node.tag === 'a' && content(node) === 'Compliance')!
    expect(link.props.href).toBe('https://gateway.example/ipfs/site/compliance/')
    ;(link.props.onClick as (event: unknown) => void)({ preventDefault() {} }); await nextTick()
    expect(currentPage()).toBe('compliance')
    expect(pageUrl('multi')).toBe('https://gateway.example/ipfs/site/#multi-withdraw')
    ;(button(root, 'Back to Tornado')!.props.onClick as () => void)(); await nextTick()
    expect(currentPage()).toBe('basic')
    expect(descendants(root).find(node => node.props.id === 'deposit-tab')!.props['aria-selected']).toBe(true)
    expect(content(root)).toContain('2 notes')
  })
  it('follows browser back/forward navigation', async () => {
    const root = mount('https://site.example/')
    vi.stubGlobal('location', new URL('https://site.example/compliance/')); browser.dispatchEvent(new Event('popstate')); await nextTick()
    expect(descendants(root).find(node => node.props.id === 'compliance-title')).toBeDefined()
    vi.stubGlobal('location', new URL('https://site.example/#multi-withdraw')); browser.dispatchEvent(new Event('popstate')); await nextTick()
    expect(currentPage()).toBe('multi')
    expect(descendants(root).find(node => node.props.id === 'compliance-title')).toBeUndefined()
  })
})
