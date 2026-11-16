import { getAddress, isAddress, type Address } from 'viem'
import { shallowRef } from 'vue'
import { connectWallet, type WalletOption, type WalletProvider } from './wallet'

interface WalletConnection {
  wallet: WalletOption | null; account: Address | null; chainId: number | null; revision: number
}
const firstAccount = (value: unknown): Address | null => Array.isArray(value) && typeof value[0] === 'string' && isAddress(value[0]) ? getAddress(value[0]) : null
const chainNumber = (value: unknown): number | null => {
  try {
    const number = Number(BigInt(value as string))
    return Number.isSafeInteger(number) && number > 0 ? number : null
  } catch { return null }
}

/** Track the explicitly selected wallet. Even account reads can wake injected
 * wallets; the restore helper must not run on startup or provider discovery. */
export function createWalletConnection() {
  const state = shallowRef<WalletConnection>({ wallet: null, account: null, chainId: null, revision: 0 })
  const authorized = new Map<WalletProvider, { wallet: WalletOption; account: Address; chainId: number | null }>()
  let generation = 0, manual = false, disposed = false, accountVersion = 0, chainVersion = 0
  let connecting: number | undefined
  let detach: (() => void) | undefined, stopWatching: (() => void) | undefined
  let refreshing: { provider: WalletProvider; generation: number; promise: Promise<void> } | undefined
  const publish = (wallet: WalletOption | null, account: Address | null, chainId: number | null) => {
    const previous = state.value
    // Some providers repeat connect/accounts/chain notifications during RPC
    // requests. Only an actual context change invalidates prepared signatures.
    if (previous.wallet?.provider === wallet?.provider && previous.account === account && previous.chainId === chainId) return
    state.value = { wallet, account, chainId, revision: state.value.revision + 1 }
  }
  const attach = (wallet: WalletOption, account: Address | null, chainId: number | null) => {
    detach?.()
    accountVersion++; chainVersion++
    const provider = wallet.provider
    publish(wallet, account, chainId)
    const current = () => !disposed && state.value.wallet?.provider === provider
    const accountsChanged = (...args: unknown[]) => {
      if (current()) { accountVersion++; publish(wallet, firstAccount(args[0]), state.value.chainId) }
    }
    const chainChanged = (...args: unknown[]) => {
      if (current()) { chainVersion++; publish(wallet, state.value.account, chainNumber(args[0])) }
    }
    const disconnect = () => { if (current()) { accountVersion++; chainVersion++; publish(wallet, null, null) } }
    const reconnect = () => { if (current()) void recheck() }
    for (const [event, listener] of Object.entries({ accountsChanged, chainChanged, disconnect, connect: reconnect })) provider.on?.(event, listener)
    detach = () => {
      for (const [event, listener] of Object.entries({ accountsChanged, chainChanged, disconnect, connect: reconnect })) provider.removeListener?.(event, listener)
    }
  }
  const refresh = (wallet: WalletOption, token: number): Promise<void> => {
    // Focus, polling and reconnect can coincide. Share the read so an older
    // response cannot undo a newer account selection without a provider event.
    if (refreshing?.provider === wallet.provider && refreshing.generation === token) return refreshing.promise
    const accountsAtStart = accountVersion, chainAtStart = chainVersion
    const read = { provider: wallet.provider, generation: token, promise: Promise.resolve() }
    read.promise = (async () => {
      const [accounts, chain] = await Promise.allSettled([
        wallet.provider.request({ method: 'eth_accounts' }), wallet.provider.request({ method: 'eth_chainId' }),
      ])
      if (!disposed && token === generation && state.value.wallet?.provider === wallet.provider) {
        publish(wallet, accounts.status === 'fulfilled' && accountsAtStart === accountVersion ? firstAccount(accounts.value) : state.value.account,
          chain.status === 'fulfilled' && chainAtStart === chainVersion ? chainNumber(chain.value) : state.value.chainId)
      }
    })().finally(() => { if (refreshing === read) refreshing = undefined })
    refreshing = read
    return read.promise
  }
  const recheck = async () => {
    const wallet = state.value.wallet
    if (!disposed && wallet && connecting !== generation) await refresh(wallet, generation)
  }
  return {
    state,
    refresh: recheck,
    startWatching() {
      if (disposed || stopWatching) return
      // Permission/account changes may not reach an already-open page as an
      // accountsChanged event. Read the selected provider, never window.ethereum
      // or another wallet, and never request new permissions in the background.
      const visible = () => { if (document.visibilityState === 'visible') void recheck() }
      window.addEventListener('focus', visible)
      window.addEventListener('pageshow', visible)
      document.addEventListener('visibilitychange', visible)
      const timer = setInterval(visible, 2_000)
      stopWatching = () => {
        clearInterval(timer)
        window.removeEventListener('focus', visible)
        window.removeEventListener('pageshow', visible)
        document.removeEventListener('visibilitychange', visible)
      }
    },
    async restore(wallet: WalletOption) {
      if (manual || disposed || authorized.has(wallet.provider)) return
      const token = generation
      try {
        const [accounts, chain] = await Promise.all([
          wallet.provider.request({ method: 'eth_accounts' }), wallet.provider.request({ method: 'eth_chainId' }),
        ])
        if (manual || disposed || token !== generation) return
        const account = firstAccount(accounts)
        if (!account) return
        authorized.set(wallet.provider, { wallet, account, chainId: chainNumber(chain) })
        // Never silently choose between multiple already-authorized wallets.
        if (authorized.size === 1) attach(wallet, account, chainNumber(chain))
        else { detach?.(); detach = undefined; publish(null, null, null) }
      } catch { /* Locked/unavailable wallets stay disconnected without opening a prompt. */ }
    },
    async connect(wallet: WalletOption) {
      if (disposed) throw new Error('The wallet connection is no longer active.')
      manual = true
      const token = ++generation
      connecting = token
      attach(wallet, null, null)
      try {
        await connectWallet(wallet.provider)
        if (disposed || token !== generation) return
        await refresh(wallet, token)
        if (!state.value.account) throw new Error('Select an account in your wallet before continuing.')
      } catch (error) {
        if (!disposed && token === generation) { detach?.(); detach = undefined; publish(null, null, null) }
        throw error
      } finally { if (connecting === token) connecting = undefined }
    },
    disconnect() {
      manual = true; generation++; detach?.(); detach = undefined
      publish(null, null, null)
    },
    dispose() { disposed = true; generation++; detach?.(); detach = undefined; stopWatching?.(); stopWatching = undefined },
  }
}
