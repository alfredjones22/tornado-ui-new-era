import { TornadoPaymasterConfigs } from '@kohaku-eth/tornado-cash'
import { createPublicClient, custom, fallback, http, type Address } from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import type { ChainId } from './catalog'
import { walletRpcFor, type ReadRpc } from './wallet-rpc'
import type { DataSources } from './data-sources'

export type BundlerKind = 'pimlico' | 'custom'
export interface ConnectionSettings extends DataSources { chainId: ChainId; rpcUrl: string; bundler: BundlerKind; bundlerUrl: string }
export function checkedUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Enter a complete RPC URL.') }
  if (url.username || url.password) throw new Error('Use an endpoint without HTTP basic-auth credentials.')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use HTTPS, or a local HTTP endpoint.')
  }
  return url.toString()
}
export function checkedSourceUrl(value: string): string {
  const url = new URL(checkedUrl(value))
  if (url.search || url.hash) throw new Error('History and artifact base URLs must not include a query or fragment.')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.href
}
export const publicClientFor = (settings: Pick<ConnectionSettings, 'chainId' | 'rpcUrl'>, wallet: ReadRpc | undefined = walletRpcFor(settings.chainId), minimumBlock = 0n) => {
  const chain = settings.chainId === 1 ? mainnet : sepolia
  const configured = http(checkedUrl(settings.rpcUrl), { retryCount: 0, timeout: 30_000 })
  if (!wallet) return createPublicClient({ chain, transport: configured })
  const direct = createPublicClient({ chain, transport: configured })
  let verified: Promise<void> | undefined
  let walletBehind = false
  const preferred = custom({ request: async args => {
    if (walletBehind) throw new Error('Wallet RPC is behind the verified history checkpoint.')
    const result = await wallet.request(args)
    const head = args.method === 'eth_blockNumber' ? result : args.method === 'eth_getBlockByNumber' && args.params?.[0] === 'latest'
      ? (result as { number?: string } | null)?.number : undefined
    if (head !== undefined && BigInt(head as string) < minimumBlock) {
      walletBehind = true
      throw new Error('Wallet RPC is behind the verified history checkpoint.')
    }
    return result
  } }, { retryCount: 0 })
  // Wallet validation must not accidentally bless a misconfigured HTTP fallback.
  // Validate that endpoint lazily, so a dead HTTP RPC cannot block a healthy wallet.
  const checkedFallback = custom({ request: async args => {
    await (verified ??= direct.getChainId().then(actual => {
      if (actual !== settings.chainId) throw new Error('The fallback RPC endpoint is on a different network.')
    }))
    if (args.method === 'eth_chainId') return `0x${settings.chainId.toString(16)}`
    return direct.request(args)
  } }, { retryCount: 0 })
  return createPublicClient({ chain,
    transport: fallback([preferred, checkedFallback], { retryCount: 0, rank: false, shouldThrow: () => false }),
  })
}

/** Preserve structured error evidence for simulation classification. Callers must
 * show safeError(), never log the error data (which can contain call payloads). */
export class EndpointRpcError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, readonly data: unknown, message: string) { super(message); this.name = 'EndpointRpcError' }
}
export class EndpointTransportError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'EndpointTransportError' }
}
export async function jsonRpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  let response: Response
  try {
    response = await fetch(checkedUrl(url), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(45_000), credentials: 'omit', referrerPolicy: 'no-referrer' })
  } catch { throw new EndpointTransportError(`${method} could not reach the configured endpoint.`) }
  if (!response.ok) throw new EndpointTransportError(`${method} returned HTTP ${response.status}.`, response.status)
  const body = await response.json()
  if (body.error) throw new EndpointRpcError(method, typeof body.error.code === 'number' ? body.error.code : undefined, body.error.data,
    `${method} was rejected by the endpoint: ${safeError(body.error)}`)
  if (!Object.hasOwn(body, 'result')) throw new Error(`${method} returned an invalid response.`)
  return body.result as T
}
export async function validateConnections(settings: ConnectionSettings, withBundler = true) {
  const chain = await publicClientFor(settings).getChainId()
  if (chain !== settings.chainId) throw new Error('The RPC endpoint is on a different network.')
  if (!withBundler) return
  const [bundlerChain, entryPoints] = await Promise.all([
    jsonRpc<string>(settings.bundlerUrl, 'eth_chainId'),
    jsonRpc<Address[]>(settings.bundlerUrl, 'eth_supportedEntryPoints'),
  ])
  if (Number(BigInt(bundlerChain)) !== settings.chainId) throw new Error('The bundler is on a different network.')
  const expected = TornadoPaymasterConfigs[settings.chainId].entryPointAddress.toLowerCase()
  if (!entryPoints.some(p => p.toLowerCase() === expected)) throw new Error('This bundler does not advertise the required EntryPoint v0.8.')
}

/** SDK alpha.36 asks for Pimlico's fee oracle even on other bundlers.
 * Adapt only that read to standard chain fee estimation for Custom endpoints;
 * all estimation and submission still go to the selected bundler.
 */
export function sdkNetwork(settings: ConnectionSettings, wallet?: ReadRpc, minimumBlock = 0n) {
  return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    if (String(input) === settings.bundlerUrl && body?.method === 'pimlico_getUserOperationGasPrice' && settings.bundler !== 'pimlico') {
      const fees = await publicClientFor(settings, wallet, minimumBlock).estimateFeesPerGas()
      const tier = { maxFeePerGas: `0x${fees.maxFeePerGas.toString(16)}`, maxPriorityFeePerGas: `0x${fees.maxPriorityFeePerGas.toString(16)}` }
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { slow: tier, standard: tier, fast: tier } })
    }
    const response = await fetch(input, { ...init, signal: AbortSignal.timeout(180_000), credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (String(input) === settings.bundlerUrl) {
      // Log only the method and sanitized response reason, never the signed
      // UserOperation, proof, request body or endpoint (which may contain a key).
      const method = ['pimlico_getUserOperationGasPrice', 'eth_estimateUserOperationGas', 'eth_sendUserOperation'].includes(body?.method) ? body.method : 'RPC request'
      if (!response.ok) console.warn(`[Tornado bundler] ${method} returned HTTP ${response.status}.`)
      else {
        const result = await response.clone().json().catch(() => null)
        if (result?.error) console.warn(`[Tornado bundler] ${method}: ${safeError(result.error)}`)
      }
    }
    return response
  } }
}

/** Do not expose provider errors containing note strings or endpoint credentials. */
export function safeError(error: unknown): string {
  // Redux thunks serialize SDK failures to { name, message, code, stack }.
  // Comlink preserves that plain object, so instanceof Error loses the reason.
  // Read only message fields, never stringify an error's request/data/stack.
  const seen = new Set<unknown>()
  const describe = (value: unknown, depth = 0): string => {
    if (typeof value === 'string') return value.trim()
    if (!value || typeof value !== 'object' || depth > 3 || seen.has(value)) return ''
    seen.add(value)
    const detail = value as { shortMessage?: unknown; message?: unknown; details?: unknown; code?: unknown; cause?: unknown }
    const summary = typeof detail.shortMessage === 'string' ? detail.shortMessage : typeof detail.message === 'string' ? detail.message : ''
    const details = typeof detail.details === 'string' && !summary.includes(detail.details) ? detail.details : ''
    const reason = [summary.trim(), details.trim()].filter(Boolean).join(' ')
    const code = (typeof detail.code === 'number' || typeof detail.code === 'string' && /^-?\d+$/.test(detail.code)) && !reason.includes(`(code ${detail.code})`) ? ` (code ${detail.code})` : ''
    return reason ? reason + code : describe(detail.cause, depth + 1)
  }
  const message = describe(error) || 'The operation failed. Please try again.'
  return message.replace(/tornado-[a-zA-Z0-9]+-[\d.]+-\d+-0x[\da-fA-F]+/g, '[private note]')
    .replace(/(?:0x)?[\da-fA-F]{64,}/g, '[redacted hex data]')
    .replace(/^\s*(?:Request body|Request Arguments|Raw Call Arguments):[^\n]*/gim, '[request data omitted]')
    .replace(/https?:\/\/[^\s)"']+/g, '[endpoint]').slice(0, 450)
}
