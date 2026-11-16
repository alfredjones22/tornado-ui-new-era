import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareWithdrawal } from '../src/core/withdrawals'
import { prepareRelayerWithdrawal } from '../src/core/relayers'
import { validateConnections } from '../src/core/rpc'
import type { ConnectionSettings } from '../src/core/rpc'
import { setWalletRpcSource } from '../src/core/wallet-rpc'
vi.mock('../src/core/rpc', async original => ({ ...await original<object>(), validateConnections: vi.fn() }))
const settings: ConnectionSettings = { chainId: 11155111, rpcUrl: 'https://example.com', bundlerUrl: 'https://bundler.example.com', bundler: 'pimlico' }
const input = `tornado-eth-1-11155111-0x${'ab'.repeat(62)}`
const recipient = '0x1111111111111111111111111111111111111111'
const ports: MessagePort[] = []
beforeEach(() => { vi.clearAllMocks(); vi.mocked(validateConnections).mockResolvedValue(undefined); vi.stubGlobal('location', new URL('http://localhost:5173')) })
afterEach(() => { setWalletRpcSource(null, null); ports.splice(0).forEach(port => port.close()); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
function localFrame(script: (port: MessagePort) => void) {
  let child: MessagePort | undefined
  const frame = { hidden: false, title: '', src: '', onload: () => {}, onerror: () => {}, remove: vi.fn(() => child?.close()),
    contentWindow: { postMessage: vi.fn((_payload, _origin, transferred: MessagePort[]) => { child = transferred[0]!; ports.push(child); script(child) }) } }
  vi.stubGlobal('document', { createElement: () => frame, body: { append: () => queueMicrotask(() => frame.onload()) } })
  return frame
}

describe('single-note preparation failures', () => {
  it('passes custom or disabled data sources into the isolated preparation frame', async () => {
    const configured: ConnectionSettings = { ...settings, sagaUrl: 'https://mirror.example/sepolia/', artifactsUrl: null }
    const frame = localFrame(port => port.postMessage({ status: 'error', message: 'Synthetic preparation stopped' }))
    await expect(prepareWithdrawal(input, recipient, configured, vi.fn())).rejects.toThrow('Synthetic preparation stopped')
    expect(frame.contentWindow.postMessage.mock.calls[0]![0].settings).toEqual(configured)
  })
  it('keeps a long RPC-only scan alive while it is reporting progress', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let child!: MessagePort
    const frame = localFrame(port => { child = port })
    const request = prepareWithdrawal(input, recipient, settings, vi.fn())
    const rejected = expect(request).rejects.toThrow('Synthetic scan finished')
    await new Promise(resolve => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(590_000)
    child.postMessage({ status: 'progress', message: 'Syncing pool history…' })
    await new Promise(resolve => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(frame.remove).not.toHaveBeenCalled()
    child.postMessage({ status: 'error', message: 'Synthetic scan finished' })
    await rejected
  })
  it('provides wallet chain reads to the isolated frame without sharing a signing capability', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => method === 'eth_chainId' ? '0xaa36a7' : '0x123')
    setWalletRpcSource({ request }, 11155111)
    const frame = localFrame(port => {
      port.onmessage = ({ data }) => {
        if (data.status === 'read-rpc-result') {
          expect(data.result).toBe('0x123')
          port.postMessage({ status: 'error', message: 'Synthetic note checked after a wallet read' })
        }
      }
      port.postMessage({ status: 'read-rpc', id: 1, method: 'eth_blockNumber' })
    })
    await expect(prepareWithdrawal(input, recipient, settings, vi.fn())).rejects.toThrow('Synthetic note checked')
    expect(frame.contentWindow.postMessage.mock.calls[0]![0].walletRpc).toBe(true)
    expect(request.mock.calls.every(([args]) => ['eth_chainId', 'eth_blockNumber'].includes(args.method))).toBe(true)
  })
  it('loads and hands off to the proof frame beneath an IPFS gateway prefix', async () => {
    vi.stubGlobal('location', new URL('https://gateway.example/ipfs/bafy-test/index.html#withdraw'))
    vi.stubEnv('BASE_URL', './')
    const frame = localFrame(port => port.postMessage({ status: 'error', message: 'Synthetic missing note' }))
    await expect(prepareWithdrawal(input, recipient, settings, vi.fn())).rejects.toThrow('Synthetic missing note')
    expect(frame.src).toBe('https://gateway.example/ipfs/bafy-test/withdraw-frame.html')
    expect(frame.contentWindow.postMessage.mock.calls[0]![1]).toBe('https://gateway.example')
    expect(frame.remove).toHaveBeenCalledOnce()
  })
  it('forwards sync progress and a missing-note failure, removing the proof frame', async () => {
    const progress = vi.fn()
    const frame = localFrame(port => {
      port.postMessage({ status: 'progress', message: 'Syncing pool history…' })
      port.postMessage({ status: 'error', message: 'No matching deposit was found in the synced pool history.' })
    })
    await expect(prepareWithdrawal(input, recipient, settings, progress)).rejects.toThrow('No matching deposit')
    expect(progress).toHaveBeenCalledWith('Syncing pool history…')
    expect(frame.remove).toHaveBeenCalledOnce()
  })
  it('reports a synchronous frame handoff failure instead of silently waiting', async () => {
    const frame = localFrame(() => { throw new DOMException('Could not be cloned', 'DataCloneError') })
    await expect(prepareWithdrawal(input, recipient, settings, vi.fn())).rejects.toThrow('Could not start the local proof session')
    expect(frame.remove).toHaveBeenCalledOnce()
  })
  it('reports a frame load failure and closes its channel', async () => {
    const frame = localFrame(() => {})
    vi.stubGlobal('document', { createElement: () => frame, body: { append: () => queueMicrotask(() => frame.onerror()) } })
    await expect(prepareWithdrawal(input, recipient, settings, vi.fn())).rejects.toThrow('Could not load the local proof session')
    expect(frame.remove).toHaveBeenCalledOnce()
  })
  it('prepares Classic relayers through the isolated frame without requiring a bundler connection', async () => {
    const frame = localFrame(port => port.postMessage({ status: 'error', message: 'No registered relayer supports this pool.' }))
    await expect(prepareRelayerWithdrawal(input, recipient, settings, vi.fn())).rejects.toThrow('No registered relayer')
    expect(validateConnections).toHaveBeenCalledWith(settings, false)
    expect(frame.contentWindow.postMessage.mock.calls[0]![0]).toMatchObject({ type: 'tornado-prepare', route: 'relayer' })
    expect(frame.remove).toHaveBeenCalledOnce()
  })
  it('rejects multi-note input in the Classic route before any connection or proof request', async () => {
    await expect(prepareRelayerWithdrawal(`${input}\n${input}`, recipient, settings, vi.fn())).rejects.toThrow('one note at a time')
    expect(validateConnections).not.toHaveBeenCalled()
  })
  it.each([
    ...['0.01', '0.03', '0.3', '3', '30'].map(d => [1, d] as const),
    ...['0.01', '0.03', '0.3', '3', '10', '30'].map(d => [11155111, d] as const),
  ])('rejects the newer %s / %s ETH pool before any connection or proof request', async (chainId, denomination) => {
    const frame = localFrame(() => {})
    const note = `tornado-eth-${denomination}-${chainId}-0x${'ab'.repeat(62)}`
    await expect(prepareRelayerWithdrawal(note, recipient, { ...settings, chainId }, vi.fn())).rejects.toThrow('only support the original pools')
    expect(validateConnections).not.toHaveBeenCalled()
    expect(frame.contentWindow.postMessage).not.toHaveBeenCalled()
  })
})
