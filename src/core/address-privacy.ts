import { erc20Abi, type Address } from 'viem'
import { assetsFor } from './catalog'
import { publicClientFor, type ConnectionSettings } from './rpc'
import type { SmartWithdrawalAccount } from './smart-account'

export interface AddressPrivacyState {
  balance: bigint | null; nonce: number | null; code: 'empty' | 'delegation' | 'contract' | null
  tokenBalances: { symbol: string; balance: bigint | null }[]
}
export interface AddressPrivacyCheck {
  address: Address; label: string; signals: string[]; incomplete: boolean; advice: string
}

/** Current-state privacy hints, not proof that an address has never been used.
 * Deduplicate shared roles and retain partial results when one RPC read fails. */
export async function loadAddressPrivacy(addresses: Address[], settings: Pick<ConnectionSettings, 'chainId' | 'rpcUrl'>): Promise<Map<string, AddressPrivacyState>> {
  const unique = [...new Map(addresses.map(address => [address.toLowerCase(), address])).values()]
  if (!unique.length) return new Map()
  const client = publicClientFor(settings)
  const tokens = assetsFor(settings.chainId).filter(asset => asset.token)
  // One extra eth_call for the supported tokens across all address roles, rather
  // than one HTTP round trip per token/address. A failed token read stays unknown.
  const tokenReads = tokens.length ? client.multicall({
    allowFailure: true, blockTag: 'pending',
    contracts: unique.flatMap(address => tokens.map(asset => ({ address: asset.token!, abi: erc20Abi,
      functionName: 'balanceOf' as const, args: [address] as const }))),
  }).catch(() => null) : Promise.resolve([])
  return new Map(await Promise.all(unique.map(async (address, index) => {
    const [balance, nonce, code] = await Promise.allSettled([
      client.getBalance({ address, blockTag: 'pending' }),
      client.getTransactionCount({ address, blockTag: 'pending' }),
      client.getCode({ address, blockTag: 'pending' }),
    ])
    const balances = await tokenReads
    return [address.toLowerCase(), {
      balance: balance.status === 'fulfilled' ? balance.value : null,
      nonce: nonce.status === 'fulfilled' ? nonce.value : null,
      code: code.status !== 'fulfilled' ? null : !code.value || code.value === '0x' ? 'empty'
        : /^0xef0100[0-9a-f]{40}$/i.test(code.value) ? 'delegation' : 'contract',
      tokenBalances: tokens.map((asset, offset) => {
        const result = balances?.[index * tokens.length + offset]
        return { symbol: asset.symbol, balance: result?.status === 'success' ? result.result : null }
      }),
    }] as const
  })))
}

function addressPrivacyCheck(address: Address, label: string, advice: string, states: ReadonlyMap<string, AddressPrivacyState>, signals: string[] = []): AddressPrivacyCheck {
  const state = states.get(address.toLowerCase())
  if (state?.balance && state.balance > 0n) signals.push('it has an ETH balance')
  if (state?.nonce && state.nonce > 0) signals.push('its transaction nonce is nonzero')
  if (state?.code === 'delegation') signals.push('it has an EIP-7702 delegation')
  if (state?.code === 'contract' && !signals.includes('the smart account is already deployed')) signals.push('it has deployed contract code')
  for (const token of state?.tokenBalances ?? []) if (token.balance !== null && token.balance > 0n) signals.push(`it has a ${token.symbol} balance`)
  return { address, label, signals, advice,
    incomplete: !state || state.balance === null || state.nonce === null || state.code === null || state.tokenBalances.some(token => token.balance === null) }
}

export function recipientPrivacyCheck(address: Address, states: ReadonlyMap<string, AddressPrivacyState>): AddressPrivacyCheck {
  return addressPrivacyCheck(address, 'Withdrawal recipient', 'Consider using a fresh recipient address.', states)
}

export function withdrawalPrivacyChecks(account: SmartWithdrawalAccount, recipient: Address | undefined,
  states: ReadonlyMap<string, AddressPrivacyState>): AddressPrivacyCheck[] {
  const targets = [
    { address: account.address, label: 'Smart account (UserOperation sender)',
      advice: 'Consider a fresh EOA controller and the undeployed smart account derived from it.' },
    { address: account.owner, label: recipient?.toLowerCase() === account.owner.toLowerCase() ? 'Controller EOA and withdrawal recipient' : 'Controller EOA (wallet signer)',
      advice: 'Consider a fresh EOA controller and its undeployed smart account.' },
    ...(recipient && ![account.address, account.owner].some(address => address.toLowerCase() === recipient.toLowerCase())
      ? [{ address: recipient, label: 'Withdrawal recipient', advice: 'Consider forwarding to a fresh recipient address.' }] : []),
  ]
  return targets.map(({ address, label, advice }) => {
    const sender = address.toLowerCase() === account.address.toLowerCase()
    const signals: string[] = []
    if (sender && account.deployed) signals.push('the smart account is already deployed')
    if (sender && account.nonce > 0n) signals.push('its EntryPoint nonce is nonzero')
    return addressPrivacyCheck(address, label, advice, states, signals)
  })
}
