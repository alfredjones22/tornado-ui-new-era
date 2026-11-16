import type { DelegatorAccount } from '@kohaku-eth/tornado-cash'
import { createWalletClient, custom, getAddress, hashTypedData, isHex, recoverTypedDataAddress, toHex, type Address, type EIP1193Provider, type Hex } from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import { recoverAuthorizationAddress } from 'viem/utils'
import { batchTypedData, SIMPLE_7702_IMPLEMENTATION, validateBatchSigningRequest } from './batch-policy'
import type { ParsedNote } from './notes'
import { safeError, type ConnectionSettings } from './rpc'
import type { Withdrawal } from './withdrawals'
import type { WalletProvider } from './wallet'

export interface SigningReview {
  kind: 'authorization' | 'user-operation'; account: Address; chainId: number; sequence: number
  fee?: bigint; net?: bigint; maxGasCost?: bigint
}
export type ApproveSigning = (review: SigningReview) => Promise<void>
export interface WithdrawalWallet { provider: WalletProvider; account: Address }

/** Require the selected account, not merely an old account still exposed by the wallet. */
export async function assertWithdrawalWallet(wallet: WithdrawalWallet, settings: ConnectionSettings) {
  const [chain, accounts] = await Promise.all([
    wallet.provider.request({ method: 'eth_chainId' }), wallet.provider.request({ method: 'eth_accounts' }),
  ])
  if (Number(BigInt(chain as string)) !== settings.chainId) throw new Error('Switch your wallet to the selected network before continuing.')
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== wallet.account.toLowerCase()) {
    throw new Error('The selected wallet account changed. Reconnect and prepare a new batch.')
  }
}

/** Scoped, short-lived adapter. The receiver key never enters this application. */
export function createWithdrawalSigner(wallet: WithdrawalWallet, notes: ParsedNote[], settings: ConnectionSettings, approve: ApproveSigning, signal?: AbortSignal) {
  const address = getAddress(wallet.account)
  let invalidated = false, disposed = false, sequence = 0
  let lastSigned: { hash: Hex; signature: Hex } | undefined
  const listeners = {
    accountsChanged: (accounts: unknown) => {
      if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== address.toLowerCase()) invalidated = true
    },
    chainChanged: (chain: unknown) => {
      try { if (BigInt(chain as string) !== BigInt(settings.chainId)) invalidated = true }
      catch { invalidated = true }
    },
    disconnect: () => { invalidated = true },
  }
  for (const [event, listener] of Object.entries(listeners)) wallet.provider.on?.(event, listener)
  const active = async () => {
    if (disposed || invalidated || signal?.aborted) throw new Error('Wallet signing session changed or was cancelled. Prepare a new batch.')
    await assertWithdrawalWallet(wallet, settings)
    if (disposed || invalidated || signal?.aborted) throw new Error('Wallet signing session changed or was cancelled. Prepare a new batch.')
  }
  const client = createWalletClient({ account: address, chain: settings.chainId === 1 ? mainnet : sepolia, transport: custom(wallet.provider as EIP1193Provider, { retryCount: 0 }) })
  const signer: DelegatorAccount = {
    address,
    signAuthorization: async request => {
      if (request.address?.toLowerCase() !== SIMPLE_7702_IMPLEMENTATION.toLowerCase() || request.chainId !== settings.chainId || BigInt(request.nonce) !== 0n) {
        throw new Error('Unexpected receiver delegation request.')
      }
      await active()
      await approve({ kind: 'authorization', account: address, chainId: settings.chainId, sequence: 0 })
      await active()
      let result: unknown
      try {
        // This is a wallet extension, not a universally supported EIP-1193 RPC.
        // Both delegate field names identify the SAME fixed implementation.
        result = await wallet.provider.request({ method: 'wallet_signAuthorization', params: [{ from: address,
          address: SIMPLE_7702_IMPLEMENTATION, contractAddress: SIMPLE_7702_IMPLEMENTATION, chainId: toHex(settings.chainId), nonce: '0x0' }] })
      } catch (error) {
        const code = (error as { code?: number })?.code
        if ([-32601, 4200].includes(code!)) throw new Error(`The wallet rejected wallet_signAuthorization (code ${code}). It does not expose the required EIP-7702 signing method. Use a compatible wallet or the single-note withdrawal flow.`)
        if (code === -32602) throw new Error('The wallet rejected the wallet_signAuthorization parameters (code -32602). Its authorization-signing format may differ from this adapter.')
        if (code === 4001) throw new Error('Delegation signing was declined in the wallet.')
        const message = error instanceof Error ? error : new Error(typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'The wallet returned an unknown error.')
        throw new Error(`EIP-7702 authorization signing failed${typeof code === 'number' ? ` (code ${code})` : ''}: ${safeError(message)}`)
      }
      await active()
      const raw = result as Record<string, unknown> | null
      const quantity = (value: unknown) => {
        if (typeof value !== 'number' && typeof value !== 'bigint' && (typeof value !== 'string' || !/^0x[\da-f]+$/i.test(value))) throw new Error('The wallet returned an invalid delegation signature.')
        return BigInt(value)
      }
      if (!raw || typeof raw.address !== 'string' || raw.address.toLowerCase() !== SIMPLE_7702_IMPLEMENTATION.toLowerCase() ||
        quantity(raw.chainId) !== BigInt(settings.chainId) || quantity(raw.nonce) !== 0n ||
        !isHex(raw.r, { strict: true }) || raw.r.length !== 66 || !isHex(raw.s, { strict: true }) || raw.s.length !== 66 ||
        ![0n, 1n].includes(quantity(raw.yParity))) throw new Error('The wallet returned an unexpected delegation signature.')
      const signed = { address: SIMPLE_7702_IMPLEMENTATION as Address, chainId: settings.chainId, nonce: 0,
        r: raw.r, s: raw.s, yParity: Number(quantity(raw.yParity)) }
      if ((await recoverAuthorizationAddress({ authorization: signed })).toLowerCase() !== address.toLowerCase()) throw new Error('The delegation signature belongs to a different account.')
      return signed
    },
    signTypedData: async value => {
      const reviewed = validateBatchSigningRequest(structuredClone(value), notes, address, settings)
      await active()
      await approve({ kind: 'user-operation', account: address, chainId: settings.chainId, sequence: ++sequence,
        fee: reviewed.fee, net: reviewed.net, maxGasCost: reviewed.maxGasCost })
      await active()
      const signature = await client.signTypedData(reviewed.typedData)
      await active()
      if ((await recoverTypedDataAddress({ ...reviewed.typedData, signature })).toLowerCase() !== address.toLowerCase()) throw new Error('The batch signature belongs to a different account.')
      lastSigned = { hash: hashTypedData(reviewed.typedData), signature }
      return signature
    },
  }
  return {
    signer,
    async verifyPrepared(withdrawal: Withdrawal) {
      await active()
      const digest = hashTypedData(batchTypedData(withdrawal, settings))
      if (!lastSigned || digest !== lastSigned.hash || withdrawal.userOperation.signature.toLowerCase() !== lastSigned.signature.toLowerCase()) {
        throw new Error('The prepared batch differs from the last wallet-approved operation.')
      }
      return digest
    },
    dispose() {
      disposed = true
      for (const [event, listener] of Object.entries(listeners)) wallet.provider.removeListener?.(event, listener)
    },
  }
}
