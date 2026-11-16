import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import Compliance from '../src/Compliance.vue'
import { createComplianceReport } from '../src/core/compliance'
import { complianceFixture } from './fixtures/compliance'
import { button, content, descendants, Element, renderer } from './fixtures/vue-renderer'

vi.mock('../src/core/compliance', async original => ({ ...await original<object>(), createComplianceReport: vi.fn() }))
let cleanup: (() => void) | undefined
const props = { chainId: 11155111 as const, connectionKey: 'sepolia', getSettings: () => ({ chainId: 11155111 as const, rpcUrl: 'https://rpc.example', bundler: 'custom' as const, bundlerUrl: '' }) }
function mount() {
  const root = new Element('root'), app = renderer.createApp(Compliance, props)
  app.mount(root); cleanup = () => app.unmount()
  const input = () => descendants(root).find(node => node.props.id === 'compliance-note')!
  return { root, input }
}
async function paste(input: Element, value: string) {
  input.value = value; input.events.get('input')!({ target: input }); await nextTick()
}
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('Document', class {}); vi.stubGlobal('ShadowRoot', class {}) })
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals() })

describe('compliance disclosure UI', () => {
  it('waits for explicit review, shows verified evidence, and requires disclosure acknowledgement', async () => {
    vi.mocked(createComplianceReport).mockResolvedValue(complianceFixture())
    const { root, input } = mount()
    expect(createComplianceReport).not.toHaveBeenCalled()
    expect(content(root)).toContain('No wallet connection or signature is needed')
    await paste(input(), complianceFixture().note.raw)
    expect(createComplianceReport).not.toHaveBeenCalled()
    await (button(root, 'Generate report')!.props.onClick as () => Promise<void>)(); await nextTick()
    expect(content(root)).toContain('Pool recipient'); expect(content(root)).toContain('This report contains the full note')
    expect(button(root, 'Download PDF report')!.props.disabled).toBe(true)
    expect(descendants(root).filter(node => node.tag === 'a').some(node => String(node.props.href).startsWith('https://sepolia.etherscan.io/tx/'))).toBe(true)
    const checkbox = descendants(root).find(node => node.tag === 'input' && node.props.type === 'checkbox')!
    checkbox.checked = true; checkbox.events.get('change')!({ target: checkbox }); await nextTick()
    expect(button(root, 'Download PDF report')!.props.disabled).toBe(false)
    await paste(input(), '')
    expect(button(root, 'Download PDF report')).toBeUndefined()
  })
  it('does not allow an unspent note to be exported', async () => {
    vi.mocked(createComplianceReport).mockResolvedValue({ ...complianceFixture(), withdrawal: null })
    const { root, input } = mount(); await paste(input(), complianceFixture().note.raw)
    await (button(root, 'Generate report')!.props.onClick as () => Promise<void>)(); await nextTick()
    expect(content(root)).toContain('This note has not been spent')
    expect(button(root, 'Download PDF report')).toBeUndefined()
  })
  it('discards an in-flight report when the note changes', async () => {
    let finish!: (value: ReturnType<typeof complianceFixture>) => void
    vi.mocked(createComplianceReport).mockReturnValue(new Promise(resolve => { finish = resolve }))
    const { root, input } = mount(); await paste(input(), complianceFixture().note.raw)
    const waiting = (button(root, 'Generate report')!.props.onClick as () => Promise<void>)()
    await nextTick(); await paste(input(), '')
    finish(complianceFixture()); await waiting; await nextTick()
    expect(button(root, 'Download PDF report')).toBeUndefined()
    expect(content(root)).not.toContain('Event verified')
  })
  it('imports only a note string from a text backup, leaving unrelated secret material out of the form', async () => {
    const { root, input } = mount()
    const file = descendants(root).find(node => node.tag === 'input' && node.props.type === 'file')!
    const value = `PRIVATE BACKUP\nSEED PHRASE\nsynthetic words here\nNOTES\n${complianceFixture().note.raw}\nMETADATA\nnonce 0`
    await (file.props.onChange as (event: unknown) => Promise<void>)({ target: { files: [{ size: value.length, text: async () => value }], value: '' } })
    await nextTick()
    expect(input().value).toBe(complianceFixture().note.raw)
    expect(content(root)).not.toContain('synthetic words here')
    expect(createComplianceReport).not.toHaveBeenCalled()
  })
})
