import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { parseEther, parseUnits, type Address } from 'viem'
import DepositBalances from '../src/DepositBalances.vue'
import { poolFor } from '../src/core/catalog'
import { Element, renderer, content, descendants, button } from './fixtures/vue-renderer'

const { getChainId, getBalance, readContract } = vi.hoisted(() => ({ getChainId: vi.fn(), getBalance: vi.fn(), readContract: vi.fn() }))
vi.mock('../src/core/rpc', async original => ({ ...await original<object>(), publicClientFor: () => ({ getChainId, getBalance, readContract }) }))
const first: Address = '0x1111111111111111111111111111111111111111', second: Address = '0x2222222222222222222222222222222222222222'
const cleanups: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks()
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  getChainId.mockResolvedValue(1); getBalance.mockResolvedValue(parseEther('1.25')); readContract.mockResolvedValue(parseUnits('125', 18))
})
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers(); vi.unstubAllGlobals() })
const settle = async () => { await vi.advanceTimersByTimeAsync(0); await nextTick() }
async function mountBalances(symbol = 'ETH', initial: Address | null = first) {
  const account = ref(initial), asset = ref(poolFor(1, symbol === 'ETH' ? '0.01' : '100', symbol)!.asset)
  const total = ref(symbol === 'ETH' ? parseEther('0.01') : parseUnits('100', asset.value.decimals))
  const active = ref(true), revision = ref(1), chainId = ref<1 | 11155111>(1), connect = vi.fn()
  const app = renderer.createApp(defineComponent({ setup: () => () => h(DepositBalances, {
    account: account.value, asset: asset.value, total: total.value, active: active.value, walletRevision: revision.value,
    settings: { chainId: chainId.value, rpcUrl: 'https://example.com' }, onConnect: connect,
  }) }))
  const root = new Element('root'); app.mount(root); cleanups.push(() => app.unmount()); await settle()
  return { root, account, asset, total, active, revision, chainId, connect }
}
describe('deposit wallet balances', () => {
  it('shows ETH for every deposit and reads only the selected token for an ERC-20 cart', async () => {
    const page = await mountBalances('DAI')
    expect(content(page.root)).toContain('1.25'); expect(content(page.root)).toContain('125')
    expect(content(page.root)).toContain('for gas')
    expect(readContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ address: page.asset.value.token, functionName: 'balanceOf', args: [first] }))
    page.asset.value = poolFor(1, '0.01')!.asset; page.total.value = parseEther('0.01'); await settle()
    expect(content(page.root)).not.toContain('DAI')
    expect(readContract).toHaveBeenCalledTimes(1)
  })
  it('does not query an address before connection, and allows choosing a wallet', async () => {
    const page = await mountBalances('ETH', null)
    expect(getBalance).not.toHaveBeenCalled(); expect(content(page.root)).toContain('Connect a wallet')
    ;(button(page.root, 'Connect wallet')!.props.onClick as () => void)()
    expect(page.connect).toHaveBeenCalledOnce()
  })
  it('keeps ETH visible if the token RPC read fails and never presents failure as zero', async () => {
    readContract.mockRejectedValue(new Error('private RPC detail'))
    const page = await mountBalances('DAI')
    expect(content(page.root)).toContain('1.25'); expect(content(page.root)).toContain('DAI balance unavailable')
    expect(content(page.root)).not.toContain('exceeds'); expect(content(page.root)).not.toContain('private RPC detail')
  })
  it('discards an old wallet balance after switching accounts', async () => {
    let finish!: (value: bigint) => void
    getBalance.mockReturnValueOnce(new Promise<bigint>(resolve => { finish = resolve }))
    const page = await mountBalances()
    page.account.value = second; page.revision.value++; getBalance.mockResolvedValue(parseEther('2.5')); await settle()
    finish(parseEther('999')); await settle()
    expect(content(page.root)).toContain('0x2222…2222'); expect(content(page.root)).toContain('2.5')
    expect(content(page.root)).not.toContain('999')
  })
  it('warns about insufficient funds without blocking the change-wallet action', async () => {
    getBalance.mockResolvedValue(0n); readContract.mockResolvedValue(parseUnits('90', 18))
    const page = await mountBalances('DAI')
    expect(content(page.root)).toContain('exceeds this wallet’s DAI balance by 10 DAI')
    expect(content(page.root)).toContain('needs ETH to pay network fees')
    expect(button(page.root, 'Change wallet')?.props.disabled).toBe(false)
  })
  it('rejects a wrong-network balance source before reading its balances', async () => {
    getChainId.mockResolvedValue(11155111)
    const page = await mountBalances()
    expect(getBalance).not.toHaveBeenCalled(); expect(content(page.root)).toContain('ETH balance unavailable')
    expect(content(page.root)).not.toContain('1.25')
  })
  it('refreshes on return and periodically, and stops requests while the form is inactive', async () => {
    const page = await mountBalances()
    getBalance.mockResolvedValue(parseEther('3'))
    window.dispatchEvent(new Event('focus')); await settle(); expect(content(page.root)).toContain('3')
    await vi.advanceTimersByTimeAsync(30_000); expect(getBalance).toHaveBeenCalledTimes(3)
    page.active.value = false; await settle()
    await vi.advanceTimersByTimeAsync(30_000); window.dispatchEvent(new Event('focus')); await settle()
    expect(getBalance).toHaveBeenCalledTimes(3)
    page.active.value = true; await settle(); expect(getBalance).toHaveBeenCalledTimes(4)
  })
})
