import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import ManageSmartAccount from '../src/ManageSmartAccount.vue'
import { loadSmartAccount, recoverSmartAccount, smartAccountBalances } from '../src/core/smart-account'
import { settings } from './fixtures/multi-withdrawal'
import { smartFixture, typedDataWallet } from './fixtures/smart-withdrawal'
import { Element, renderer, content, descendants, button } from './fixtures/vue-renderer'

vi.mock('../src/core/smart-account', async original => ({ ...await original<object>(),
  loadSmartAccount: vi.fn(), recoverSmartAccount: vi.fn(), smartAccountBalances: vi.fn(),
}))
let cleanup: (() => void) | undefined
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('Document', class {}); vi.stubGlobal('ShadowRoot', class {})
})
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals() })
async function mountManagement() {
  const wallet = typedDataWallet(), account = smartFixture(2, 'eth', 'account', true).quote.scope.account
  vi.mocked(loadSmartAccount).mockResolvedValue(account)
  vi.mocked(smartAccountBalances).mockResolvedValue({ deposit: 1n,
    balances: [{ asset: { symbol: 'ETH', token: null, decimals: 18 }, amount: 100n }],
  })
  const app = renderer.createApp(ManageSmartAccount, { active: true, wallet, chainId: 1, walletRevision: 1,
    connectionKey: 'test', getSettings: () => settings })
  const root = new Element('root'); app.mount(root); cleanup = () => app.unmount()
  await vi.waitFor(() => expect(button(root, 'Sweep funds to address')?.props.disabled).toBe(false))
  const field = descendants(root).find(node => node.props.id === 'recovery-recipient')!
  const setRecipient = async (value: string) => { field.value = value; field.events.get('input')!({ target: field }); await nextTick() }
  return { root, wallet, account, field, setRecipient }
}
describe('smart account sweep recipient', () => {
  it('defaults to the controller and sends an edited destination to recovery', async () => {
    const page = await mountManagement(), destination = '0x4444444444444444444444444444444444444444'
    expect(page.field.value).toBe(page.wallet.account)
    await page.setRecipient(destination)
    vi.mocked(recoverSmartAccount).mockImplementation(async (_wallet, _settings, update) => {
      update('recovery', { status: 'confirmed', transactionHash: `0x${'cc'.repeat(32)}` })
    })
    await (button(page.root, 'Sweep funds to address')!.props.onClick as () => Promise<void>)(); await nextTick()
    expect(recoverSmartAccount).toHaveBeenCalledWith(page.wallet, settings, expect.any(Function), destination)
    expect(content(page.root)).toContain('Recovery recipient')
    expect(content(page.root)).toContain(destination)
  })
  it.each(['invalid', '0x0000000000000000000000000000000000000000', 'self'])('disables recovery for recipient %s', async destination => {
    const page = await mountManagement()
    await page.setRecipient(destination === 'self' ? page.account.address : destination)
    expect(button(page.root, 'Sweep funds to address')?.props.disabled).toBe(true)
    await (button(page.root, 'Sweep funds to address')!.props.onClick as () => Promise<void>)()
    expect(recoverSmartAccount).not.toHaveBeenCalled()
  })
})
