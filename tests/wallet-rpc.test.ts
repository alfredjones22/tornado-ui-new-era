import { afterEach, describe, expect, it, vi } from 'vitest'
import { publicClientFor, validateConnections } from '../src/core/rpc'
import { TornadoPaymasterConfigs } from '@kohaku-eth/tornado-cash'
import { setWalletRpcSource, walletRpcBridge, walletRpcFor, walletRpcOverPort } from '../src/core/wallet-rpc'
import type { WalletProvider } from '../src/core/wallet'

const settings = { chainId: 1 as const, rpcUrl: 'https://rpc.example', bundlerUrl: 'https://bundler.example', bundler: 'pimlico' as const }
afterEach(() => { setWalletRpcSource(null, null); vi.useRealTimers(); vi.unstubAllGlobals() })
function wallet(read: (args: { method: string; params?: unknown[] | object }) => Promise<unknown> = async () => '0x123') {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const provider: WalletProvider = {
    request: vi.fn(async args => args.method === 'eth_chainId' ? '0x1' : read(args)),
    on: (event, listener) => { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set) },
    removeListener: (event, listener) => { listeners.get(event)?.delete(listener) },
  }
  return { provider, emit: (event: string, value?: unknown) => { for (const listener of [...listeners.get(event) ?? []]) listener(value) } }
}
describe('wallet chain reads', () => {
  it('prefers the selected wallet without asking for accounts, signatures, sends or network switches', async () => {
    const { provider } = wallet(), fetcher = vi.fn()
    setWalletRpcSource(provider, 1); vi.stubGlobal('fetch', fetcher)
    expect(await publicClientFor(settings).getBlockNumber()).toBe(0x123n)
    expect(fetcher).not.toHaveBeenCalled()
    expect(vi.mocked(provider.request).mock.calls.map(([args]) => args.method)).toEqual(['eth_chainId', 'eth_blockNumber', 'eth_chainId'])
  })
  it('uses the configured RPC when no wallet matches the requested network', async () => {
    const { provider } = wallet()
    setWalletRpcSource(provider, 11155111)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ result: '0x456' })))
    expect(await publicClientFor(settings).getBlockNumber()).toBe(0x456n)
    expect(provider.request).not.toHaveBeenCalled()
  })
  it('falls back to the configured RPC when the wallet rejects historical log queries', async () => {
    const { provider } = wallet(async () => { throw Object.assign(new Error('Unsupported method'), { code: -32601 }) })
    setWalletRpcSource(provider, 1)
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json({ result: JSON.parse(init!.body as string).method === 'eth_chainId' ? '0x1' : [] }))
    vi.stubGlobal('fetch', fetcher)
    expect(await publicClientFor(settings).getLogs({ address: '0x1111111111111111111111111111111111111111', fromBlock: 1n, toBlock: 2n })).toEqual([])
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(init!.body as string).method)).toEqual(['eth_chainId', 'eth_getLogs'])
  })
  it('refuses a wrong-network HTTP fallback even when the connected wallet validated successfully', async () => {
    const { provider } = wallet(async () => { throw new Error('Wallet log history unavailable') })
    setWalletRpcSource(provider, 1)
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ result: '0xaa36a7' }))
    vi.stubGlobal('fetch', fetcher)
    await expect(publicClientFor(settings).getLogs({ fromBlock: 1n, toBlock: 2n })).rejects.toThrow('different network')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('uses the HTTP fallback for the rest of a session when the wallet is behind its verified snapshot', async () => {
    const { provider } = wallet(async () => '0x1')
    setWalletRpcSource(provider, 1)
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const { method } = JSON.parse(init!.body as string)
      return Response.json({ result: method === 'eth_chainId' ? '0x1' : method === 'eth_blockNumber' ? '0x200' : [] })
    })
    vi.stubGlobal('fetch', fetcher)
    const client = publicClientFor(settings, walletRpcFor(1), 100n)
    expect(await client.getBlockNumber()).toBe(512n)
    expect(await client.getLogs({ fromBlock: 100n, toBlock: 110n })).toEqual([])
    expect(vi.mocked(provider.request).mock.calls.some(([args]) => args.method === 'eth_getLogs')).toBe(false)
  })
  it('can validate preparation with a working wallet RPC when the configured endpoint is offline', async () => {
    const { provider } = wallet()
    setWalletRpcSource(provider, 1)
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith(settings.rpcUrl)) throw new Error('Configured RPC offline')
      const { method } = JSON.parse(init!.body as string)
      return Response.json({ result: method === 'eth_supportedEntryPoints' ? [TornadoPaymasterConfigs[1].entryPointAddress] : '0x1' })
    })
    vi.stubGlobal('fetch', fetcher)
    await expect(validateConnections(settings)).resolves.toBeUndefined()
    expect(fetcher.mock.calls.every(([url]) => String(url) === settings.bundlerUrl + '/')).toBe(true)
  })
  it.each(['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'eth_requestAccounts'])('rejects %s before calling the wallet', async method => {
    const { provider } = wallet(); setWalletRpcSource(provider, 1)
    await expect(walletRpcFor(1)!.request({ method })).rejects.toThrow('Only chain-read')
    expect(provider.request).not.toHaveBeenCalled()
  })
  it('rejects a late read if the wallet changed chains away and back during the request', async () => {
    let finish!: (value: unknown) => void
    const { provider, emit } = wallet(() => new Promise(resolve => { finish = resolve }))
    setWalletRpcSource(provider, 1)
    const pending = walletRpcFor(1)!.request({ method: 'eth_getLogs', params: [] })
    const rejected = expect(pending).rejects.toThrow('context changed')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    emit('chainChanged', '0xaa36a7'); emit('chainChanged', '0x1'); setWalletRpcSource(provider, 1)
    finish([]); await rejected
  })
  it('bounds unavailable wallet reads without starting a late RPC request after timeout', async () => {
    vi.useFakeTimers()
    let finish!: (value: unknown) => void
    const { provider } = wallet()
    vi.mocked(provider.request).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    setWalletRpcSource(provider, 1)
    const request = walletRpcFor(1)!.request({ method: 'eth_getLogs' })
    const rejected = expect(request).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(20_001); await rejected
    finish('0x1'); await Promise.resolve(); await Promise.resolve()
    expect(provider.request).toHaveBeenCalledOnce()
  })
  it('bridges read-only requests to the proof iframe and disposes pending work', async () => {
    const { provider } = wallet(); setWalletRpcSource(provider, 1)
    const channel = new MessageChannel(), bridge = walletRpcBridge(channel.port1, 1), client = walletRpcOverPort(channel.port2)
    channel.port1.onmessage = ({ data }) => { void bridge.handle(data) }
    try {
      expect(bridge.enabled).toBe(true)
      expect(await client.request({ method: 'eth_blockNumber' })).toBe('0x123')
      await expect(client.request({ method: 'eth_sendTransaction' })).rejects.toThrow('Invalid')
      const pending = client.request({ method: 'eth_getLogs' })
      const rejected = expect(pending).rejects.toThrow('closed')
      client.dispose(); await rejected
    } finally { client.dispose(); bridge.dispose(); channel.port1.close(); channel.port2.close() }
  })
  it('rejects a forged signing request over the port without invoking the provider', async () => {
    const { provider } = wallet(); setWalletRpcSource(provider, 1)
    const channel = new MessageChannel(), bridge = walletRpcBridge(channel.port1, 1)
    try {
      const reply = new Promise<MessageEvent>(resolve => { channel.port2.onmessage = resolve })
      await bridge.handle({ status: 'read-rpc', id: 1, method: 'eth_signTypedData_v4', params: [] })
      expect((await reply).data.error).toContain('unavailable')
      expect(provider.request).not.toHaveBeenCalled()
    } finally { bridge.dispose(); channel.port1.close(); channel.port2.close() }
  })
})
