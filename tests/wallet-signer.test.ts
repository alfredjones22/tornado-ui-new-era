import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashTypedData, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { batchTypedData, SIMPLE_7702_IMPLEMENTATION, validateBatchSigningRequest } from '../src/core/batch-policy'
import { createWithdrawalSigner } from '../src/core/wallet-signer'
import type { WalletProvider } from '../src/core/wallet'
import { fixture, recipient, settings, signingAccount } from './fixtures/multi-withdrawal'

const authorization = { address: SIMPLE_7702_IMPLEMENTATION as `0x${string}`, chainId: 1, nonce: 0 }
const sessions: ReturnType<typeof createWithdrawalSigner>[] = []
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()) })
function browserWallet(signingKey = signingAccount) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  let chain = '0x1', accounts = [recipient]
  const provider: WalletProvider = {
    request: vi.fn(async ({ method, params }) => {
      if (method === 'eth_chainId') return chain
      if (method === 'eth_accounts') return accounts
      if (method === 'wallet_signAuthorization') return signingKey.signAuthorization(authorization)
      if (method === 'eth_signTypedData_v4') return signingKey.signTypedData(JSON.parse((params as string[])[1]!))
      throw new Error(`Unexpected wallet method ${method}`)
    }),
    on: (event, listener) => { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set) },
    removeListener: (event, listener) => { listeners.get(event)?.delete(listener) },
  }
  return { provider, listeners,
    changeAccount() { accounts = [SIMPLE_7702_IMPLEMENTATION]; listeners.get('accountsChanged')?.forEach(fn => fn(accounts)) },
    changeChain() { chain = '0xaa36a7'; listeners.get('chainChanged')?.forEach(fn => fn(chain)) },
    notifyUnchanged() { listeners.get('accountsChanged')?.forEach(fn => fn([recipient])); listeners.get('chainChanged')?.forEach(fn => fn(chain)) },
    restoreAccount() { accounts = [recipient]; listeners.get('accountsChanged')?.forEach(fn => fn(accounts)) },
  }
}
function setup(count = 2, asset = 'eth', approve = vi.fn(async () => {}), wallet = browserWallet()) {
  const { quote } = fixture(count, asset)
  const session = createWithdrawalSigner({ provider: wallet.provider, account: recipient }, quote.notes, settings, approve)
  sessions.push(session)
  return { ...wallet, quote, session, approve }
}
const signMethods = (provider: WalletProvider) => vi.mocked(provider.request).mock.calls.filter(([request]) => /sign/i.test(request.method))

describe('browser-wallet receiver signing', () => {
  it('requests a chain-scoped, zero-nonce authorization and verifies the returned signer', async () => {
    const { session, provider, approve } = setup()
    const signed = await session.signer.signAuthorization(authorization)
    expect(signed.address).toBe(SIMPLE_7702_IMPLEMENTATION)
    expect(signed.nonce).toBe(0)
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ kind: 'authorization', account: recipient }))
    expect(provider.request).toHaveBeenCalledWith({ method: 'wallet_signAuthorization', params: [{ from: recipient,
      address: SIMPLE_7702_IMPLEMENTATION, contractAddress: SIMPLE_7702_IMPLEMENTATION, chainId: '0x1', nonce: '0x0' }] })
  })
  it.each([{ count: 2, asset: 'eth' }, { count: 12, asset: 'eth' }, { count: 3, asset: 'usdc' }])('signs and binds all $count $asset notes in one UserOperation', async ({ count, asset }) => {
    const { session, quote, provider, approve } = setup(count, asset)
    const typed = batchTypedData(quote.withdrawal, settings)
    const signature = await session.signer.signTypedData(typed)
    quote.withdrawal.userOperation.signature = signature
    await expect(session.verifyPrepared(quote.withdrawal)).resolves.toBe(hashTypedData(typed))
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ kind: 'user-operation', sequence: 1, fee: quote.fee, net: quote.net }))
    expect(signMethods(provider).map(([request]) => request.method)).toEqual(['eth_signTypedData_v4'])
  })
  it('waits for concrete fee consent before asking the wallet to sign', async () => {
    let release!: () => void
    const approve = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const { session, quote, provider } = setup(2, 'eth', approve)
    const pending = session.signer.signTypedData(batchTypedData(quote.withdrawal, settings))
    await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
    expect(signMethods(provider)).toHaveLength(0)
    release()
    await pending
    expect(signMethods(provider)).toHaveLength(1)
  })
  it('asks again for a changed gas payload and only accepts the final approved one', async () => {
    const { session, quote, approve } = setup()
    const first = structuredClone(quote.withdrawal)
    first.userOperation.signature = await session.signer.signTypedData(batchTypedData(first, settings))
    quote.withdrawal.userOperation.callGasLimit = '0x100001'
    quote.withdrawal.userOperation.signature = await session.signer.signTypedData(batchTypedData(quote.withdrawal, settings))
    expect(approve).toHaveBeenCalledTimes(2)
    await expect(session.verifyPrepared(first)).rejects.toThrow('differs from the last wallet-approved')
    await expect(session.verifyPrepared(quote.withdrawal)).resolves.toBeTypeOf('string')
  })
  it.each(['account', 'chain'] as const)('stops on a wallet %s change during consent', async kind => {
    const wallet = browserWallet()
    const approve = vi.fn(async () => { if (kind === 'account') wallet.changeAccount(); else wallet.changeChain() })
    const { session, quote, provider } = setup(2, 'eth', approve, wallet)
    await expect(session.signer.signTypedData(batchTypedData(quote.withdrawal, settings))).rejects.toThrow('changed or was cancelled')
    expect(signMethods(provider)).toHaveLength(0)
  })
  it('accepts redundant notifications of the pinned account and network', async () => {
    const wallet = browserWallet(), approve = vi.fn(async () => wallet.notifyUnchanged())
    const { session, quote, provider } = setup(2, 'eth', approve, wallet)
    await expect(session.signer.signAuthorization(authorization)).resolves.toMatchObject(authorization)
    quote.withdrawal.userOperation.signature = await session.signer.signTypedData(batchTypedData(quote.withdrawal, settings))
    await expect(session.verifyPrepared(quote.withdrawal)).resolves.toBe(quote.signedHash)
    expect(signMethods(provider)).toHaveLength(2)
  })
  it('still rejects a real account change away and back during consent', async () => {
    const wallet = browserWallet(), approve = vi.fn(async () => { wallet.changeAccount(); wallet.restoreAccount() })
    const { session, provider } = setup(2, 'eth', approve, wallet)
    await expect(session.signer.signAuthorization(authorization)).rejects.toThrow('changed or was cancelled')
    expect(signMethods(provider)).toHaveLength(0)
  })
  it('rejects an account change while the wallet signature popup is open', async () => {
    const wallet = browserWallet(), original = wallet.provider.request
    wallet.provider.request = vi.fn(async args => {
      const result = await original(args)
      if (args.method === 'eth_signTypedData_v4') wallet.changeAccount()
      return result
    })
    const { session, quote } = setup(2, 'eth', undefined, wallet)
    await expect(session.signer.signTypedData(batchTypedData(quote.withdrawal, settings))).rejects.toThrow('changed or was cancelled')
  })
  it.each(['authorization', 'typed-data'])('rejects a %s signature belonging to another key', async kind => {
    const wallet = browserWallet(privateKeyToAccount(`0x${'20'.repeat(32)}`))
    const { session, quote } = setup(2, 'eth', undefined, wallet)
    await expect(kind === 'authorization' ? session.signer.signAuthorization(authorization) : session.signer.signTypedData(batchTypedData(quote.withdrawal, settings))).rejects.toThrow('different account')
  })
  it.each([-32601, 4200])('reports unsupported authorization signing (%s) and never falls back to key entry or raw signing', async code => {
    const wallet = browserWallet(), original = wallet.provider.request
    wallet.provider.request = vi.fn(async args => {
      if (args.method === 'wallet_signAuthorization') throw { code }
      return original(args)
    })
    const { session, provider } = setup(2, 'eth', undefined, wallet)
    await expect(session.signer.signAuthorization(authorization)).rejects.toThrow('single-note withdrawal flow')
    expect(signMethods(provider).map(([request]) => request.method)).toEqual(['wallet_signAuthorization'])
  })
  it.each([
    { code: -32602, message: 'Invalid params', expected: 'parameters (code -32602)' },
    { code: -32000, message: 'Authorization unavailable on this account', expected: 'authorization signing failed (code -32000): Authorization unavailable' },
  ])('preserves an authorization request failure instead of labelling it cancellation (%s)', async ({ code, message, expected }) => {
    const wallet = browserWallet(), original = wallet.provider.request
    wallet.provider.request = vi.fn(async args => {
      if (args.method === 'wallet_signAuthorization') throw { code, message }
      return original(args)
    })
    const { session } = setup(2, 'eth', undefined, wallet)
    await expect(session.signer.signAuthorization(authorization)).rejects.toThrow(expected)
  })
  it('does not retry declined typed-data signing', async () => {
    const wallet = browserWallet(), original = wallet.provider.request
    wallet.provider.request = vi.fn(async args => {
      if (args.method === 'eth_signTypedData_v4') throw { code: 4001, message: 'User rejected' }
      return original(args)
    })
    const { session, quote, provider } = setup(2, 'eth', undefined, wallet)
    await expect(session.signer.signTypedData(batchTypedData(quote.withdrawal, settings))).rejects.toThrow()
    expect(signMethods(provider)).toHaveLength(1)
  })
  it('removes listeners and refuses callbacks after the session ends', async () => {
    const { session, listeners, provider } = setup()
    session.dispose()
    expect([...listeners.values()].every(set => set.size === 0)).toBe(true)
    await expect(session.signer.signAuthorization(authorization)).rejects.toThrow('cancelled')
    expect(signMethods(provider)).toHaveLength(0)
  })
})

describe('pre-signing payload policy', () => {
  it.each(['chain', 'entrypoint', 'schema', 'factory', 'sender', 'paymaster', 'nonce', 'calls', 'fee'])('rejects a changed %s before consent or wallet signing', async kind => {
    const { session, quote, provider, approve } = setup()
    const typed = structuredClone(batchTypedData(quote.withdrawal, settings))
    if (kind === 'chain') typed.domain!.chainId = 11155111
    if (kind === 'entrypoint') typed.domain!.verifyingContract = recipient
    if (kind === 'schema') typed.types = { ...typed.types, Unknown: [] } as typeof typed.types
    if (kind === 'factory') typed.message.initCode = '0x1234'
    if (kind === 'sender') typed.message.sender = SIMPLE_7702_IMPLEMENTATION
    if (kind === 'paymaster') typed.message.paymasterAndData = `0x${'00'.repeat(20)}${typed.message.paymasterAndData.slice(42)}`
    if (kind === 'nonce') typed.message.nonce = 1n
    if (kind === 'calls') typed.message.callData = '0x'
    if (kind === 'fee') typed.message.gasFees = `0x${'ff'.repeat(16)}${'00'.repeat(16)}` as Hex
    await expect(session.signer.signTypedData(typed)).rejects.toThrow()
    expect(approve).not.toHaveBeenCalled(); expect(signMethods(provider)).toHaveLength(0)
  })
  it('rejects an altered authorization target, network or nonce before prompting', async () => {
    const { session, provider, approve } = setup()
    for (const request of [{ ...authorization, address: recipient }, { ...authorization, chainId: 11155111 }, { ...authorization, nonce: 1 }]) {
      await expect(session.signer.signAuthorization(request)).rejects.toThrow('Unexpected receiver delegation')
    }
    expect(approve).not.toHaveBeenCalled(); expect(signMethods(provider)).toHaveLength(0)
  })
  it('shows the native gas budget separately from the proof-bound token fee', () => {
    const { quote } = fixture(3, 'usdc')
    const review = validateBatchSigningRequest(batchTypedData(quote.withdrawal, settings), quote.notes, recipient, settings)
    expect(review.fee).toBe(quote.fee); expect(review.net).toBe(quote.net)
    expect(review.maxGasCost).toBe(3n * 0x100000n)
  })
})
