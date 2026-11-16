import { encodeFunctionData, erc20Abi, isAddress, toHex, type Address, type Hash, type Hex } from 'viem'
import type { DepositNote } from './notes'
import { poolAbi } from './notes'
import { publicClientFor, validateConnections, type ConnectionSettings } from './rpc'

export interface WalletProvider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}
export interface WalletOption { id: string; name: string; provider: WalletProvider }
export type ProgressStatus = 'ready' | 'awaiting-wallet' | 'submitted' | 'confirmed' | 'failed' | 'rejected' | 'unknown'
export interface Progress { id: string; label: string; status: ProgressStatus; hash?: Hex; transactionHash?: Hex; batchId?: string; depositBatch?: number; relayerJobId?: string; message?: string }
export type DepositMode = 'auto' | 'sequential'
export type Update = (id: string, patch: Partial<Progress>) => void
export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
export const isHash = (value: unknown): value is Hash => typeof value === 'string' && /^0x[\da-fA-F]{64}$/.test(value)

/** Listen passively on startup. Active discovery (including the legacy injected
 * getter) runs only when the user opens the wallet chooser. Never query accounts
 * from discovery: even nominally read-only requests can wake wallet extensions. */
export function discoverWallets(announce: (option: WalletOption) => void) {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent).detail
    if (detail?.info?.uuid && detail?.provider?.request) announce({ id: detail.info.uuid, name: String(detail.info.name).slice(0, 70), provider: detail.provider })
  }
  window.addEventListener('eip6963:announceProvider', listener)
  return {
    request() {
      window.dispatchEvent(new Event('eip6963:requestProvider'))
      const injected = (window as Window & { ethereum?: WalletProvider }).ethereum
      if (injected) announce({ id: 'injected', name: 'Browser wallet', provider: injected })
    },
    dispose: () => window.removeEventListener('eip6963:announceProvider', listener),
  }
}

export async function connectWallet(provider: WalletProvider): Promise<Address> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' }) as string[]
  if (!accounts[0] || !isAddress(accounts[0])) throw new Error('The wallet did not return an account.')
  return accounts[0] as Address
}
export async function assertWallet(provider: WalletProvider, account: Address, settings: ConnectionSettings) {
  const [chain, accounts] = await Promise.all([
    provider.request({ method: 'eth_chainId' }), provider.request({ method: 'eth_accounts' }),
  ])
  if (Number(BigInt(chain as string)) !== settings.chainId) throw new Error('Switch your wallet to the selected network before continuing.')
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== account.toLowerCase()) throw new Error('The connected wallet account changed. Reconnect before continuing.')
}
export async function atomicBatchAvailable(provider: WalletProvider, account: Address, chainId: number): Promise<boolean> {
  try {
    const caps = await provider.request({ method: 'wallet_getCapabilities', params: [account, [toHex(chainId)]] }) as Record<string, { atomic?: { status?: string } }>
    return Object.entries(caps).some(([chain, c]) => Number(BigInt(chain)) === chainId && c.atomic?.status === 'supported')
  } catch { return false }
}

export interface DepositCall { id: string; label: string; to: Address; data: Hex; value: bigint }
export async function depositCalls(notes: DepositNote[], settings: ConnectionSettings, account: Address): Promise<DepositCall[]> {
  const client = publicClientFor(settings)
  const totals = new Map<Address, { token: Address; amount: bigint; symbol: string }>()
  const denominations = new Map<Address, bigint>()
  for (const note of notes) {
    let actual = denominations.get(note.pool.address)
    if (actual === undefined) {
      actual = await client.readContract({ address: note.pool.address, abi: poolAbi, functionName: 'denomination' })
      denominations.set(note.pool.address, actual)
    }
    if (actual !== note.pool.amount) throw new Error('The pool denomination does not match the catalog.')
    if (note.pool.asset.token) {
      const entry = totals.get(note.pool.address)
      totals.set(note.pool.address, { token: note.pool.asset.token, symbol: note.pool.asset.symbol, amount: (entry?.amount ?? 0n) + note.pool.amount })
    }
  }
  const calls: DepositCall[] = []
  for (const [pool, { token, amount, symbol }] of totals) {
    const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, pool] })
    if (allowance >= amount) continue
    // Exact approvals only. Reset existing allowance for tokens such as USDT.
    if (allowance > 0n) calls.push({ id: `reset-${pool}`, label: `Reset ${symbol} approval`, to: token, value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [pool, 0n] }) })
    calls.push({ id: `approve-${pool}`, label: `Approve ${symbol}`, to: token, value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [pool, amount] }) })
  }
  return [...calls, ...notes.map(n => ({ id: n.id, label: `${n.pool.denomination} ${n.pool.asset.symbol}`, ...n.call }))]
}

export async function waitForWalletBatch(provider: WalletProvider, batchId: string, timeout = 180_000) {
  const end = Date.now() + timeout
  do {
    const result = await provider.request({ method: 'wallet_getCallsStatus', params: [batchId] }) as { status: number; receipts?: { status: string; transactionHash: Hex }[] }
    if (result.status >= 200 && result.status < 300) {
      if (result.receipts?.some(r => BigInt(r.status) === 0n)) throw new Error('A batched call reverted.')
      return result.receipts?.[0]?.transactionHash
    }
    if (result.status >= 400) throw new Error('The wallet batch failed. Check its status in your wallet before starting another session.')
    await pause(2000)
  } while (Date.now() < end)
  throw new Error('The wallet batch is still pending. Keep this session open and check again.')
}

export async function executeDeposits(options: {
  provider: WalletProvider; account: Address; settings: ConnectionSettings;
  calls: DepositCall[]; atomic: boolean; update: Update;
}) {
  const { provider, account, settings, calls, atomic, update } = options
  await validateConnections(settings, false)
  await assertWallet(provider, account, settings)
  if (atomic && calls.length > 0) {
    calls.forEach(c => update(c.id, { status: 'awaiting-wallet' }))
    let submitted = false
    try {
      const result = await provider.request({ method: 'wallet_sendCalls', params: [{ version: '2.0.0', chainId: toHex(settings.chainId),
        from: account, atomicRequired: true, calls: calls.map(c => ({ to: c.to, data: c.data, value: toHex(c.value) })) }] }) as { id?: string } | string
      const batchId = typeof result === 'string' ? result : result?.id
      if (typeof batchId !== 'string' || !batchId) throw new Error('The wallet returned no batch identifier.')
      submitted = true
      calls.forEach(c => update(c.id, { status: 'submitted', batchId }))
      const hash = await waitForWalletBatch(provider, batchId)
      calls.forEach(c => update(c.id, { status: 'confirmed', hash, transactionHash: hash }))
    } catch (error) {
      const rejected = (error as { code?: number })?.code === 4001
      calls.forEach(c => update(c.id, { status: rejected && !submitted ? 'failed' : 'unknown', message: rejected ? 'Declined in wallet.' : 'Check batch status before retrying.' }))
      throw error
    }
    return
  }
  const client = publicClientFor(settings)
  for (const call of calls) {
    await assertWallet(provider, account, settings)
    update(call.id, { status: 'awaiting-wallet' })
    let submitted = false
    try {
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: account, to: call.to, data: call.data, value: toHex(call.value) }] })
      if (!isHash(hash)) throw new Error('The wallet returned no transaction hash. Check your wallet before retrying.')
      submitted = true
      update(call.id, { status: 'submitted', hash, transactionHash: hash })
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 })
      if (receipt.status !== 'success') {
        update(call.id, { status: 'failed', message: 'Transaction reverted.' })
        throw new Error('A transaction reverted. Remaining deposits were stopped.')
      }
      update(call.id, { status: 'confirmed' })
    } catch (error) {
      const rejected = (error as { code?: number })?.code === 4001
      if (!submitted || !(error instanceof Error && error.message.startsWith('A transaction reverted'))) {
        update(call.id, { status: rejected && !submitted ? 'failed' : 'unknown', message: rejected ? 'Declined in wallet.' : 'Reconcile this transaction before retrying.' })
      }
      throw error
    }
  }
}
