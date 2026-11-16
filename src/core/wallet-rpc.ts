import type { WalletProvider } from './wallet'

export const READ_RPC_METHODS = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getLogs', 'eth_call', 'eth_estimateGas',
  'eth_getBalance', 'eth_getCode', 'eth_getTransactionCount', 'eth_getStorageAt',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionReceipt', 'eth_getTransactionByHash',
  'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
])
type Request = { method: string; params?: unknown[] | object }
export interface ReadRpc { request(args: Request): Promise<unknown>; dispose(): void }
let current: { provider: WalletProvider; chainId: number; detach: () => void } | undefined

/** No permissions, network switches, signing or sends are requested here. */
export function setWalletRpcSource(provider: WalletProvider | null, chainId: number | null) {
  if (current?.provider === provider && current?.chainId === chainId) return
  current?.detach(); current = undefined
  if (!provider || !chainId) return
  const source = { provider, chainId, detach: () => {} }
  const changed = (...args: unknown[]) => {
    try { if (BigInt(args[0] as string) === BigInt(chainId)) return } catch { /* malformed chain event */ }
    if (current === source) { source.detach(); current = undefined }
  }
  const disconnected = () => { if (current === source) { source.detach(); current = undefined } }
  provider.on?.('chainChanged', changed); provider.on?.('disconnect', disconnected)
  source.detach = () => { provider.removeListener?.('chainChanged', changed); provider.removeListener?.('disconnect', disconnected) }
  current = source
}

export function walletRpcFor(chainId: number): ReadRpc | undefined {
  const source = current
  if (!source || source.chainId !== chainId) return
  let disposed = false
  return {
    dispose() { disposed = true },
    async request(args) {
      if (!READ_RPC_METHODS.has(args.method)) throw new Error('Only chain-read methods are allowed through the wallet RPC bridge.')
      let timedOut = false, timer: ReturnType<typeof setTimeout> | undefined
      const active = () => { if (disposed || timedOut || current !== source) throw new Error('The wallet RPC context changed.') }
      const payload = structuredClone(args)
      try {
        return await Promise.race([
          (async () => {
            active()
            if (BigInt(await source.provider.request({ method: 'eth_chainId' }) as string) !== BigInt(chainId)) throw new Error('Wallet RPC network mismatch.')
            active()
            if (payload.method === 'eth_chainId') return `0x${chainId.toString(16)}`
            const result = await source.provider.request(payload)
            active()
            if (BigInt(await source.provider.request({ method: 'eth_chainId' }) as string) !== BigInt(chainId)) throw new Error('Wallet RPC network changed during the read.')
            active()
            return result
          })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('Wallet RPC read timed out.')) }, 20_000) }),
        ])
      } finally { clearTimeout(timer) }
    },
  }
}

/** The proof iframe gets only a read capability, separate from signing. */
export function walletRpcBridge(port: MessagePort, chainId: number) {
  const source = walletRpcFor(chainId)
  let closed = false, nextId = 1
  return {
    enabled: Boolean(source),
    dispose() { closed = true; source?.dispose() },
    async handle(data: { status?: string; id?: number; method?: string; params?: unknown[] }) {
      if (data.status !== 'read-rpc') return false
      const id = data.id
      try {
        if (closed || !source || id !== nextId++ || !data.method || data.params !== undefined && !Array.isArray(data.params)) throw new Error('Invalid wallet read request')
        const result = await source.request({ method: data.method, params: data.params })
        if (!closed) port.postMessage({ status: 'read-rpc-result', id, result })
      } catch {
        if (!closed) port.postMessage({ status: 'read-rpc-result', id, error: 'Wallet RPC unavailable for this read. Use the configured RPC fallback.' })
      }
      return true
    },
  }
}

export function walletRpcOverPort(port: MessagePort): ReadRpc {
  let nextId = 0, disposed = false
  const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const receive = ({ data }: MessageEvent) => {
    if (data?.status !== 'read-rpc-result') return
    const request = pending.get(data.id)
    if (!request) return
    clearTimeout(request.timer); pending.delete(data.id)
    if (data.error) request.reject(new Error('Wallet RPC read unavailable.'))
    else request.resolve(data.result)
  }
  port.addEventListener('message', receive); port.start()
  return {
    dispose() {
      disposed = true; port.removeEventListener('message', receive)
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Wallet RPC session closed.')) }
      pending.clear()
    },
    request(args) {
      if (disposed || !READ_RPC_METHODS.has(args.method)) return Promise.reject(new Error('Invalid wallet RPC read.'))
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Wallet RPC bridge timed out.')) }, 25_000)
        pending.set(id, { resolve, reject, timer })
        port.postMessage({ status: 'read-rpc', id, ...args })
      })
    },
  }
}
