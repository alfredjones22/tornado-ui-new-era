import { afterEach, describe, expect, it } from 'vitest'
import { parseEther } from 'viem'
import ActionBudget from '../src/ActionBudget.vue'
import { poolFor } from '../src/core/catalog'
import { renderer, Element, content } from './fixtures/vue-renderer'
const unmount: (() => void)[] = []
afterEach(() => unmount.splice(0).forEach(fn => fn()))
function show(symbol = 'ETH', fee?: bigint, unknown = false) {
  const asset = poolFor(1, symbol === 'ETH' ? '1' : '100', symbol)!.asset
  const root = new Element('root'), app = renderer.createApp(ActionBudget, { asset, total: parseEther('1'), balances: { eth: unknown ? null : 0n, asset: unknown ? null : parseEther('0.2') }, loading: false, fee, ethSent: parseEther('0.1') })
  app.mount(root); unmount.push(() => app.unmount()); return content(root)
}
describe('visible contract-call funding', () => {
  it('shows an exact fee reserve and combines proceeds with existing asset balance', () => {
    const text = show('ETH', parseEther('0.05'))
    expect(text).toContain('1.15 ETH')
    expect(text).toContain('Maximum paymaster fee')
    expect(text).toContain('Available before custom calls')
    expect(text).not.toContain('This is not a spendable quote yet')
  })
  it('keeps a draft budget provisional until the fee is known', () => {
    const text = show()
    expect(text).toContain('Before paymaster fee')
    expect(text).toContain('Calculated during review')
    expect(text).toContain('This is not a spendable quote yet')
  })
  it('separates native ETH from token proceeds and warns without claiming a multi-step sequence cannot work', () => {
    const text = show('DAI', parseEther('0.05'))
    expect(text).toContain('1.15 DAI')
    expect(text).toContain('ETH for call values')
    expect(text).toContain('Earlier calls would need to receive ETH')
  })
  it('does not present missing balances or future refunds as spendable', () => {
    const text = show('DAI', parseEther('0.05'), true)
    expect(text).toContain('Not yet verified')
    expect(text).toContain('it has not been assumed to be zero')
    expect(text).toContain('Later gas refunds are excluded')
  })
})
