import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import App from '../src/App.vue'
import { validateConnections } from '../src/core/rpc'
import { ARTIFACTS_URL, SAGA_URLS } from '../src/core/data-sources'
import { Element, renderer, content, descendants, button } from './fixtures/vue-renderer'

vi.mock('../src/core/rpc', async original => ({ ...await original<object>(), validateConnections: vi.fn(),
  publicClientFor: () => ({ readContract: async () => 0 }) }))
let cleanup: (() => void) | undefined
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.mocked(validateConnections).mockResolvedValue(undefined)
  vi.stubGlobal('Document', class {}); vi.stubGlobal('ShadowRoot', class {})
  vi.stubGlobal('location', new URL('http://localhost:4174/'))
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  vi.stubGlobal('window', new EventTarget())
})
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.unstubAllGlobals() })
const settle = async () => { await vi.advanceTimersByTimeAsync(0); await nextTick() }
async function mountSettings() {
  const app = renderer.createApp(App), root = new Element('root'); app.mount(root); cleanup = () => app.unmount()
  await settle()
  const open = async () => {
    const control = descendants(root).find(node => node.tag === 'button' && node.props['aria-label'] === 'Settings')!
    ;(control.props.onClick as () => void)(); await settle()
  }
  const set = async (id: string, value: unknown) => {
    const field = descendants(root).find(node => node.props.id === id)!
    ;(field.props['onUpdate:modelValue'] as (value: unknown) => void)(value); await settle()
  }
  const save = async () => { await (button(root, 'Verify & save')!.props.onClick as () => Promise<void>)(); await settle() }
  await open()
  return { root, open, set, save }
}
describe('advanced history and artifact settings', () => {
  it('keeps default sources behind Advanced and normalizes a custom mirror base path', async () => {
    const page = await mountSettings()
    const advanced = descendants(page.root).find(node => node.tag === 'details' && node.props.class === 'advanced-sources')!
    expect(advanced.props.open).toBeUndefined()
    expect(content(advanced)).toContain('Bundled history and proving files are always tried first')
    await page.set('saga-source-url', 'https://mirror.example/saga')
    await page.set('artifacts-source-url', 'https://mirror.example/ipfs/artifact-cid')
    await page.save()
    expect(validateConnections).toHaveBeenLastCalledWith(expect.objectContaining({
      sagaUrl: 'https://mirror.example/saga/', artifactsUrl: 'https://mirror.example/ipfs/artifact-cid/',
    }))
  })
  it('lets users disable both helpers without validating unused URLs', async () => {
    const page = await mountSettings()
    await page.set('saga-source-url', 'not a URL'); await page.set('artifacts-source-url', 'not a URL')
    await page.set('use-saga-source', false); await page.set('use-artifact-backups', false)
    expect(descendants(page.root).find(node => node.props.id === 'saga-source-url')!.props.disabled).toBe(true)
    await page.save()
    expect(validateConnections).toHaveBeenLastCalledWith(expect.objectContaining({ sagaUrl: null, artifactsUrl: null }))
  })
  it('restores default settings and keeps the existing pinned GitHub backup as the default', async () => {
    const page = await mountSettings()
    await page.set('saga-source-url', 'https://custom.example')
    await page.set('artifacts-source-url', 'https://mirror.example')
    await page.set('use-saga-source', false)
    ;(button(page.root, 'Reset sources to defaults')!.props.onClick as () => void)(); await settle()
    expect(descendants(page.root).find(node => node.props.id === 'saga-source-url')!.value).toBe(SAGA_URLS[1])
    expect(descendants(page.root).find(node => node.props.id === 'artifacts-source-url')!.value).toBe(ARTIFACTS_URL)
    await page.save()
    const settings = vi.mocked(validateConnections).mock.lastCall![0]
    expect(settings.sagaUrl).toBe(`${SAGA_URLS[1]}/`)
    expect(settings).not.toHaveProperty('artifactsUrl')
  })
  it('keeps Saga overrides separate for mainnet and Sepolia', async () => {
    const page = await mountSettings()
    await page.set('saga-source-url', 'https://mirror.example/mainnet')
    ;(descendants(page.root).find(node => node.props['aria-label'] === 'Close dialog')!.props.onClick as () => void)(); await settle()
    const network = descendants(page.root).find(node => node.props['aria-label'] === 'Network')!
    ;(network.props['onUpdate:modelValue'] as (value: number) => void)(11155111); await settle(); await page.open()
    expect(descendants(page.root).find(node => node.props.id === 'saga-source-url')!.value).toBe(SAGA_URLS[11155111])
    await page.set('saga-source-url', 'https://mirror.example/sepolia'); await page.save()
    expect(validateConnections).toHaveBeenLastCalledWith(expect.objectContaining({ chainId: 11155111, sagaUrl: 'https://mirror.example/sepolia/' }))
  })
})
