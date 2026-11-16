import { ExtendedEthPools, TornadoInstances, TornadoPaymasterConfigs } from '@kohaku-eth/tornado-cash'
import { formatEther, formatUnits, getAddress, parseUnits, type Address } from 'viem'

export type ChainId = 1 | 11155111
export const DENOMINATIONS = ['0.01', '0.03', '0.1', '0.3', '1', '3', '10', '30', '100'] as const
export type Denomination = string
export const NETWORKS = {
  1: { name: 'Ethereum', rpc: 'https://ethereum.publicnode.com', explorer: 'https://etherscan.io' },
  11155111: { name: 'Sepolia', rpc: 'https://0xrpc.io/sep', explorer: 'https://sepolia.etherscan.io' },
} as const
export interface Asset { symbol: string; decimals: number; token: Address | null }
export interface Pool { chainId: ChainId; denomination: Denomination; amount: bigint; address: Address; asset: Asset }
const addressOf = (value: bigint) => getAddress(`0x${value.toString(16).padStart(40, '0')}`)
export function poolsFor(chainId: ChainId, symbol?: string): Pool[] {
  return TornadoInstances[chainId].filter(p => !symbol || p.symbol.toLowerCase() === symbol.toLowerCase()).filter(p =>
    TornadoPaymasterConfigs[chainId].supportedPools.some(a => BigInt(a) === p.address),
  ).map(p => ({ chainId, denomination: formatUnits(p.denomination, p.decimals), amount: p.denomination,
    address: addressOf(p.address), asset: { symbol: p.symbol, decimals: p.decimals, token: p.asset === 0n ? null : addressOf(p.asset) },
  })).sort((a, b) => a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0)
}
export function assetsFor(chainId: ChainId): Asset[] {
  const order = ['ETH', 'DAI', 'USDC', 'USDT', 'WBTC']
  return [...new Map(poolsFor(chainId).map(p => [p.asset.symbol, p.asset])).values()].sort((a, b) => order.indexOf(a.symbol) - order.indexOf(b.symbol))
}
export function poolFor(chainId: ChainId, denomination: string, symbol = 'ETH'): Pool | undefined {
  return poolsFor(chainId, symbol).find(p => p.denomination === denomination)
}
export function supportsClassicRelayer(pool: Pool): boolean {
  const known = poolFor(pool.chainId, pool.denomination, pool.asset.symbol)
  return known?.address.toLowerCase() === pool.address.toLowerCase() &&
    !ExtendedEthPools[pool.chainId].some(address => address === BigInt(pool.address))
}
export const depositBatchLimit = (asset: Pick<Asset, 'token'>) => asset.token ? 5 : 12
export interface DepositSelection { denomination: Denomination; count: number }
export interface DepositCartRow { pool: Pool; count: number; total: bigint }
export function depositCart(chainId: ChainId, selections: DepositSelection[], symbol = 'ETH'): DepositCartRow[] {
  const rows: DepositCartRow[] = []
  let quantity = 0
  for (const { denomination, count } of selections) {
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(quantity + count)) throw new Error('Invalid note quantity.')
    if (!count) continue
    const pool = poolFor(chainId, denomination, symbol)
    if (!pool) throw new Error(`${denomination} ${symbol} is unavailable on ${NETWORKS[chainId].name}.`)
    quantity += count
    rows.push({ pool, count, total: pool.amount * BigInt(count) })
  }
  if (!rows.length) throw new Error('Select at least one note.')
  return rows
}
export function expandSelection(chainId: ChainId, selections: DepositSelection[], symbol = 'ETH'): Pool[] {
  return depositCart(chainId, selections, symbol).flatMap(({ pool, count }) => Array.from({ length: count }, () => pool))
}
export const totalValue = (pools: readonly Pool[]) => pools.reduce((sum, p) => sum + p.amount, 0n)
export const eth = (value: bigint) => formatEther(value)
export const units = (value: bigint, asset: Asset) => formatUnits(value, asset.decimals)
export const shorten = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`

/** Exact integer arithmetic; never round a user's entered amount. */
export function parseAmount(input: string, decimals: number): bigint {
  const value = input.trim()
  if (value.length > 64) throw new Error('Enter a smaller amount.')
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error('Enter a positive amount, such as 1.75.')
  if ((value.split('.')[1]?.length ?? 0) > decimals) throw new Error(`Use at most ${decimals} decimal places.`)
  const amount = parseUnits(value, decimals)
  if (amount <= 0n) throw new Error('Amount must be greater than zero.')
  return amount
}

