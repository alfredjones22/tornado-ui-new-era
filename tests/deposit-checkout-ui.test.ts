import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { parseEther, type Address } from 'viem'
import App from '../src/App.vue'
import { downloadText, generateNote } from '../src/core/notes'
import { executeDepositSession } from '../src/core/deposit-session'
import type { WalletProvider } from '../src/core/wallet'
import { Element, renderer, content, descendants, button } from './fixtures/vue-renderer'

const first: Address = '0x1111111111111111111111111111111111111111', second: Address = '0x2222222222222222222222222222222222222222'
vi.mock('../src/core/rpc', async original => ({ ...await original<object>(), validateConnections: vi.fn(), publicClientFor: () => ({
  getChainId: async () => 1, getBalance: async ({ address }: { address: Address }) => address === first ? 0n : parseEther('2'),
  readContract: async ({ functionName }: { functionName: string }) => functionName === 'balanceOf' ? 0n : 0,
}) }))
vi.mock('../src/core/notes', async original => {
  const notes = await original<typeof import('../src/core/notes')>()
  return { ...notes, downloadText: vi.fn(), generateNote: vi.fn(async (pool: Parameters<typeof notes.generateNote>[0]) =>
    notes.depositNoteFromSecrets(pool, { nullifier: 1n, salt: 2n, commitment: 3n })) }
})
vi.mock('../src/core/deposit-session', async original => ({ ...await original<object>(), executeDepositSession: vi.fn() }))
let cleanup: (() => void) | undefined
const settle = async () => { await vi.advanceTimersByTimeAsync(0); await nextTick() }
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers()
  vi.stubGlobal('Document', class {}); vi.stubGlobal('ShadowRoot', class {})
  vi.stubGlobal('location', new URL('http://localhost:4174/'))
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible', querySelector: vi.fn(() => null) }))
})
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.unstubAllGlobals() })
async function checkout(symbol = 'ETH') {
  let selected = first
  const provider: WalletProvider = { request: vi.fn(async ({ method }) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [selected]
    if (method === 'eth_chainId') return '0x1'
    if (method === 'wallet_getCapabilities') return {}
    throw new Error(`Unexpected wallet request ${method}`)
  }), on: vi.fn(), removeListener: vi.fn() }
  const browser = new EventTarget()
  Object.assign(browser, { ethereum: provider }); vi.stubGlobal('window', browser)
  const app = renderer.createApp(App), root = new Element('root'); app.mount(root); cleanup = () => app.unmount()
  await settle()
  ;(button(root, 'Connect wallet')!.props.onClick as () => void)(); await settle()
  await (button(root, 'Browser wallet')!.props.onClick as () => Promise<void>)(); await settle()
  if (symbol !== 'ETH') {
    ;(descendants(root).find(node => node.props.id === 'token')!.props['onUpdate:modelValue'] as (value: string) => void)(symbol)
    await settle()
  }
  await (button(root, 'Review deposit')!.props.onClick as () => Promise<void>)(); await settle()
  ;(button(root, 'Download withdrawal notes')!.props.onClick as () => void)(); await settle()
  const checkbox = descendants(root).find(node => node.tag === 'input' && node.props.type === 'checkbox')!
  checkbox.checked = true; checkbox.events.get('change')!({ target: checkbox }); await settle()
  return { root, provider, select: (value: Address) => { selected = value }, browser }
}
describe('deposit checkout paying wallet', () => {
  it('starts a clean 0.01 ETH session after confirmed token deposits and requires a new backup', async () => {
    const page = await checkout('DAI')
    vi.mocked(executeDepositSession).mockImplementation(async ({ notes, update }) => {
      notes.forEach(note => update(note.id, { status: 'confirmed', transactionHash: `0x${'aa'.repeat(32)}` }))
    })
    await (button(page.root, 'Confirm deposit')!.props.onClick as () => Promise<void>)(); await settle()
    expect(content(page.root)).toContain('All confirmed')
    await (button(page.root, 'Start a new deposit session?')!.props.onClick as () => Promise<void>)(); await settle()
    expect(content(descendants(page.root).find(node => node.props['aria-label'] === 'Deposit cart')!)).toContain('1 × 0.01 ETH')
    expect(button(page.root, 'Download session & notes')).toBeUndefined()
    expect(button(page.root, 'Open session')).toBeUndefined()
    expect(button(page.root, 'Review deposit')).toBeDefined()
    await (button(page.root, 'Review deposit')!.props.onClick as () => Promise<void>)(); await settle()
    expect(generateNote).toHaveBeenCalledTimes(2)
    expect(vi.mocked(generateNote).mock.lastCall![0]).toMatchObject({ denomination: '0.01', asset: { symbol: 'ETH' } })
    expect(button(page.root, 'Confirm deposit')?.props.disabled).toBe(true)
    expect(button(page.root, 'Download withdrawal notes')).toBeDefined()
  })
  it('keeps pending deposits and their notes instead of offering to reset the session', async () => {
    const page = await checkout()
    vi.mocked(executeDepositSession).mockImplementation(async ({ notes, update }) => {
      update(notes[0]!.id, { status: 'submitted', hash: `0x${'bb'.repeat(32)}`, transactionHash: `0x${'bb'.repeat(32)}` })
    })
    await (button(page.root, 'Confirm deposit')!.props.onClick as () => Promise<void>)(); await settle()
    expect(button(page.root, 'Start a new deposit session?')).toBeUndefined()
    expect(button(page.root, 'Check submitted operations')).toBeDefined()
    expect(button(page.root, 'Download session & notes')).toBeDefined()
  })
  it('keeps the backed-up checkout editable if the paying wallet is on the wrong network', async () => {
    const page = await checkout()
    vi.mocked(page.provider.request).mockImplementation(async ({ method }) => {
      if (method === 'eth_chainId') return '0xaa36a7'
      if (method === 'eth_accounts') return [first]
      if (method === 'wallet_getCapabilities') return {}
      throw new Error(`Unexpected wallet request ${method}`)
    })
    await (button(page.root, 'Confirm deposit')!.props.onClick as () => Promise<void>)(); await settle()
    expect(content(page.root)).toContain('Switch your wallet to the selected network')
    expect(button(page.root, 'Download backup again')).toBeDefined()
    expect(button(page.root, 'Confirm deposit')?.props.disabled).toBe(false)
    expect(descendants(page.root).find(node => node.props['aria-label'] === 'Paying wallet balances')).toBeDefined()
    expect(executeDepositSession).not.toHaveBeenCalled(); expect(generateNote).toHaveBeenCalledOnce()
  })
  it('preserves downloaded notes and acknowledgement when choosing a different paying account', async () => {
    const page = await checkout()
    expect(content(page.root)).toContain('exceeds this wallet’s ETH balance')
    expect(button(page.root, 'Confirm deposit')?.props.disabled).toBe(false)
    const payment = descendants(page.root).find(node => node.props['aria-label'] === 'Paying wallet balances')!
    ;(button(payment, 'Change wallet')!.props.onClick as () => void)(); await settle()
    expect(button(page.root, 'Back to deposit')).toBeDefined()
    page.select(second)
    await (button(page.root, 'Browser wallet')!.props.onClick as () => Promise<void>)(); await settle()
    expect(content(page.root)).toContain('Deposit checkout')
    const newPayment = descendants(page.root).find(node => node.props['aria-label'] === 'Paying wallet balances')!
    expect(content(newPayment)).toContain('0x2222…2222'); expect(content(newPayment)).not.toContain('exceeds')
    expect(button(page.root, 'Confirm deposit')?.props.disabled).toBe(false)
    ;(button(page.root, 'Download backup again')!.props.onClick as () => void)()
    expect(vi.mocked(downloadText).mock.calls[1]![1]).toBe(vi.mocked(downloadText).mock.calls[0]![1])
    expect(generateNote).toHaveBeenCalledOnce(); expect(executeDepositSession).not.toHaveBeenCalled()
    await (button(page.root, 'Confirm deposit')!.props.onClick as () => Promise<void>)()
    expect(executeDepositSession).toHaveBeenCalledWith(expect.objectContaining({ account: second, provider: page.provider,
      notes: [expect.objectContaining({ raw: expect.stringMatching(/^tornado-eth-0\.01-1-/) })] }))
  })
  it('returns from wallet selection or disconnect to the same backed-up checkout', async () => {
    const page = await checkout()
    const change = () => {
      const payment = descendants(page.root).find(node => node.props['aria-label'] === 'Paying wallet balances')!
      ;(button(payment, 'Change wallet')!.props.onClick as () => void)()
    }
    change(); await settle()
    ;(button(page.root, 'Back to deposit')!.props.onClick as () => void)(); await settle()
    expect(button(page.root, 'Confirm deposit')?.props.disabled).toBe(false)
    change(); await settle()
    ;(button(page.root, 'Disconnect this interface')!.props.onClick as () => void)(); await settle()
    expect(content(page.root)).toContain('Deposit checkout')
    expect(button(page.root, 'Download backup again')).toBeDefined()
    expect(button(page.root, 'Confirm deposit')?.props.disabled).toBe(true)
    expect(generateNote).toHaveBeenCalledOnce(); expect(executeDepositSession).not.toHaveBeenCalled()
    expect(vi.mocked(page.provider.request).mock.calls.some(([call]) => /sign|send/i.test(call.method))).toBe(false)
  })
})
