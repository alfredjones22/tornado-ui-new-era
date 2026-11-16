import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadAddressPrivacy, recipientPrivacyCheck, withdrawalPrivacyChecks, type AddressPrivacyState } from '../src/core/address-privacy'
import { assetsFor, type ChainId } from '../src/core/catalog'
import { publicClientFor } from '../src/core/rpc'
import { settings } from './fixtures/multi-withdrawal'
import { smartFixture } from './fixtures/smart-withdrawal'
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, erc20Abi, multicall3Abi, type Hex } from 'viem'
import { mainnet, sepolia } from 'viem/chains'

vi.mock('../src/core/rpc', async original => ({ ...await original<object>(), publicClientFor: vi.fn() }))
const getBalance = vi.fn(), getTransactionCount = vi.fn(), getCode = vi.fn(), multicall = vi.fn()
const tokenBalances = (chainId: ChainId) => assetsFor(chainId).filter(asset => asset.token).map(asset => ({ symbol: asset.symbol, balance: 0n }))
const empty: AddressPrivacyState = { balance: 0n, nonce: 0, code: 'empty', tokenBalances: tokenBalances(1) }
beforeEach(() => {
  vi.resetAllMocks(); getBalance.mockResolvedValue(0n); getTransactionCount.mockResolvedValue(0); getCode.mockResolvedValue('0x')
  multicall.mockImplementation(async ({ contracts }: { contracts: unknown[] }) => contracts.map(() => ({ status: 'success', result: 0n })))
  vi.mocked(publicClientFor).mockReturnValue({ getBalance, getTransactionCount, getCode, multicall } as unknown as ReturnType<typeof publicClientFor>)
})

describe('withdrawal address privacy checks', () => {
  it('reads pending balance, transaction count and code once per unique address without a bundler or wallet call', async () => {
    const { scope } = smartFixture(), owner = scope.account.owner
    const states = await loadAddressPrivacy([scope.account.address, owner, owner.toLowerCase() as typeof owner], settings)
    expect(states.size).toBe(2)
    for (const read of [getBalance, getTransactionCount, getCode]) {
      expect(read).toHaveBeenCalledTimes(2)
      expect(read).toHaveBeenCalledWith({ address: owner.toLowerCase(), blockTag: 'pending' })
    }
    expect(states.get(owner.toLowerCase())).toEqual(empty)
    expect(multicall).toHaveBeenCalledOnce()
    const checks = withdrawalPrivacyChecks(scope.account, owner, states)
    expect(checks).toHaveLength(2)
    expect(checks[1]!.label).toBe('Controller EOA and withdrawal recipient')
    expect(checks.every(check => !check.signals.length && !check.incomplete)).toBe(true)
  })

  it('warns for a deployed sender and its EntryPoint nonce even if every new RPC request failed', () => {
    const { scope } = smartFixture(2, 'eth', 'account', true)
    const checks = withdrawalPrivacyChecks(scope.account, undefined, new Map())
    expect(checks[0]).toMatchObject({ label: 'Smart account (UserOperation sender)', incomplete: true,
      signals: ['the smart account is already deployed', 'its EntryPoint nonce is nonzero'] })
    expect(checks[0]!.advice).toContain('fresh EOA controller')
  })

  it.each([
    [{ balance: 1n }, 'ETH balance'],
    [{ nonce: 1 }, 'transaction nonce'],
    [{ code: 'delegation' as const }, 'EIP-7702 delegation'],
    [{ code: 'contract' as const }, 'contract code'],
  ])('warns independently for existing state on the controller and recipient: %s', (changed, reason) => {
    const { scope } = smartFixture(2, 'eth', 'custom'), recipient = scope.recipient!
    const states = new Map([[scope.account.address.toLowerCase(), empty], [scope.account.owner.toLowerCase(), { ...empty, ...changed }], [recipient.toLowerCase(), { ...empty, ...changed }]])
    const checks = withdrawalPrivacyChecks(scope.account, recipient, states)
    expect(checks).toHaveLength(3)
    expect(checks[0]!.signals).toEqual([])
    expect(checks[1]!.signals.join()).toContain(reason)
    expect(checks[2]!.signals.join()).toContain(reason)
    expect(checks[2]!.advice).toContain('fresh recipient')
  })

  it('also flags a prefunded undeployed smart account and merges a matching recipient role', () => {
    const { scope } = smartFixture()
    const states = new Map([[scope.account.address.toLowerCase(), { ...empty, balance: 1n }], [scope.account.owner.toLowerCase(), empty]])
    const checks = withdrawalPrivacyChecks(scope.account, scope.account.address, states)
    expect(checks).toHaveLength(2)
    expect(checks[0]!.signals).toEqual(['it has an ETH balance'])
  })

  it('keeps successful observations when another read fails, and never equates failure with freshness', async () => {
    const { scope } = smartFixture(), owner = scope.account.owner
    getBalance.mockRejectedValue(new Error('private RPC failure detail')); getTransactionCount.mockResolvedValue(5)
    getCode.mockResolvedValue(`0xef0100${'ab'.repeat(20)}`)
    const states = await loadAddressPrivacy([owner], settings)
    expect(states.get(owner.toLowerCase())).toEqual({ balance: null, nonce: 5, code: 'delegation', tokenBalances: tokenBalances(1) })
    const check = withdrawalPrivacyChecks(scope.account, undefined, states)[1]!
    expect(check.incomplete).toBe(true)
    expect(check.signals).toEqual(['its transaction nonce is nonzero', 'it has an EIP-7702 delegation'])
    expect(JSON.stringify(check)).not.toContain('private RPC failure detail')
  })

  it('distinguishes delegated EOAs, contract bytecode and absent code', async () => {
    const { scope } = smartFixture(), owner = scope.account.owner
    for (const [code, kind] of [[undefined, 'empty'], ['0x', 'empty'], [`0xEf0100${'ab'.repeat(20)}`, 'delegation'], ['0x6001', 'contract']] as const) {
      getCode.mockResolvedValue(code)
      expect((await loadAddressPrivacy([owner], settings)).get(owner.toLowerCase())!.code).toBe(kind)
    }
  })

  it.each([1, 11155111] as const)('batches all supported ERC-20 balances once per check set on chain %s', async chainId => {
    const { scope } = smartFixture(), tokens = assetsFor(chainId).filter(asset => asset.token)
    const selected = [scope.account.owner, scope.account.address]
    const states = await loadAddressPrivacy([...selected, selected[0]!], { ...settings, chainId })
    expect(multicall).toHaveBeenCalledOnce()
    const request = multicall.mock.calls[0]![0]
    expect(request).toMatchObject({ allowFailure: true, blockTag: 'pending' })
    expect(request.contracts.map((call: { address: string; functionName: string; args: string[] }) => [call.address, call.functionName, call.args[0]])).toEqual(
      selected.flatMap(address => tokens.map(token => [token.token, 'balanceOf', address])))
    expect(states.get(selected[0]!.toLowerCase())?.tokenBalances).toEqual(tokenBalances(chainId))
  })

  it('warns on ERC-20 dust alone for every role, including a single-note recipient', async () => {
    const { scope } = smartFixture(2, 'eth', 'custom'), recipient = scope.recipient!
    // Every queried token has a minimal nonzero balance; ETH/nonce/code are empty.
    multicall.mockImplementation(async ({ contracts }: { contracts: unknown[] }) => contracts.map(() => ({ status: 'success', result: 1n })))
    const states = await loadAddressPrivacy([scope.account.address, scope.account.owner, recipient], settings)
    const checks = [...withdrawalPrivacyChecks(scope.account, recipient, states), recipientPrivacyCheck(recipient, states)]
    for (const check of checks) {
      expect(check.incomplete).toBe(false)
      expect(check.signals).toEqual(tokenBalances(1).map(token => `it has a ${token.symbol} balance`))
      expect(check.signals.length).toBeGreaterThan(0)
    }
  })

  it('retains successful token balances when one token reverts, and marks the check incomplete', async () => {
    const { scope } = smartFixture()
    multicall.mockImplementation(async ({ contracts }: { contracts: unknown[] }) => contracts.map((_, i) => i === 0
      ? { status: 'failure', error: new Error('private token detail') } : { status: 'success', result: 1n }))
    const states = await loadAddressPrivacy([scope.account.owner], settings), check = recipientPrivacyCheck(scope.account.owner, states)
    expect(check.incomplete).toBe(true)
    expect(states.get(scope.account.owner.toLowerCase())!.tokenBalances[0]!.balance).toBeNull()
    expect(check.signals.length).toBeGreaterThan(0)
    expect(JSON.stringify(check)).not.toContain('private token detail')
  })

  it('does not treat an unavailable Multicall as zero token balances', async () => {
    const { scope } = smartFixture()
    multicall.mockRejectedValue(new Error('Multicall unavailable'))
    const states = await loadAddressPrivacy([scope.account.owner], settings), check = recipientPrivacyCheck(scope.account.owner, states)
    expect(check.signals).toEqual([])
    expect(check.incomplete).toBe(true)
    expect(states.get(scope.account.owner.toLowerCase())!.tokenBalances.every(token => token.balance === null)).toBe(true)
    expect(multicall).toHaveBeenCalledOnce()
  })

  it('does not query the RPC for an empty address set', async () => {
    expect(await loadAddressPrivacy([], settings)).toEqual(new Map())
    expect(publicClientFor).not.toHaveBeenCalled()
  })

  it.each([1, 11155111] as const)('uses only one extra eth_call for three addresses on chain %s with the real viem client', async chainId => {
    const { scope } = smartFixture(2, 'eth', 'custom')
    const request = vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === 'eth_getBalance' || method === 'eth_getTransactionCount') return '0x0'
      if (method === 'eth_getCode') return '0x'
      if (method === 'eth_call') {
        const [call] = params as [{ data: Hex }]
        const decoded = decodeFunctionData({ abi: multicall3Abi, data: call.data })
        if (decoded.functionName !== 'aggregate3') throw new Error('Unexpected Multicall method')
        const calls = decoded.args[0]
        expect(calls).toHaveLength(tokenBalances(chainId).length * 3)
        return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: calls.map(() => ({ success: true,
          returnData: encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: 0n }) })) })
      }
      throw new Error(`Unexpected method ${method}`)
    })
    const client = createPublicClient({ chain: chainId === 1 ? mainnet : sepolia, transport: custom({ request }, { retryCount: 0 }) })
    vi.mocked(publicClientFor).mockReturnValue(client as unknown as ReturnType<typeof publicClientFor>)
    const states = await loadAddressPrivacy([scope.account.owner, scope.account.address, scope.recipient!], { ...settings, chainId })
    expect(request.mock.calls.filter(([call]) => call.method === 'eth_call')).toHaveLength(1)
    expect(request).toHaveBeenCalledTimes(10) // 3 native-state reads per address + 1 token multicall.
    expect([...states.values()].every(state => state.tokenBalances.every(token => token.balance === 0n))).toBe(true)
  })
})
