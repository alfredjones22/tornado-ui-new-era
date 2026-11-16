import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import RecipientPrivacy from '../src/RecipientPrivacy.vue'
import { loadAddressPrivacy, type AddressPrivacyState } from '../src/core/address-privacy'
import { settings } from './fixtures/multi-withdrawal'
import { Element, renderer, content, descendants, button } from './fixtures/vue-renderer'

vi.mock('../src/core/address-privacy', async original => ({ ...await original<object>(), loadAddressPrivacy: vi.fn() }))
const empty: AddressPrivacyState = { balance: 0n, nonce: 0, code: 'empty', tokenBalances: [{ symbol: 'DAI', balance: 0n }] }
const recipient = '0x4444444444444444444444444444444444444444'
const unmount: (() => void)[] = []
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(loadAddressPrivacy).mockImplementation(async addresses => new Map(addresses.map(address => [address.toLowerCase(), empty])))
})
afterEach(() => { unmount.splice(0).forEach(fn => fn()) })

async function mountPrivacy(initial = recipient) {
  const address = ref(initial), active = ref(true), rpc = ref(settings.rpcUrl), chainId = ref(settings.chainId), loading = ref(false)
  const app = renderer.createApp(defineComponent({ setup: () => () => h(RecipientPrivacy, {
    address: address.value, active: active.value, settings: { chainId: chainId.value, rpcUrl: rpc.value },
    onLoading: (value: boolean) => { loading.value = value },
  }) }))
  const root = new Element('root'); app.mount(root); unmount.push(() => app.unmount()); await nextTick()
  return { root, address, active, rpc, chainId, loading }
}

describe('single-note recipient privacy', () => {
  it('warns about a token-only recipient without requiring a connected wallet', async () => {
    vi.mocked(loadAddressPrivacy).mockResolvedValue(new Map([[recipient, { ...empty, tokenBalances: [{ symbol: 'DAI', balance: 1n }] }]]))
    const page = await mountPrivacy()
    expect(page.loading.value).toBe(true)
    await vi.waitFor(() => expect(page.loading.value).toBe(false))
    expect(loadAddressPrivacy).toHaveBeenCalledWith([recipient], { chainId: settings.chainId, rpcUrl: settings.rpcUrl })
    expect(content(page.root)).toContain('Withdrawal recipient')
    expect(content(page.root)).toContain('it has a DAI balance')
    expect(content(page.root)).toContain('Consider using a fresh recipient address.')
    expect(content(page.root)).not.toContain('ETH balance')
    expect(descendants(page.root).filter(node => node.props.class === 'privacy-warning')).toHaveLength(1)
  })

  it.each(['', '0x1234', '0x0000000000000000000000000000000000000000'])('does not query for an incomplete or zero recipient: %s', async address => {
    const page = await mountPrivacy(address)
    expect(page.loading.value).toBe(false)
    expect(loadAddressPrivacy).not.toHaveBeenCalled()
    expect(content(page.root)).not.toContain('Address privacy')
  })

  it('marks failed checks unknown and finishes loading so the warning does not block withdrawal', async () => {
    vi.mocked(loadAddressPrivacy).mockRejectedValue(new Error('private RPC response'))
    const page = await mountPrivacy()
    await vi.waitFor(() => expect(page.loading.value).toBe(false))
    expect(content(page.root)).toContain('Freshness could not be fully checked')
    expect(content(page.root)).not.toContain('private RPC response')
    expect(button(page.root, 'Recheck')?.props.disabled).toBe(false)
  })

  it('debounces recipient edits and discards a late result for the previous recipient', async () => {
    let finish!: (states: Awaited<ReturnType<typeof loadAddressPrivacy>>) => void
    vi.mocked(loadAddressPrivacy).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const page = await mountPrivacy()
    await vi.waitFor(() => expect(loadAddressPrivacy).toHaveBeenCalledOnce())
    page.address.value = '0x5555555555555555555555555555555555555555'; await nextTick()
    page.address.value = '0x6666666666666666666666666666666666666666'; await nextTick()
    await vi.waitFor(() => expect(page.loading.value).toBe(false))
    expect(loadAddressPrivacy).toHaveBeenCalledTimes(2)
    finish(new Map([[recipient, { ...empty, balance: 1n }]])); await nextTick()
    expect(content(page.root)).not.toContain('not fresh')
    expect(content(page.root)).not.toContain(recipient)
  })

  it('rechecks after RPC/network changes and clears the checks when leaving the page', async () => {
    const page = await mountPrivacy()
    await vi.waitFor(() => expect(page.loading.value).toBe(false))
    page.rpc.value = 'https://other.example'; page.chainId.value = 11155111; await nextTick()
    await vi.waitFor(() => expect(loadAddressPrivacy).toHaveBeenLastCalledWith([recipient], { chainId: 11155111, rpcUrl: 'https://other.example' }))
    page.active.value = false; await nextTick()
    expect(page.loading.value).toBe(false)
    expect(content(page.root)).not.toContain('Address privacy')
  })

  it('rechecks on demand without persisting an old non-fresh warning', async () => {
    vi.mocked(loadAddressPrivacy).mockResolvedValueOnce(new Map([[recipient, { ...empty, nonce: 3 }]]))
    const page = await mountPrivacy()
    await vi.waitFor(() => expect(page.loading.value).toBe(false))
    expect(content(page.root)).toContain('transaction nonce is nonzero')
    ;(button(page.root, 'Recheck')!.props.onClick as () => void)(); await nextTick()
    await vi.waitFor(() => expect(loadAddressPrivacy).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(page.loading.value).toBe(false))
    expect(content(page.root)).not.toContain('not fresh')
  })
})
