import { describe, expect, it, vi, afterEach } from 'vitest'
import { actionBudget, loadActionBalances, unknownActionBalances } from '../src/core/action-budget'
import { publicClientFor } from '../src/core/rpc'
import { poolFor } from '../src/core/catalog'
import { settings } from './fixtures/multi-withdrawal'
vi.mock('../src/core/rpc', async original => ({ ...await original<object>(), publicClientFor: vi.fn() }))
afterEach(() => vi.resetAllMocks())
const address = '0x3333333333333333333333333333333333333333'
describe('contract action funding budget', () => {
  it('reserves the exact quoted fee and never adds a potential refund', () => {
    expect(actionBudget(100n, { eth: 5n, asset: 5n }, 10n)).toEqual({ beforeFee: 105n, spendable: 95n })
    expect(actionBudget(100n, { eth: 5n, asset: 5n })).toEqual({ beforeFee: 105n, spendable: null })
    expect(actionBudget(100n, unknownActionBalances(), 10n)).toEqual({ beforeFee: null, spendable: null })
  })
  it('pins ETH and token balance reads to the same block', async () => {
    const client = { getBlockNumber: vi.fn(async () => 42n), getBalance: vi.fn(async () => 3n), readContract: vi.fn(async () => 9n) }
    vi.mocked(publicClientFor).mockReturnValue(client as unknown as ReturnType<typeof publicClientFor>)
    expect(await loadActionBalances(address, poolFor(1, '100', 'DAI')!.asset, settings)).toEqual({ eth: 3n, asset: 9n, block: 42n })
    expect(client.getBalance).toHaveBeenCalledWith({ address, blockNumber: 42n })
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 42n, functionName: 'balanceOf', args: [address] }))
  })
  it('does not invent zero token balances when the read fails', async () => {
    vi.mocked(publicClientFor).mockReturnValue({ getBlockNumber: async () => 42n, getBalance: async () => 3n, readContract: async () => { throw new Error('Offline') } } as unknown as ReturnType<typeof publicClientFor>)
    expect(await loadActionBalances(address, poolFor(1, '100', 'DAI')!.asset, settings)).toEqual({ eth: 3n, asset: null, block: 42n })
    expect(await loadActionBalances(address, poolFor(1, '1')!.asset, settings)).toEqual({ eth: 3n, asset: 3n, block: 42n })
  })
})
