import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toHex } from 'viem'
import { batchTypedData, SIMPLE_7702_IMPLEMENTATION } from '../src/core/batch-policy'
import { prepareMultiWithdrawal } from '../src/core/multi-withdrawal'
import { publicClientFor, validateConnections } from '../src/core/rpc'
import type { WalletProvider } from '../src/core/wallet'
import { fixture, recipient, settings, signingAccount } from './fixtures/multi-withdrawal'

vi.mock('../src/core/rpc', async original => ({ ...await original<object>(), validateConnections: vi.fn(), publicClientFor: vi.fn() }))
const ports: MessagePort[] = []
afterEach(() => { ports.splice(0).forEach(port => port.close()); vi.unstubAllGlobals() })
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(publicClientFor).mockReturnValue({ getTransactionCount: async () => 0, readContract: async () => 0n, getCode: async () => '0x' } as unknown as ReturnType<typeof publicClientFor>)
  vi.mocked(validateConnections).mockResolvedValue(undefined)
  vi.stubGlobal('location', new URL('http://localhost:5173'))
})
function browserWallet(): WalletProvider {
  return { request: vi.fn(async ({ method, params }) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_accounts') return [recipient]
    if (method === 'wallet_signAuthorization') return signingAccount.signAuthorization({ address: SIMPLE_7702_IMPLEMENTATION, chainId: 1, nonce: 0 })
    if (method === 'eth_signTypedData_v4') return signingAccount.signTypedData(JSON.parse((params as string[])[1]!))
    throw new Error('Unexpected method')
  }) }
}
function localFrame(script: (payload: Record<string, unknown>, port: MessagePort) => void) {
  let child: MessagePort | undefined
  const frame = { hidden: false, title: '', src: '', onload: () => {}, onerror: () => {}, remove: vi.fn(() => child?.close()),
    contentWindow: { postMessage: vi.fn((payload, _origin, transferred: MessagePort[]) => { child = transferred[0]!; ports.push(child); script(payload, child) }) } }
  vi.stubGlobal('document', { createElement: () => frame, body: { append: () => queueMicrotask(() => frame.onload()) } })
  return frame
}
function sign(port: MessagePort, id: number, method: string, request: unknown) {
  return new Promise<unknown>(resolve => {
    port.onmessage = ({ data }) => resolve(data.result)
    port.postMessage({ status: 'sign', id, method, request })
  })
}

describe('disposable SDK frame and wallet bridge', () => {
  it('bridges only signing callbacks and returns one final wallet-approved operation for twelve notes', async () => {
    const { quote } = fixture(12), provider = browserWallet()
    const approve = vi.fn(async () => {})
    const frame = localFrame((payload, port) => {
      expect(payload.recipient).toBe(recipient)
      expect(payload).not.toHaveProperty('privateKey')
      void (async () => {
        const signed = await sign(port, 1, 'signAuthorization', { address: SIMPLE_7702_IMPLEMENTATION, chainId: 1, nonce: 0 }) as Awaited<ReturnType<typeof signingAccount.signAuthorization>>
        quote.withdrawal.userOperation.eip7702Auth = { ...signed, chainId: toHex(signed.chainId), nonce: toHex(signed.nonce), yParity: toHex(signed.yParity!) }
        quote.withdrawal.userOperation.signature = await sign(port, 2, 'signTypedData', batchTypedData(quote.withdrawal, settings)) as `0x${string}`
        port.postMessage({ status: 'ready', withdrawal: quote.withdrawal })
      })()
    })
    const result = await prepareMultiWithdrawal(quote.notes.map(note => note.raw).join('\n'), { provider, account: recipient }, settings, vi.fn(), approve)
    expect(result.notes).toHaveLength(12)
    expect(result.signedHash).toBe(quote.signedHash)
    expect(frame.remove).toHaveBeenCalledTimes(1)
    expect(approve.mock.calls).toHaveLength(2)
    expect(vi.mocked(provider.request).mock.calls.filter(([request]) => request.method === 'eth_sendUserOperation')).toHaveLength(0)
  })
  it('rejects an unscoped signing method and removes the frame', async () => {
    const { quote } = fixture(), provider = browserWallet()
    const frame = localFrame((_payload, port) => port.postMessage({ status: 'sign', id: 1, method: 'eth_sendTransaction', request: {} }))
    await expect(prepareMultiWithdrawal(quote.notes.map(note => note.raw).join('\n'), { provider, account: recipient }, settings, vi.fn(), vi.fn())).rejects.toThrow('Unexpected wallet signing request')
    expect(frame.remove).toHaveBeenCalledTimes(1)
    expect(vi.mocked(provider.request).mock.calls.some(([request]) => request.method === 'eth_sendTransaction')).toBe(false)
  })
  it('removes the frame on cancellation and never forwards a late signature', async () => {
    const { quote } = fixture(), provider = browserWallet(), controller = new AbortController()
    const approve = vi.fn(async () => { controller.abort() })
    const frame = localFrame((_payload, port) => port.postMessage({ status: 'sign', id: 1, method: 'signTypedData', request: batchTypedData(quote.withdrawal, settings) }))
    const error = await prepareMultiWithdrawal(quote.notes.map(note => note.raw).join('\n'), { provider, account: recipient }, settings, vi.fn(), approve, controller.signal).catch(error => error as Error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Batch preparation was cancelled.')
    expect(frame.remove).toHaveBeenCalledTimes(1)
    expect(vi.mocked(provider.request).mock.calls.some(([request]) => request.method === 'eth_signTypedData_v4')).toBe(false)
  })
  it('preserves the actual cancellation reason before any wallet request', async () => {
    const { quote } = fixture(), provider = browserWallet(), controller = new AbortController()
    const approve = vi.fn(async () => { controller.abort(new Error('The receiver wallet account changed. Prepare a new batch.')) })
    localFrame((_payload, port) => port.postMessage({ status: 'sign', id: 1, method: 'signAuthorization', request: { address: SIMPLE_7702_IMPLEMENTATION, chainId: 1, nonce: 0 } }))
    await expect(prepareMultiWithdrawal(quote.notes.map(note => note.raw).join('\n'), { provider, account: recipient }, settings, vi.fn(), approve, controller.signal)).rejects.toThrow('The receiver wallet account changed.')
    expect(vi.mocked(provider.request).mock.calls.some(([request]) => /sign/i.test(request.method))).toBe(false)
  })
  it('adds the executable-candidate warning after a UserOperation signature was shared', async () => {
    const { quote } = fixture(), provider = browserWallet(), controller = new AbortController()
    localFrame((_payload, port) => {
      void sign(port, 1, 'signTypedData', batchTypedData(quote.withdrawal, settings)).then(() => controller.abort(new Error('The network changed. Prepare a new batch.')))
    })
    await expect(prepareMultiWithdrawal(quote.notes.map(note => note.raw).join('\n'), { provider, account: recipient }, settings, vi.fn(), vi.fn(async () => {}), controller.signal)).rejects.toThrow('The network changed. Prepare a new batch. A signed UserOperation may still be executable')
    expect(vi.mocked(provider.request).mock.calls.filter(([request]) => request.method === 'eth_signTypedData_v4')).toHaveLength(1)
    expect(vi.mocked(provider.request).mock.calls.some(([request]) => request.method === 'eth_sendUserOperation')).toBe(false)
  })
  it('surfaces immediate unsupported authorization errors without replacing them with cancellation', async () => {
    const { quote } = fixture(), provider = browserWallet(), original = provider.request
    provider.request = vi.fn(async args => {
      if (args.method === 'wallet_signAuthorization') throw { code: -32601 }
      return original(args)
    })
    localFrame((_payload, port) => port.postMessage({ status: 'sign', id: 1, method: 'signAuthorization', request: { address: SIMPLE_7702_IMPLEMENTATION, chainId: 1, nonce: 0 } }))
    await expect(prepareMultiWithdrawal(quote.notes.map(note => note.raw).join('\n'), { provider, account: recipient }, settings, vi.fn(), vi.fn(async () => {}))).rejects.toThrow('wallet_signAuthorization (code -32601)')
  })
  it('preserves a wallet rejection and the candidate warning after an earlier signature was shared', async () => {
    const { quote } = fixture(), provider = browserWallet(), original = provider.request
    let requests = 0
    provider.request = vi.fn(async args => {
      if (args.method === 'eth_signTypedData_v4' && ++requests === 2) throw { code: 4001, message: 'User rejected' }
      return original(args)
    })
    localFrame((_payload, port) => {
      void sign(port, 1, 'signTypedData', batchTypedData(quote.withdrawal, settings)).then(() => {
        port.postMessage({ status: 'sign', id: 2, method: 'signTypedData', request: batchTypedData(quote.withdrawal, settings) })
      })
    })
    const error = await prepareMultiWithdrawal(quote.notes.map(note => note.raw).join('\n'), { provider, account: recipient }, settings, vi.fn(), vi.fn(async () => {})).catch(error => error as Error)
    expect((error as Error).message).toMatch(/rejected/i)
    expect((error as Error).message).toContain('A signed UserOperation may still be executable')
    expect(requests).toBe(2)
  })
  it('rejects an unsigned ready payload from the proof frame', async () => {
    const { quote } = fixture()
    localFrame((_payload, port) => port.postMessage({ status: 'ready', withdrawal: quote.withdrawal }))
    await expect(prepareMultiWithdrawal(quote.notes.map(note => note.raw).join('\n'), { provider: browserWallet(), account: recipient }, settings, vi.fn(), vi.fn())).rejects.toThrow('differs from the last wallet-approved')
  })
})
