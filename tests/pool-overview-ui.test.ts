import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import App from '../src/App.vue'
import { poolFor } from '../src/core/catalog'
import { Element, renderer, content, descendants, button } from './fixtures/vue-renderer'

const { readContract } = vi.hoisted(() => ({ readContract: vi.fn() }))
vi.mock('../src/core/rpc', async original => ({ ...await original<object>(), publicClientFor: () => ({ readContract }) }))
let cleanup: (() => void) | undefined
const settle = async () => { await vi.advanceTimersByTimeAsync(0); await nextTick() }
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); readContract.mockResolvedValue(20)
  vi.stubGlobal('Document', class {}); vi.stubGlobal('ShadowRoot', class {})
  vi.stubGlobal('location', new URL('http://localhost:4174/'))
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  vi.stubGlobal('window', new EventTarget())
})
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.unstubAllGlobals() })
async function mountOverview() {
  const app = renderer.createApp(App), root = new Element('root'); app.mount(root); cleanup = () => app.unmount(); await settle()
  const panel = descendants(root).find(node => node.props['aria-label'] === 'Pools overview')!
  const tabs = () => descendants(panel).filter(node => node.props.role === 'tab')
  const active = () => tabs().find(node => node.props['aria-selected'])
  const click = async (label: string) => {
    const control = descendants(root).find(node => node.tag === 'button' && node.props['aria-label'] === label) ?? button(root, label)!
    await (control.props.onClick as () => void)(); await settle()
  }
  return { root, panel, tabs, active, click }
}
describe('pool overview follows the deposit cart', () => {
  it('selects newly added pools, switches stats without changing the cart, and removes empty tabs', async () => {
    const page = await mountOverview()
    expect(page.tabs()).toHaveLength(1); expect(content(page.active()!)).toBe('0.01 ETH')
    await page.click('Add one 0.1 ETH note')
    expect(content(page.active()!)).toBe('0.1 ETH')
    expect(readContract).toHaveBeenLastCalledWith(expect.objectContaining({ address: poolFor(1, '0.1')!.address }))
    await page.click('Add one 0.3 ETH note')
    expect(content(page.active()!)).toBe('0.3 ETH'); expect(page.tabs()).toHaveLength(3)
    await (page.tabs().find(node => content(node) === '0.1 ETH')!.props.onClick as () => void)(); await settle()
    expect(content(page.active()!)).toBe('0.1 ETH')
    expect(content(descendants(page.root).find(node => node.props['aria-label'] === 'Deposit cart')!)).toContain('1 × 0.3 ETH')
    await page.click('Remove one 0.1 ETH note')
    expect(page.tabs()).toHaveLength(2); expect(content(page.active()!)).toBe('0.3 ETH')
    await page.click('Add one 0.3 ETH note')
    expect(page.tabs()).toHaveLength(2); expect(content(page.active()!)).toBe('0.3 ETH×2')
  })
  it('keeps all pools browsable and resets tabs when the asset or network changes', async () => {
    const page = await mountOverview()
    expect(descendants(page.panel).find(node => node.props['aria-label'] === 'Overview denomination')).toBeUndefined()
    await page.click('Browse all pools')
    expect(descendants(page.panel).find(node => node.props['aria-label'] === 'Overview denomination')).toBeDefined()
    ;(descendants(page.root).find(node => node.props.id === 'token')!.props['onUpdate:modelValue'] as (value: string) => void)('DAI'); await settle()
    expect(page.tabs()).toHaveLength(1); expect(content(page.active()!)).toBe('100 DAI')
    ;(descendants(page.root).find(node => node.props['aria-label'] === 'Network')!.props['onUpdate:modelValue'] as (value: number) => void)(11155111); await settle()
    expect(page.tabs()).toHaveLength(1); expect(content(page.active()!)).toBe('0.01 ETH')
    await page.click('Remove one 0.01 ETH note')
    expect(page.tabs()).toHaveLength(0)
    expect(descendants(page.panel).find(node => node.props['aria-label'] === 'Overview denomination')).toBeDefined()
  })
  it('ignores late pool statistics after switching to another tab', async () => {
    const page = await mountOverview()
    let finish!: (value: number) => void
    readContract.mockReturnValueOnce(new Promise<number>(resolve => { finish = resolve }))
    await page.click('Add one 0.1 ETH note')
    readContract.mockResolvedValue(42)
    await page.click('Add one 1 ETH note')
    finish(999); await settle()
    expect(content(page.active()!)).toBe('1 ETH')
    expect(descendants(page.panel).find(node => node.tag === 'strong')!.text).toBe('42')
    expect(content(page.panel)).not.toContain('999')
  })
})
