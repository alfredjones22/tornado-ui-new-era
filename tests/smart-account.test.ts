import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, erc20Abi, type Hex } from 'viem'
import { TornadoPaymasterConfigs } from '@kohaku-eth/tornado-cash'
import { assetsFor } from '../src/core/catalog'
import { publicClientFor } from '../src/core/rpc'
import { assertSmartAccount, loadSmartAccount, recoverSmartAccount, simpleAccountAbi, UnsupportedControllerError } from '../src/core/smart-account'
import { recipient, settings } from './fixtures/multi-withdrawal'
import type { Progress } from '../src/core/wallet'
import { typedDataWallet } from './fixtures/smart-withdrawal'

vi.mock('../src/core/rpc', async original => ({ ...await original<object>(), publicClientFor: vi.fn(), validateConnections: vi.fn() }))
// Short stand-ins for the runtime bytecode whose actual hashes were checked on
// mainnet/Sepolia. Other hashes (including the stable account salt) remain real.
vi.mock('viem', async original => {
  const real = await original<typeof import('viem')>()
  return { ...real, keccak256: (data: Hex) => data === '0x6001' ? '0xa2e635152a61e180383c7afc045620b7461ef6f43ba27d592262513106b991b7'
    : data === '0x6002' ? '0x689a90eff03926a12aedad2fc6d4fdbcbdd9ffac86e7d0d70ce6355961305c74' : real.keccak256(data) }
})
const sender = '0x3333333333333333333333333333333333333333', implementation = '0x28426d752372D68d34340bd94390950DcE3C9ec3'
const txHash: Hex = `0x${'dd'.repeat(32)}`
const usdc = assetsFor(1).find(asset => asset.symbol === 'USDC')!
let deployed = true, nonce = 7n, owner = recipient
const getCode = vi.fn(), readContract = vi.fn(), getStorageAt = vi.fn(), getBalance = vi.fn(), estimateGas = vi.fn(), waitForTransactionReceipt = vi.fn()
beforeEach(() => {
  vi.resetAllMocks(); deployed = true; nonce = 7n; owner = recipient
  getCode.mockImplementation(async ({ address }) => address.toLowerCase() === implementation.toLowerCase() ? '0x6002'
    : address === sender ? deployed ? '0x6003' : '0x' : address === recipient ? '0x' : '0x6001')
  readContract.mockImplementation(async ({ address, functionName }) => {
    if (functionName === 'accountImplementation') return implementation
    if (functionName === 'getAddress') return sender
    if (functionName === 'entryPoint') return TornadoPaymasterConfigs[1].entryPointAddress
    if (functionName === 'getNonce') return nonce
    if (functionName === 'owner') return owner
    if (functionName === 'balanceOf') return address === TornadoPaymasterConfigs[1].entryPointAddress ? 50n : address === usdc.token ? 100n : 0n
    throw new Error('Unexpected read')
  })
  getStorageAt.mockResolvedValue(`0x${implementation.slice(2).toLowerCase().padStart(64, '0')}`)
  getBalance.mockResolvedValue(200n); estimateGas.mockResolvedValue(100_000n); waitForTransactionReceipt.mockResolvedValue({ status: 'success' })
  vi.mocked(publicClientFor).mockReturnValue({ getCode, readContract, getStorageAt, getBalance, estimateGas, waitForTransactionReceipt } as unknown as ReturnType<typeof publicClientFor>)
})

describe('known factory account discovery and reuse', () => {
  it('discovers the same owner account after deployment and reads its current EntryPoint nonce', async () => {
    deployed = false; nonce = 0n
    const first = await loadSmartAccount(recipient, settings)
    expect(first).toMatchObject({ address: sender, owner: recipient, nonce: 0n, deployed: false })
    deployed = true; nonce = 7n
    const reused = await loadSmartAccount(recipient, settings)
    expect(reused.address).toBe(first.address); expect(reused.salt).toBe(first.salt)
    expect(reused.nonce).toBe(7n); expect(reused.deployed).toBe(true)
    await expect(assertSmartAccount(first, settings)).rejects.toThrow('changed or its nonce was used')
  })
  it('rejects an upgraded implementation or a different account owner', async () => {
    owner = sender
    await expect(loadSmartAccount(recipient, settings)).rejects.toThrow('different owner')
    owner = recipient; getStorageAt.mockResolvedValue(`0x${'00'.repeat(32)}`)
    await expect(loadSmartAccount(recipient, settings)).rejects.toThrow('implementation')
  })
  it('rejects a missing factory or an arbitrary contract-wallet controller', async () => {
    getCode.mockResolvedValue('0x')
    await expect(loadSmartAccount(recipient, settings)).rejects.toThrow('factory is unavailable')
    getCode.mockImplementation(async ({ address }) => address === recipient ? '0x6004' : '0x6001')
    await expect(loadSmartAccount(recipient, settings)).rejects.toBeInstanceOf(UnsupportedControllerError)
  })
  it('accepts an EIP-7702 EOA as controller without adopting or changing its delegation', async () => {
    const original = getCode.getMockImplementation()!
    getCode.mockImplementation(async args => args.address === recipient ? `0xef0100${'ab'.repeat(20)}` : original(args))
    expect(await loadSmartAccount(recipient, settings)).toMatchObject({ address: sender, owner: recipient })
  })
})

describe('owner-paid recovery without a bundler or note proof', () => {
  it.each([recipient, '0x4444444444444444444444444444444444444444'] as const)('sweeps ETH, supported tokens and EntryPoint deposits to %s', async destination => {
    const wallet = typedDataWallet(), request = vi.spyOn(wallet.provider, 'request')
    request.mockImplementation(async ({ method }) => method === 'eth_chainId' ? '0x1' : method === 'eth_accounts' ? [recipient] : txHash)
    let row: Partial<Progress> = {}
    const update = (_id: string, patch: Partial<Progress>) => { row = { ...row, ...patch } }
    if (destination === recipient) await recoverSmartAccount(wallet, settings, update)
    else await recoverSmartAccount(wallet, settings, update, destination)
    const sent = request.mock.calls.find(([r]) => r.method === 'eth_sendTransaction')![0]
    const tx = (sent.params as { from: string; to: string; data: Hex }[])[0]!
    expect(tx.from).toBe(recipient); expect(tx.to).toBe(sender)
    const decoded = decodeFunctionData({ abi: simpleAccountAbi, data: tx.data })
    expect(decoded.functionName).toBe('executeBatch')
    if (decoded.functionName !== 'executeBatch') throw new Error('Expected executeBatch')
    expect(decoded.args[0]).toHaveLength(3)
    expect(decoded.args[0][0]).toMatchObject({ target: destination, value: 200n, data: '0x' })
    const token = decoded.args[0].find(call => call.target === usdc.token)!
    expect(decodeFunctionData({ abi: erc20Abi, data: token.data })).toMatchObject({ functionName: 'transfer', args: [destination, 100n] })
    expect(decodeFunctionData({ abi: simpleAccountAbi, data: decoded.args[0][2]!.data })).toMatchObject({ functionName: 'withdrawDepositTo', args: [destination, 50n] })
    expect(estimateGas).toHaveBeenCalledWith({ account: recipient, to: sender, data: tx.data })
    expect(request.mock.calls.filter(([r]) => /sign/i.test(r.method))).toHaveLength(0)
    expect(row).toMatchObject({ status: 'confirmed', transactionHash: txHash })
  })
  it.each(['invalid', '0x0000000000000000000000000000000000000000', sender])('rejects unsafe sweep recipient %s before requesting a transaction', async destination => {
    const wallet = typedDataWallet(), request = vi.spyOn(wallet.provider, 'request')
    await expect(recoverSmartAccount(wallet, settings, vi.fn(), destination as `0x${string}`)).rejects.toThrow(/recipient/)
    expect(estimateGas).not.toHaveBeenCalled()
    expect(request.mock.calls.some(([r]) => r.method === 'eth_sendTransaction')).toBe(false)
  })
  it('does not send the sweep when simulation rejects the recipient', async () => {
    const wallet = typedDataWallet(), request = vi.spyOn(wallet.provider, 'request')
    estimateGas.mockRejectedValue(new Error('Recipient rejected ETH'))
    await expect(recoverSmartAccount(wallet, settings, vi.fn(), '0x4444444444444444444444444444444444444444')).rejects.toThrow('Recipient rejected ETH')
    expect(request.mock.calls.some(([r]) => r.method === 'eth_sendTransaction')).toBe(false)
  })
  it('refuses recovery from another owner before requesting a transaction', async () => {
    owner = sender
    const wallet = typedDataWallet(), request = vi.spyOn(wallet.provider, 'request')
    await expect(recoverSmartAccount(wallet, settings, vi.fn())).rejects.toThrow('different owner')
    expect(request.mock.calls.some(([r]) => r.method === 'eth_sendTransaction')).toBe(false)
  })
})
