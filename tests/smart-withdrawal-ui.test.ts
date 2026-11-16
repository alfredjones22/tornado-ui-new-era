import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, markRaw, nextTick, ref } from 'vue'
import MultiWithdrawal from '../src/MultiWithdrawal.vue'
import { loadSmartAccount, UnsupportedControllerError } from '../src/core/smart-account'
import { prepareSmartWithdrawal, submitSmartWithdrawal } from '../src/core/smart-withdrawal'
import { settings } from './fixtures/multi-withdrawal'
import { smartFixture, typedDataWallet } from './fixtures/smart-withdrawal'
import { loadAddressPrivacy } from '../src/core/address-privacy'
import { simulateSmartWithdrawal } from '../src/core/withdrawal-simulation'
import { actionFixture } from './fixtures/smart-actions'
import { loadActionBalances } from '../src/core/action-budget'
import { downloadText } from '../src/core/notes'
import { formatEther, hashTypedData } from 'viem'
import { batchTypedData } from '../src/core/batch-policy'

vi.mock('../src/core/smart-account', async original => ({ ...await original<object>(), loadSmartAccount: vi.fn() }))
vi.mock('../src/core/smart-withdrawal', () => ({ prepareSmartWithdrawal: vi.fn(), submitSmartWithdrawal: vi.fn(), reconcileSmartWithdrawal: vi.fn() }))
vi.mock('../src/core/action-budget', async original => ({ ...await original<object>(), loadActionBalances: vi.fn() }))
vi.mock('../src/core/address-privacy', async original => ({ ...await original<object>(), loadAddressPrivacy: vi.fn() }))
vi.mock('../src/core/withdrawal-simulation', async original => ({ ...await original<object>(), simulateSmartWithdrawal: vi.fn() }))
vi.mock('../src/core/notes', async original => ({ ...await original<object>(), downloadText: vi.fn() }))

import { Element, renderer, content, descendants, button } from './fixtures/vue-renderer'

const unmount: (() => void)[] = []
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(loadActionBalances).mockResolvedValue({ eth: 0n, asset: 0n })
  vi.stubGlobal('Document', class {})
  vi.stubGlobal('ShadowRoot', class {})
  vi.mocked(loadAddressPrivacy).mockImplementation(async addresses => new Map(addresses.map(address => [address.toLowerCase(), { balance: 0n, nonce: 0, code: 'empty' as const, tokenBalances: [] }])))
})
afterEach(() => { unmount.splice(0).forEach(fn => fn()); vi.useRealTimers(); vi.unstubAllGlobals() })

async function mountWithdrawal(deployed = false, initiallyConnected = true, initialNotes = true) {
  const { quote } = smartFixture(2, 'eth', 'account', deployed), wallet = typedDataWallet()
  vi.mocked(loadSmartAccount).mockResolvedValue(quote.scope.account)
  const activity = ref(false), updates = ref(0), revision = ref(1), connection = ref('original-settings')
  const provider = ref(markRaw(wallet.provider)), owner = ref(wallet.account)
  const active = ref(true), connected = ref(initiallyConnected), rejected = vi.fn()
  const app = renderer.createApp(defineComponent({ setup: () => () => {
    // Reproduce App.vue: activity or any other parent update creates a new wallet wrapper.
    void activity.value; void updates.value
    return h(MultiWithdrawal, { active: active.value, wallet: connected.value ? { provider: provider.value, account: owner.value } : null, chainId: 1,
      walletRevision: revision.value, connectionKey: connection.value, getSettings: () => settings,
      onActivity: (busy: boolean) => { activity.value = busy }, onRejectController: rejected })
  } }))
  const root = new Element('root'); app.mount(root); unmount.push(() => app.unmount())
  if (initiallyConnected) await vi.waitFor(() => expect(content(root)).toContain('Your smart account'))
  else await nextTick()
  const input = descendants(root).find(child => child.tag === 'textarea')!
  if (initialNotes) { input.value = quote.notes.map(note => note.raw).join('\n'); input.events.get('input')!({ target: input }) }
  await nextTick()
  if (initiallyConnected && initialNotes) await vi.waitFor(() => expect(button(root, 'Review & sign withdrawal')?.props.disabled).toBe(false))
  return { root, quote, updates, revision, connection, provider, owner, active, rejected, connected,
    start: () => ((button(root, 'Review & sign withdrawal') ?? button(root, 'Review & simulate withdrawal'))!.props.onClick as () => Promise<void>)() }
}
async function recheckSimulation(root: Element) {
  ;(button(root, 'Simulate again')!.props.onClick as () => void)()
  await nextTick()
  // The button now lives in the final-review component. Its emitted event
  // intentionally does not return the parent's asynchronous RPC promise.
  await vi.waitFor(() => expect(button(root, 'Simulate again')?.props.disabled).toBe(false))
}

describe('smart withdrawal page signing lifecycle', () => {
  it('offers an optional final simulation without custom calls and rechecks the same signed operation without submitting', async () => {
    const page = await mountWithdrawal()
    vi.mocked(prepareSmartWithdrawal).mockResolvedValue(page.quote)
    await page.start(); await nextTick()
    const simulate = button(page.root, 'Simulate withdrawal')!
    expect(simulate).toBeDefined()
    expect(content(page.root)).toContain('Simulate before submitting')
    expect(content(page.root)).toContain('No Tenderly or shared dashboard is used')
    expect(simulateSmartWithdrawal).not.toHaveBeenCalled()
    const nodes = descendants(page.root)
    expect(nodes.indexOf(simulate)).toBeLessThan(nodes.indexOf(button(page.root, 'Submit signed withdrawal')!))
    let finish!: (result: Awaited<ReturnType<typeof simulateSmartWithdrawal>>) => void
    vi.mocked(simulateSmartWithdrawal).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const waiting = (simulate.props.onClick as () => Promise<void>)(); await nextTick()
    expect(content(page.root)).toContain('Simulating complete withdrawal')
    expect(button(page.root, 'Simulating…')!.props.disabled).toBe(true)
    expect(button(page.root, 'Submit signed withdrawal')!.props.disabled).toBe(true)
    expect(submitSmartWithdrawal).not.toHaveBeenCalled()
    finish({ status: 'passed', hash: page.quote.signedHash, checkedAt: Date.now(), block: 100n, gasUsed: 120000n, message: 'Entire operation passed' })
    await waiting; await vi.waitFor(() => expect(button(page.root, 'Submit signed withdrawal')!.props.disabled).toBe(false))
    expect(content(page.root)).toContain('Full simulation passed')
    expect(simulateSmartWithdrawal).toHaveBeenLastCalledWith(expect.objectContaining({ signedHash: page.quote.signedHash }), settings, '')
    expect(button(page.root, 'Submit signed withdrawal')!.props.disabled).toBe(false)
    expect(prepareSmartWithdrawal).toHaveBeenCalledOnce()
    expect(submitSmartWithdrawal).not.toHaveBeenCalled()
  })
  it.each(['failed', 'unavailable', 'throw'] as const)('handles an optional %s result without hiding failures or broadcasting', async result => {
    const page = await mountWithdrawal()
    vi.mocked(prepareSmartWithdrawal).mockResolvedValue(page.quote)
    await page.start(); await nextTick()
    if (result === 'throw') vi.mocked(simulateSmartWithdrawal).mockRejectedValueOnce(new Error('Unable to validate this operation'))
    else vi.mocked(simulateSmartWithdrawal).mockResolvedValueOnce({ status: result, hash: page.quote.signedHash, checkedAt: Date.now(), message: result,
      ...(result === 'unavailable' ? { availabilityReason: 'unsupported' as const } : {}) })
    ;(button(page.root, 'Simulate withdrawal')!.props.onClick as () => void)()
    await nextTick()
    await vi.waitFor(() => expect(button(page.root, 'Simulate again')?.props.disabled).toBe(false))
    expect(button(page.root, 'Submit signed withdrawal')!.props.disabled).toBe(result !== 'unavailable')
    expect(submitSmartWithdrawal).not.toHaveBeenCalled()
    if (result !== 'unavailable') {
      expect(content(page.root)).toContain('Simulation failed')
      vi.mocked(simulateSmartWithdrawal).mockResolvedValueOnce({ status: 'unavailable', hash: page.quote.signedHash, checkedAt: Date.now(), message: 'RPC offline', availabilityReason: 'transport' })
      await recheckSimulation(page.root)
      expect(button(page.root, 'Submit signed withdrawal')!.props.disabled).toBe(true)
      // Recreating the exact signed hash must retain its failed check, too.
      ;(button(page.root, 'Recalculate fee & gas')!.props.onClick as () => void)()
      await vi.waitFor(() => expect(prepareSmartWithdrawal).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(button(page.root, 'Simulate again')?.props.disabled).toBe(false))
      expect(button(page.root, 'Submit signed withdrawal')!.props.disabled).toBe(true)
    }
  })
  it('discards a final simulation if the connection changes while the RPC is responding', async () => {
    const page = await mountWithdrawal()
    vi.mocked(prepareSmartWithdrawal).mockResolvedValue(page.quote)
    await page.start(); await nextTick()
    let finish!: (result: Awaited<ReturnType<typeof simulateSmartWithdrawal>>) => void
    vi.mocked(simulateSmartWithdrawal).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const waiting = (button(page.root, 'Simulate withdrawal')!.props.onClick as () => Promise<void>)()
    page.connection.value = 'changed-settings'; await nextTick()
    finish({ status: 'passed', hash: page.quote.signedHash, checkedAt: Date.now(), message: 'Stale operation passed' })
    await waiting; await nextTick()
    expect(content(page.root)).not.toContain('Full simulation passed')
    expect(button(page.root, 'Submit signed withdrawal')).toBeUndefined()
    expect(submitSmartWithdrawal).not.toHaveBeenCalled()
  })
  it('expires the final review visibly without allowing a recheck to extend its quote', async () => {
    const page = await mountWithdrawal()
    vi.useFakeTimers()
    vi.mocked(prepareSmartWithdrawal).mockResolvedValue(page.quote)
    await page.start(); await vi.advanceTimersByTimeAsync(251); await nextTick()
    expect(button(page.root, 'Submit signed withdrawal')!.props.disabled).toBe(false)
    await vi.advanceTimersByTimeAsync(5 * 60_000); await nextTick()
    expect(content(page.root)).toContain('Review expired')
    expect(button(page.root, 'Simulate withdrawal')!.props.disabled).toBe(true)
    expect(button(page.root, 'Submit signed withdrawal')!.props.disabled).toBe(true)
    expect(button(page.root, 'Recalculate fee & gas')).toBeDefined()
    expect(prepareSmartWithdrawal).toHaveBeenCalledOnce()
  })
  it.each([false, true].flatMap(deployed => (['account', 'wallet', 'custom'] as const).map(payout => ({ deployed, payout }))))(
    'explains direct one-note $payout custody and refunds (deployed=$deployed)', async ({ deployed, payout }) => {
      const page = await mountWithdrawal(deployed)
      const destination = payout === 'wallet' ? page.owner.value : '0x4444444444444444444444444444444444444444'
      const { quote } = smartFixture(1, 'eth', payout === 'account' ? 'account' : 'custom', deployed, destination)
      const notes = descendants(page.root).find(node => node.props.id === 'multi-notes')!
      notes.value = quote.notes[0]!.raw; notes.events.get('input')!({ target: notes })
      if (payout !== 'account') {
        const forward = descendants(page.root).find(node => node.props.type === 'radio' && node.value === 'custom')!
        forward.events.get('change')!({ target: forward }); await nextTick()
        const recipient = descendants(page.root).find(node => node.props.id === 'multi-recipient')!
        expect(recipient.value).toBe(page.owner.value)
        if (payout === 'custom') { recipient.value = destination; recipient.events.get('input')!({ target: recipient }) }
      }
      await nextTick()
      expect(content(page.root)).toContain('This note and any gas refund go directly to that address.')
      expect(content(page.root)).not.toContain('A small gas refund may still land')
      expect(!!button(page.root, 'Add contract calls')).toBe(payout === 'account')
      vi.mocked(prepareSmartWithdrawal).mockResolvedValue(quote)
      await page.start()
      expect(content(page.root)).toContain('This note and any unused-gas refund go directly to the withdrawal recipient.')
      expect(content(page.root)).toContain(payout === 'account' ? 'Kept in smart account' : 'Paid directly to recipient')
      expect(simulateSmartWithdrawal).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(button(page.root, 'Submit signed withdrawal')?.props.disabled).toBe(false))
    })
  it.each([[false, false], [false, true], [true, false], [true, true]])('gates the contract-call entry point (wallet=%s, notes=%s)', async (wallet, notes) => {
    const page = await mountWithdrawal(false, wallet, notes)
    expect(!!button(page.root, 'Add contract calls')).toBe(wallet && notes)
    expect(prepareSmartWithdrawal).not.toHaveBeenCalled()
    expect(simulateSmartWithdrawal).not.toHaveBeenCalled()
  })

  it.each(['notes', 'invalid-notes', 'wallet', 'network', 'disconnect'])('resets saved calls and review on %s changes, but ignores note formatting', async change => {
    const page = await mountWithdrawal()
    ;(button(page.root, 'Add contract calls')!.props.onClick as () => void)(); await nextTick()
    const toggle = descendants(page.root).find(node => node.tag === 'input' && node.props.type === 'checkbox')!
    toggle.checked = true; toggle.events.get('change')!({ target: toggle }); await nextTick()
    const field = descendants(page.root).find(node => node.props.id === 'action-target')!
    field.value = '0x4444444444444444444444444444444444444444'; field.events.get('input')!({ target: field })
    await nextTick(); (button(page.root, 'Add action')!.props.onClick as () => void)(); await nextTick()
    ;(button(page.root, 'Save actions & return')!.props.onClick as () => void)(); await nextTick()
    expect(button(page.root, 'Edit actions')).toBeDefined()
    const notes = descendants(page.root).find(node => node.props.id === 'multi-notes')!
    notes.value = `\n ${page.quote.notes[1]!.raw} \r\n\n ${page.quote.notes[0]!.raw} \n`; notes.events.get('input')!({ target: notes }); await nextTick()
    expect(button(page.root, 'Edit actions')).toBeDefined()
    if (change === 'notes' || change === 'invalid-notes') {
      notes.value = change === 'notes' ? page.quote.notes[0]!.raw : 'invalid note'; notes.events.get('input')!({ target: notes })
    }
    if (change === 'wallet') page.owner.value = '0x5555555555555555555555555555555555555555'
    if (change === 'network') page.connection.value = 'different-network-settings'
    if (change === 'disconnect') page.connected.value = false
    await nextTick(); await nextTick()
    expect(button(page.root, 'Edit actions')).toBeUndefined()
    expect(button(page.root, 'Submit signed withdrawal')).toBeUndefined()
    expect(content(page.root)).toContain('Contract calls were cleared')
  })

  it('closes and clears an unsaved builder when its wallet context changes', async () => {
    const page = await mountWithdrawal()
    ;(button(page.root, 'Add contract calls')!.props.onClick as () => void)(); await nextTick()
    expect(content(page.root)).toContain('Transaction builder')
    page.connected.value = false; await nextTick()
    expect(content(page.root)).not.toContain('Transaction builder')
    expect(button(page.root, 'Add contract calls')).toBeUndefined()
    expect(content(page.root)).toContain('Contract calls were cleared')
  })

  it('keeps note drafts across the builder and clears calls when changing to forwarding', async () => {
    const page = await mountWithdrawal()
    expect(content(page.root)).toContain('1–12 notes')
    expect(content(page.root)).toContain('Keep in smart account (Recommended)')
    await (button(page.root, 'Add contract calls')!.props.onClick as () => void)(); await nextTick()
    expect(content(page.root)).toContain('Transaction builder')
    // Raw data does not require an ABI.
    const toggle = descendants(page.root).find(node => node.tag === 'input' && node.props.type === 'checkbox')!
    toggle.checked = true; toggle.events.get('change')!({ target: toggle }); await nextTick()
    for (const [id, value] of [['action-target', '0x4444444444444444444444444444444444444444'], ['action-value', '0.001'], ['action-data', '0x']]) {
      const field = descendants(page.root).find(node => node.props.id === id)!
      field.value = value!; field.events.get('input')!({ target: field })
    }
    await nextTick(); (button(page.root, 'Add action')!.props.onClick as () => void)(); await nextTick()
    expect(content(page.root)).toContain('1 / 12 actions')
    await (button(page.root, 'Save actions & return')!.props.onClick as () => void)(); await nextTick()
    expect(content(page.root)).not.toContain('Transaction builder')
    expect(content(page.root)).toContain('1 custom action · Draft')
    expect(descendants(page.root).find(node => node.props.id === 'multi-notes')!.value).toBe(page.quote.notes.map(note => note.raw).join('\n'))
    const forward = descendants(page.root).find(node => node.props.type === 'radio' && node.value === 'custom')!
    expect(forward.props.disabled).toBe(false)
    forward.events.get('change')!({ target: forward }); await nextTick()
    expect(button(page.root, 'Edit actions')).toBeUndefined()
    expect(button(page.root, 'Add contract calls')).toBeUndefined()
    expect(content(page.root)).toContain('Contract calls were cleared')
  })

  it.each(['passed', 'failed', 'unavailable'] as const)('renders %s simulation honestly and blocks known execution failures', async result => {
    const page = await mountWithdrawal(), { quote, actions } = actionFixture()
    // Import via the actual builder component's save event; the backend quote
    // has the same immutable action suffix used by the real preparation path.
    ;(button(page.root, 'Add contract calls')!.props.onClick as () => void)(); await nextTick()
    const builder = descendants(page.root).find(node => node.props['aria-label'] === 'Transaction builder')!
    expect(builder).toBeDefined()
    // Use public raw editor controls to create the two calls.
    const toggle = descendants(page.root).find(node => node.tag === 'input' && node.props.type === 'checkbox')!
    toggle.checked = true; toggle.events.get('change')!({ target: toggle }); await nextTick()
    for (const call of actions) {
      for (const [id, value] of [['action-target', call.to], ['action-value', call.value === 10n ? '0.00000000000000001' : '0'], ['action-data', call.data]]) {
        const field = descendants(page.root).find(node => node.props.id === id)!
        field.value = value!; field.events.get('input')!({ target: field })
      }
      await nextTick(); (button(page.root, 'Add action')!.props.onClick as () => void)(); await nextTick()
    }
    vi.mocked(prepareSmartWithdrawal).mockResolvedValue(quote)
    vi.mocked(simulateSmartWithdrawal).mockResolvedValue({ status: result, hash: quote.signedHash, checkedAt: Date.now(), message: `Preview ${result}`, ...(result === 'unavailable' ? { availabilityReason: 'unsupported' as const } : {}) })
    await (button(page.root, 'Review & simulate withdrawal')!.props.onClick as () => Promise<void>)(); await nextTick()
    await vi.waitFor(() => expect(button(page.root, 'Submit signed withdrawal')).toBeDefined())
    expect(prepareSmartWithdrawal).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.objectContaining({ calls: actions, callsHash: quote.scope.callsHash }), expect.anything(), expect.any(Function), expect.any(Function), expect.any(AbortSignal))
    expect(button(page.root, 'Submit signed withdrawal')!.props.disabled).toBe(result === 'failed')
    expect(content(page.root)).toContain(result === 'passed' ? 'Full simulation passed' : result === 'failed' ? 'Simulation failed' : 'Detailed preview unavailable')
    expect(submitSmartWithdrawal).not.toHaveBeenCalled()
    if (result === 'failed') {
      vi.mocked(simulateSmartWithdrawal).mockResolvedValue({ status: 'unavailable', availabilityReason: 'transport', hash: quote.signedHash, checkedAt: Date.now(), message: 'RPC unavailable' })
      await recheckSimulation(page.root)
      expect(button(page.root, 'Submit signed withdrawal')!.props.disabled).toBe(true)
      expect(content(page.root)).toContain('Preview failed')
      vi.mocked(simulateSmartWithdrawal).mockResolvedValue({ status: 'passed', hash: quote.signedHash, checkedAt: Date.now(), message: 'Preview passed after fixing funding' })
      await recheckSimulation(page.root)
      expect(button(page.root, 'Submit signed withdrawal')!.props.disabled).toBe(false)
    }
    ;(button(page.root, 'Edit actions')!.props.onClick as () => void)(); await nextTick()
    ;(button(page.root, 'Save actions & return')!.props.onClick as () => void)(); await nextTick()
    expect(button(page.root, 'Submit signed withdrawal')).toBeUndefined()
    expect(content(page.root)).toContain('Draft')
  })

  it('warns about supported-token balances on the smart account and controller even with no native activity', async () => {
    vi.mocked(loadAddressPrivacy).mockImplementation(async addresses => new Map(addresses.map(address => [address.toLowerCase(), {
      balance: 0n, nonce: 0, code: 'empty' as const, tokenBalances: [{ symbol: 'USDC', balance: 1n }],
    }])))
    const page = await mountWithdrawal()
    const warnings = descendants(page.root).filter(node => node.props.class === 'privacy-warning')
    expect(warnings).toHaveLength(2)
    expect(warnings.every(warning => content(warning).includes('it has a USDC balance'))).toBe(true)
    expect(button(page.root, 'Review & sign withdrawal')?.props.disabled).toBe(false)
  })
  it('shows independent privacy warnings above the action and still permits reused addresses', async () => {
    vi.mocked(loadAddressPrivacy).mockImplementation(async addresses => new Map(addresses.map(address => [address.toLowerCase(), { balance: 1n, nonce: 1, code: 'empty' as const, tokenBalances: [] }])))
    const page = await mountWithdrawal(true)
    const warnings = () => descendants(page.root).filter(node => node.props.class === 'privacy-warning')
    expect(warnings()).toHaveLength(2)
    expect(content(warnings()[0]!)).toContain('Smart account (UserOperation sender)')
    expect(content(warnings()[0]!)).toContain('already deployed')
    expect(content(warnings()[1]!)).toContain('Controller EOA (wallet signer)')
    const forward = descendants(page.root).find(node => node.props.type === 'radio' && node.value === 'custom')!
    forward.events.get('change')!({ target: forward }); await nextTick()
    await vi.waitFor(() => expect(button(page.root, 'Review & sign withdrawal')?.props.disabled).toBe(false))
    expect(warnings()).toHaveLength(2)
    expect(content(warnings()[1]!)).toContain('Controller EOA and withdrawal recipient')
    const field = descendants(page.root).find(node => node.props.id === 'multi-recipient')!
    field.value = '0x4444444444444444444444444444444444444444'; field.events.get('input')!({ target: field }); await nextTick()
    await vi.waitFor(() => expect(button(page.root, 'Review & sign withdrawal')?.props.disabled).toBe(false))
    expect(warnings()).toHaveLength(3)
    expect(content(warnings()[2]!)).toContain('Withdrawal recipient')
    expect(content(warnings()[2]!)).toContain('ETH balance')
    const nodes = descendants(page.root)
    expect(nodes.indexOf(warnings()[2]!)).toBeLessThan(nodes.indexOf(button(page.root, 'Review & sign withdrawal')!))
  })

  it('does not claim freshness when RPC checks fail, but permits an informed continuation', async () => {
    vi.mocked(loadAddressPrivacy).mockRejectedValue(new Error('private RPC response'))
    const page = await mountWithdrawal()
    expect(content(page.root)).toContain('Freshness could not be fully checked')
    expect(content(page.root)).not.toContain('private RPC response')
    expect(button(page.root, 'Review & sign withdrawal')?.props.disabled).toBe(false)
  })

  it('ignores a late privacy result after the recipient changes', async () => {
    const page = await mountWithdrawal()
    const forward = descendants(page.root).find(node => node.props.type === 'radio' && node.value === 'custom')!
    forward.events.get('change')!({ target: forward }); await nextTick()
    await vi.waitFor(() => expect(button(page.root, 'Review & sign withdrawal')?.props.disabled).toBe(false))
    const field = descendants(page.root).find(node => node.props.id === 'multi-recipient')!
    const old = '0x4444444444444444444444444444444444444444', next = '0x5555555555555555555555555555555555555555'
    let finish!: (states: Awaited<ReturnType<typeof loadAddressPrivacy>>) => void
    vi.mocked(loadAddressPrivacy).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    field.value = old; field.events.get('input')!({ target: field }); await nextTick()
    await vi.waitFor(() => expect(loadAddressPrivacy).toHaveBeenLastCalledWith(expect.arrayContaining([old]), settings))
    field.value = next; field.events.get('input')!({ target: field }); await nextTick()
    await vi.waitFor(() => expect(button(page.root, 'Review & sign withdrawal')?.props.disabled).toBe(false))
    finish(new Map([[old, { balance: 1n, nonce: 1, code: 'delegation', tokenBalances: [] }]])); await nextTick()
    expect(descendants(page.root).filter(node => node.props.class === 'privacy-warning')).toHaveLength(0)
  })

  it('rejects a contract-wallet controller before allowing preparation', async () => {
    const page = await mountWithdrawal()
    vi.mocked(loadSmartAccount).mockRejectedValueOnce(new UnsupportedControllerError())
    page.revision.value++; await nextTick()
    await vi.waitFor(() => expect(page.rejected).toHaveBeenCalledOnce())
    expect(page.rejected).toHaveBeenCalledWith({ provider: page.provider.value, account: page.owner.value })
    expect(content(page.root)).toContain('Select an EOA controller')
    expect(button(page.root, 'Review & sign withdrawal')?.props.disabled).toBe(true)
    expect(prepareSmartWithdrawal).not.toHaveBeenCalled()
  })

  it('reopens the note form after a confirmed withdrawal', async () => {
    const page = await mountWithdrawal()
    vi.mocked(prepareSmartWithdrawal).mockResolvedValue(page.quote)
    vi.mocked(submitSmartWithdrawal).mockImplementation(async (quote, _settings, _wallet, update) => {
      update(quote.id, { status: 'confirmed', transactionHash: `0x${'aa'.repeat(32)}` })
    })
    await page.start(); await nextTick()
    await (button(page.root, 'Submit signed withdrawal')!.props.onClick as () => Promise<void>)(); await nextTick()
    expect(descendants(page.root).find(node => node.tag === 'textarea')).toBeUndefined()
    await (button(page.root, 'Start new withdrawal')!.props.onClick as () => Promise<void>)(); await nextTick()
    const field = descendants(page.root).find(node => node.tag === 'textarea')!
    expect(field.value).toBe('')
    expect(field.focused).toBe(true)
    expect(button(page.root, 'Review & sign withdrawal')).toBeDefined()
    expect(button(page.root, 'Submit signed withdrawal')).toBeUndefined()
    expect(button(page.root, 'Download session & notes')).toBeUndefined()
    // Preparing the next batch rereads the deployed account's current nonce.
    const next = smartFixture(2, 'eth', 'account', true).quote
    vi.mocked(loadSmartAccount).mockResolvedValue(next.scope.account)
    vi.mocked(prepareSmartWithdrawal).mockResolvedValue(next)
    field.value = next.notes.map(note => note.raw).join('\n'); field.events.get('input')!({ target: field }); await nextTick()
    await page.start(); await nextTick()
    expect(vi.mocked(prepareSmartWithdrawal).mock.calls[1]![2].account).toEqual(next.scope.account)
    await vi.waitFor(() => expect(button(page.root, 'Submit signed withdrawal')?.props.disabled).toBe(false))
  })

  it.each(['unknown', 'submitted'] as const)('keeps %s submissions from being discarded or rebuilt', async status => {
    const page = await mountWithdrawal()
    vi.mocked(prepareSmartWithdrawal).mockResolvedValue(page.quote)
    vi.mocked(submitSmartWithdrawal).mockImplementation(async (quote, _settings, _wallet, update) => {
      update(quote.id, { status, hash: quote.signedHash })
      throw new Error('Submission response unavailable.')
    })
    await page.start(); await nextTick()
    await (button(page.root, 'Submit signed withdrawal')!.props.onClick as () => Promise<void>)(); await nextTick()
    expect(button(page.root, 'Start new withdrawal')).toBeUndefined()
    expect(button(page.root, 'Back to review')).toBeUndefined()
    expect(button(page.root, 'Check submitted operation')).toBeDefined()
    expect(button(page.root, 'Download session & notes')).toBeDefined()
    const link = descendants(page.root).find(node => node.tag === 'a' && content(node).includes('UserOperation'))!
    expect(link.props.href).toBe(`${settings.chainId === 1 ? 'https://etherscan.io' : 'https://sepolia.etherscan.io'}/tx/${page.quote.signedHash}`)
    expect(content(page.root)).toContain('(awaiting on-chain confirmation)')
  })
  it.each([{ context: 'unchanged', count: 1 }, { context: 'unchanged', count: 2 }, { context: 'network', count: 1 }])('restores $count notes and preserves calls only with the $context context', async ({ context, count }) => {
    const page = await mountWithdrawal(), { quote, actions } = actionFixture(count)
    const field = descendants(page.root).find(node => node.props.id === 'multi-notes')!
    field.value = quote.notes.map(note => note.raw).join('\n'); field.events.get('input')!({ target: field }); await nextTick()
    ;(button(page.root, 'Add contract calls')!.props.onClick as () => void)(); await nextTick()
    const toggle = descendants(page.root).find(node => node.tag === 'input' && node.props.type === 'checkbox')!
    toggle.checked = true; toggle.events.get('change')!({ target: toggle }); await nextTick()
    for (const call of actions) {
      for (const [id, value] of [['action-target', call.to], ['action-value', formatEther(call.value)], ['action-data', call.data]]) {
        const field = descendants(page.root).find(node => node.props.id === id)!
        field.value = value!; field.events.get('input')!({ target: field })
      }
      await nextTick(); (button(page.root, 'Add action')!.props.onClick as () => void)(); await nextTick()
    }
    ;(button(page.root, 'Save actions & return')!.props.onClick as () => void)(); await nextTick()
    vi.mocked(prepareSmartWithdrawal).mockResolvedValueOnce(quote)
    vi.mocked(simulateSmartWithdrawal).mockImplementation(async q => ({ status: 'passed', hash: q.signedHash, checkedAt: Date.now(), message: 'Passed' }))
    vi.mocked(submitSmartWithdrawal).mockImplementation(async (q, _settings, _wallet, update) => {
      update(q.id, { status: 'rejected', hash: q.signedHash }); throw new Error('The bundler rejected the minimum fee.')
    })
    await page.start(); await nextTick()
    const previousScope = vi.mocked(prepareSmartWithdrawal).mock.calls[0]![2]
    await (button(page.root, 'Submit signed withdrawal')!.props.onClick as () => Promise<void>)(); await nextTick()
    expect(button(page.root, 'Back to review')).toBeDefined()
    expect(button(page.root, 'Check submitted operation')).toBeUndefined()
    if (context === 'network') { page.connection.value = 'changed-rpc'; await nextTick() }
    await (button(page.root, 'Back to review')!.props.onClick as () => Promise<void>)(); await nextTick()
    expect(descendants(page.root).find(node => node.props.id === 'multi-notes')!.value).toBe(quote.notes.map(note => note.raw).join('\n'))
    expect(prepareSmartWithdrawal).toHaveBeenCalledOnce() // Back does not sign or prepare automatically.
    expect(button(page.root, 'Submit signed withdrawal')).toBeUndefined()
    if (context === 'network') {
      expect(button(page.root, 'Edit actions')).toBeUndefined()
      expect(content(page.root)).toContain('Contract calls were cleared')
      return
    }
    expect(button(page.root, 'Edit actions')).toBeDefined()
    expect(content(page.root)).toContain('Draft')
    ;(button(page.root, 'Download session & notes')!.props.onClick as () => void)()
    const saved = JSON.parse(vi.mocked(downloadText).mock.calls.at(-1)![1])
    expect(saved.notes).toEqual(quote.notes.map(note => note.raw))
    expect(saved.calls).toEqual(actions.map(({ to, value, data }) => ({ to, value: value.toString(), data })))
    expect(saved.previousAttempts[0]).toMatchObject({ chainId: 1, userOperationHash: quote.signedHash, progress: [{ status: 'rejected' }] })
    const next = actionFixture(count).quote
    next.withdrawal.userOperation.maxFeePerGas = '0x2'; next.signedHash = hashTypedData(batchTypedData(next.withdrawal, settings))
    vi.mocked(prepareSmartWithdrawal).mockResolvedValueOnce(next)
    await vi.waitFor(() => expect(button(page.root, 'Review & simulate withdrawal')?.props.disabled).toBe(false))
    await page.start(); await nextTick()
    const retry = vi.mocked(prepareSmartWithdrawal).mock.calls[1]!
    expect(retry[0]).toBe(quote.notes.map(note => note.raw).join('\n'))
    expect(retry[2]).toEqual(previousScope)
    expect(simulateSmartWithdrawal).toHaveBeenCalledTimes(2)
    expect(vi.mocked(simulateSmartWithdrawal).mock.calls[1]![0].signedHash).not.toBe(quote.signedHash)
    expect(submitSmartWithdrawal).toHaveBeenCalledOnce() // New review still needs a separate Submit.
  })
  it('keeps a custom recipient when returning from a rejected direct withdrawal', async () => {
    const page = await mountWithdrawal(), destination = '0x4444444444444444444444444444444444444444'
    const { quote } = smartFixture(1, 'eth', 'custom', false, destination)
    const notes = descendants(page.root).find(node => node.props.id === 'multi-notes')!
    notes.value = quote.notes[0]!.raw; notes.events.get('input')!({ target: notes })
    const forward = descendants(page.root).find(node => node.props.type === 'radio' && node.value === 'custom')!
    forward.events.get('change')!({ target: forward }); await nextTick()
    const recipient = descendants(page.root).find(node => node.props.id === 'multi-recipient')!
    recipient.value = destination; recipient.events.get('input')!({ target: recipient }); await nextTick()
    vi.mocked(prepareSmartWithdrawal).mockResolvedValue(quote)
    vi.mocked(submitSmartWithdrawal).mockImplementation(async (q, _settings, _wallet, update) => { update(q.id, { status: 'rejected' }) })
    await page.start(); await nextTick()
    await (button(page.root, 'Submit signed withdrawal')!.props.onClick as () => Promise<void>)(); await nextTick()
    await (button(page.root, 'Back to review')!.props.onClick as () => Promise<void>)(); await nextTick()
    expect(descendants(page.root).find(node => node.props.id === 'multi-recipient')!.value).toBe(destination)
    expect(descendants(page.root).find(node => node.props.id === 'multi-notes')!.value).toBe(quote.notes[0]!.raw)
    expect(prepareSmartWithdrawal).toHaveBeenCalledOnce()
  })
  it.each(['ready', 'failed', 'confirmed'] as const)('offers draft return only before any send or for a known fee rejection, not %s execution results', async status => {
    const page = await mountWithdrawal()
    vi.mocked(prepareSmartWithdrawal).mockResolvedValue(page.quote)
    vi.mocked(submitSmartWithdrawal).mockImplementation(async (q, _settings, _wallet, update) => {
      update(q.id, { status, ...(status === 'ready' ? {} : { transactionHash: `0x${'aa'.repeat(32)}` as const }) })
      if (status === 'ready') throw new Error('Quote expired before submission.')
    })
    await page.start(); await nextTick()
    await (button(page.root, 'Submit signed withdrawal')!.props.onClick as () => Promise<void>)(); await nextTick()
    expect(!!button(page.root, 'Back to review')).toBe(status === 'ready')
  })

  it('imports only note strings from a backup and reports a seed-only file without replacing existing notes', async () => {
    const page = await mountWithdrawal()
    const fileInput = descendants(page.root).find(node => node.props.type === 'file')!
    const notes = page.quote.notes.map(note => note.raw).join('\n')
    const backup = `SEED PHRASE\npublic fixture words\nNOTES\n${notes}\nMETADATA\nnonces 0, 1`
    const importing = fileInput.props.onChange as (event: unknown) => Promise<void>
    await importing({ target: { files: [{ size: backup.length, text: async () => backup }] } }); await nextTick()
    expect(descendants(page.root).find(node => node.tag === 'textarea')?.value).toBe(notes)
    expect(content(page.root)).not.toContain('public fixture words')
    expect(fileInput.value).toBe('')
    await importing({ target: { files: [{ size: 20, text: async () => 'SEED PHRASE\npublic fixture words' }] } }); await nextTick()
    expect(content(page.root)).toContain('No Tornado note strings were found')
    expect(descendants(page.root).find(node => node.tag === 'textarea')?.value).toBe(notes)
  })

  it('offers exactly two payout choices and defaults to retaining funds in the smart account', async () => {
    const page = await mountWithdrawal()
    const choices = descendants(page.root).filter(node => node.props.type === 'radio')
    expect(choices.map(node => [node.value, node.checked])).toEqual([['account', true], ['custom', false]])
    expect(content(page.root)).toContain('Keep in smart account')
    expect(content(page.root)).toContain('Forward withdrawal to address')
    expect(descendants(page.root).find(node => node.props.id === 'multi-recipient')).toBeUndefined()
    vi.mocked(prepareSmartWithdrawal).mockResolvedValue(page.quote)
    await page.start()
    expect(prepareSmartWithdrawal).toHaveBeenCalledWith(expect.any(String), expect.any(Object),
      { account: page.quote.scope.account, payout: 'account' }, settings, expect.any(Function), expect.any(Function), expect.any(AbortSignal))
  })

  it('prefills forwarding with the controller, follows its changes, and preserves an edited recipient', async () => {
    const page = await mountWithdrawal()
    const forward = descendants(page.root).find(node => node.props.type === 'radio' && node.value === 'custom')!
    forward.events.get('change')!({ target: forward }); await nextTick()
    const field = () => descendants(page.root).find(node => node.props.id === 'multi-recipient')!
    expect(field().value).toBe(page.owner.value)
    page.owner.value = '0x4444444444444444444444444444444444444444'; await nextTick()
    expect(field().value).toBe(page.owner.value)
    const destination = '0x5555555555555555555555555555555555555555'
    field().value = destination; field().events.get('input')!({ target: field() }); await nextTick()
    page.owner.value = '0x6666666666666666666666666666666666666666'; await nextTick()
    expect(field().value).toBe(destination)
    expect(content(page.root)).toContain('A small gas refund may still land in the smart account and can be recovered')
    vi.mocked(prepareSmartWithdrawal).mockResolvedValue(page.quote)
    await page.start()
    expect(vi.mocked(prepareSmartWithdrawal).mock.calls[0]![2]).toEqual({ account: page.quote.scope.account, payout: 'custom', recipient: destination })
  })

  it('opens successive signature requests automatically and keeps the final quote through unchanged parent renders', async () => {
    const page = await mountWithdrawal(), signatures: number[] = []
    vi.mocked(prepareSmartWithdrawal).mockImplementation(async (_input, _wallet, _scope, _settings, progress, approve, signal) => {
      for (const sequence of [1, 2]) {
        await approve({ kind: 'user-operation', account: page.quote.scope.account.owner, chainId: 1, sequence, fee: page.quote.fee, net: page.quote.net })
        await nextTick()
        expect(content(page.root)).toContain(`Confirm signature ${sequence} in your wallet`)
        expect(button(page.root, 'Sign typed data in wallet')).toBeUndefined()
        // The page can rerender while the wallet prompt is open without changing the context.
        page.updates.value++; await nextTick(); signal!.throwIfAborted()
        signatures.push(sequence)
        progress('Refining the gas estimate…')
      }
      return page.quote
    })
    await page.start(); await nextTick()
    expect(signatures).toEqual([1, 2])
    page.owner.value = page.owner.value.toLowerCase() as typeof page.owner.value
    page.updates.value++; await nextTick()
    expect(button(page.root, 'Submit signed withdrawal')?.props.disabled).toBe(false)
    expect(content(page.root)).not.toContain('wallet or connection settings changed')
    expect(loadSmartAccount).toHaveBeenCalledTimes(2) // Initial check and preparation, no reload on parent activity.
    expect(submitSmartWithdrawal).not.toHaveBeenCalled() // Final submission is still an explicit action.
  })

  it.each(['account', 'provider', 'revision', 'connection', 'stop'])('cancels in-flight signing on a real %s change or cancellation', async change => {
    const page = await mountWithdrawal()
    let signal: AbortSignal | undefined
    vi.mocked(prepareSmartWithdrawal).mockImplementation(async (_input, _wallet, _scope, _settings, _progress, approve, incoming) => {
      signal = incoming
      await approve({ kind: 'user-operation', account: page.quote.scope.account.owner, chainId: 1, sequence: 1, fee: page.quote.fee, net: page.quote.net })
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
    })
    const preparing = page.start()
    await vi.waitFor(() => expect(content(page.root)).toContain('Confirm signature 1 in your wallet'))
    if (change === 'account') page.owner.value = '0x4444444444444444444444444444444444444444'
    if (change === 'provider') page.provider.value = markRaw(typedDataWallet().provider)
    if (change === 'revision') page.revision.value += 2 // Includes leaving and returning to the same wallet.
    if (change === 'connection') page.connection.value = 'new-settings'
    if (change === 'stop') (button(page.root, 'Stop preparation')!.props.onClick as () => void)()
    await preparing; await nextTick()
    expect(signal?.aborted).toBe(true)
    expect(button(page.root, 'Submit signed withdrawal')).toBeUndefined()
    expect(content(page.root)).toContain(change === 'stop' ? 'Batch preparation was cancelled.' : 'The wallet or connection settings changed.')
  })

  it('clears a signed quote when the actual context changes', async () => {
    const page = await mountWithdrawal()
    vi.mocked(prepareSmartWithdrawal).mockResolvedValue(page.quote)
    await page.start(); await nextTick()
    expect(button(page.root, 'Submit signed withdrawal')).toBeDefined()
    page.revision.value++; await nextTick()
    expect(button(page.root, 'Submit signed withdrawal')).toBeUndefined()
    expect(content(page.root)).toContain('The wallet or connection settings changed.')
  })

  it('also cancels when the wallet changes during the initial account lookup', async () => {
    const page = await mountWithdrawal()
    let finishLookup!: (account: typeof page.quote.scope.account) => void
    vi.mocked(loadSmartAccount).mockReturnValueOnce(new Promise(resolve => { finishLookup = resolve }))
    const preparing = page.start()
    page.revision.value++; await nextTick()
    finishLookup(page.quote.scope.account)
    await preparing; await nextTick()
    expect(prepareSmartWithdrawal).not.toHaveBeenCalled()
    expect(content(page.root)).toContain('The wallet or connection settings changed.')
  })

  it('stops after a declined wallet request without retrying or submitting', async () => {
    const page = await mountWithdrawal()
    vi.mocked(prepareSmartWithdrawal).mockImplementation(async (_input, _wallet, _scope, _settings, _progress, approve) => {
      await approve({ kind: 'user-operation', account: page.quote.scope.account.owner, chainId: 1, sequence: 1, fee: page.quote.fee, net: page.quote.net })
      throw new Error('User rejected the request.')
    })
    await page.start(); await nextTick()
    expect(content(page.root)).toContain('User rejected the request.')
    expect(button(page.root, 'Submit signed withdrawal')).toBeUndefined()
    expect(prepareSmartWithdrawal).toHaveBeenCalledOnce()
    expect(submitSmartWithdrawal).not.toHaveBeenCalled()
  })
})
