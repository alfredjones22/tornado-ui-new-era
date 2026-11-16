import { MemoryStorage, type Host } from '@kohaku-eth/plugins'
import { viem } from '@kohaku-eth/provider/viem'
import { E_ADDRESS, SecretManager, TornadoCashConfigs, TornadoInstances, TornadoPaymasterConfigs, TornadoCashProtocol, type ISecretManager, type TypedDataSigner } from '@kohaku-eth/tornado-cash'
import { publicClientFor, safeError, sdkNetwork, type ConnectionSettings } from './core/rpc'
import { parseBatchNotes, parseNote, type ParsedNote } from './core/notes'
import type { Address, Hex } from 'viem'
import type { PublicSnapshot } from './core/withdrawals'
import { assertImportedNotes, assertPoolHistoryComplete, checkedHistoryProvider } from './core/pool-history'
import { loadCachedHistory } from './core/history-cache'
import { createSagaHistory } from './core/saga-history'
import { assertClassicRelayerPool, createCheckedRelayerClient, RELAYER_FEE_CONFIG } from './core/relayers'
import { withRelayerHistory } from './core/relayer-history'
import type { SmartWithdrawalScope } from './core/smart-withdrawal-policy'
import { paymasterOptions } from './core/withdrawal-options'
import { appAssetUrl } from './core/app-assets'
import { loadProvingArtifacts } from './core/proving-artifacts'
import { walletRpcOverPort } from './core/wallet-rpc'
import { reviewedCalls } from './core/smart-withdrawal-policy'

function signerOverPort(port: MessagePort, address: Address, assertHealthy: () => void): TypedDataSigner {
  let nextRequest = 0
  const pending = new Map<number, (value: unknown) => void>()
  port.addEventListener('message', ({ data }) => {
    if (data.status !== 'signature' || !pending.has(data.id)) return
    pending.get(data.id)!(data.result); pending.delete(data.id)
  })
  port.start()
  const request = (value: unknown) => new Promise<unknown>(resolve => {
    assertHealthy()
    const id = ++nextRequest
    pending.set(id, resolve)
    port.postMessage({ status: 'sign', id, method: 'signTypedData', request: value })
  })
  return { address,
    signTypedData: value => request(value) as Promise<Hex>,
  }
}

// A disposable document owns each SDK worker. Unloading it releases the SDK's
// private state and its workers; the public SDK currently has no dispose API.
async function prepareFrame(event: MessageEvent) {
  if (event.origin !== location.origin || event.source !== parent || !['tornado-prepare', 'tornado-smart-prepare'].includes(event.data?.type) || !event.ports[0]) return
  window.removeEventListener('message', prepareFrame)
  const port = event.ports[0]
  const batch = event.data.type === 'tornado-smart-prepare'
  const scope = event.data.scope as SmartWithdrawalScope | undefined
  const route = batch ? 'paymaster' : event.data.route ?? 'paymaster'
  const { settings, initialState } = event.data as { settings: ConnectionSettings; initialState?: PublicSnapshot }
  try {
    if (route !== 'paymaster' && route !== 'relayer') throw new Error('Unknown withdrawal route.')
    const selected = batch ? parseBatchNotes(event.data.notes.join('\n'), settings.chainId, 1) : [parseNote((event.data.note as ParsedNote).raw, settings.chainId)]
    if (batch) reviewedCalls(scope!)
    if (route === 'relayer') selected.forEach(assertClassicRelayerPool)
    const note = selected[0]!
    const recipient: Address = event.data.recipient
    const progress = (message: string) => port.postMessage({ status: 'progress', message })
    const cachedHistory = await loadCachedHistory(settings.chainId, selected.map(note => note.pool), initialState, progress, fetch, settings.artifactsUrl)
    const minimumBlock = Object.values(cachedHistory).flatMap(state => state.pools.poolsTuples)
      .reduce((head, [, pool]) => BigInt(pool.lastSyncedBlock!) > head ? BigInt(pool.lastSyncedBlock!) : head, 0n)
    // Pace the free archival endpoint; shared pacing also covers multi-pool sync.
    const walletRpc = event.data.walletRpc === true ? walletRpcOverPort(port) : undefined
    const history = checkedHistoryProvider(viem(publicClientFor(settings, walletRpc, minimumBlock)), progress, new URL(settings.rpcUrl).hostname === '0xrpc.io' ? 250 : 0)
    const syncHead = await history.provider.getBlockNumber()
    if (Object.values(cachedHistory).some(state => state.pools.poolsTuples.some(([, pool]: [string, { lastSyncedBlock: string }]) => BigInt(pool.lastSyncedBlock) > syncHead))) {
      throw new Error('The RPC is behind the cached pool history. Use an up-to-date RPC endpoint.')
    }
    const saga = createSagaHistory(settings.chainId, cachedHistory, syncHead, progress, fetch, console.warn, settings.sagaUrl)
    const host: Host = {
      storage: new MemoryStorage(),
      keystore: { deriveAt: async () => { throw new Error('Wallet key derivation is unavailable in this note session.') } },
      provider: history.provider, network: sdkNetwork(settings, walletRpc, minimumBlock),
      externalSyncProvider: route === 'relayer' ? withRelayerHistory(saga, settings.chainId, syncHead, progress, fetch, undefined, settings.artifactsUrl) : saga,
    }
    const legacy = await SecretManager({ host })
    const blank = { salt: 0n, nullifier: 0n, commitment: 0n, nullifierHash: 0n } as Awaited<ReturnType<typeof legacy.getLegacyDepositSecrets>>
    const noWallet = async (): Promise<never> => { throw new Error('Wallet derivation is disabled in independent-note mode.') }
    const manager: ISecretManager = {
      getLegacyDepositSecrets: async () => blank, getSignatureSecrets: async () => blank,
      deriveEphemeralSigner: noWallet, deriveSignatureEphemeralSigner: noWallet,
      deriveDelegatorSigner: noWallet, deriveLegacyEphemeralSigner: async value => { history.assertHealthy(); return legacy.deriveLegacyEphemeralSigner(value) },
    }
    const cfg = TornadoPaymasterConfigs[settings.chainId]
    const relayers = createCheckedRelayerClient(note)
    const protocol = new TornadoCashProtocol(host, {
      accountIndex: 0, useExtendedEthPools: true, minExternalSyncBlocksAmount: 0,
      protocolConfig: { ...TornadoCashConfigs[settings.chainId], instances: TornadoInstances[settings.chainId].filter(p => selected.some(n => p.address === BigInt(n.pool.address))) },
      paymasterConfig: { [settings.chainId]: { ...cfg, bundlerUrl: settings.bundlerUrl } },
      stateManagerWorkerUrl: appAssetUrl('sdk/state-manager.worker.js'),
      artifactsLoader: () => loadProvingArtifacts(progress, fetch, settings.artifactsUrl),
      secretManagerFactory: async () => manager,
      ...(route === 'relayer' ? { relayerClientFactory: () => relayers.client, relayerConfig: RELAYER_FEE_CONFIG } : {}),
      initialState: async () => cachedHistory,
    })
    const poolCount = new Set(selected.map(note => note.pool.address.toLowerCase())).size
    progress(poolCount > 1 ? `Syncing ${poolCount} pools in parallel and checking the notes…` : 'Syncing pool history and checking the note…')
    const imported = await protocol.importNotes(selected.map(n => n.raw))
    history.assertHealthy()
    assertPoolHistoryComplete(await protocol.dumpState(), selected, syncHead)
    assertImportedNotes(imported, selected)
    const notes = await protocol.notes!()
    history.assertHealthy()
    const amount = selected.reduce((sum, n) => sum + n.pool.amount, 0n)
    if (notes.length !== selected.length || notes.some(n => n.balance !== n.amount) || notes.reduce((sum, n) => sum + n.balance, 0n) !== amount) throw new Error('A selected note is already spent or has no spendable deposit.')
    progress(route === 'relayer' ? 'Discovering registered TORN relayers and preparing the withdrawal proof…' : 'Generating the proof and estimating the paymaster fee…')
    const assetAmount = { asset: { __type: 'erc20' as const, contract: note.pool.asset.token ?? E_ADDRESS }, amount }
    const operation = route === 'relayer'
      ? await protocol.prepareUnshield(assetAmount, recipient, { mode: 'relayer' })
      : await protocol.prepareUnshield(assetAmount, recipient, batch
        ? paymasterOptions(scope!, signerOverPort(port, scope!.account.owner, history.assertHealthy))
        // Omit delegation to retain the SDK's recoverable note-derived sender.
        : paymasterOptions())
    history.assertHealthy()
    if (operation.withdrawals.length !== 1) throw new Error('Expected exactly one withdrawal.')
    const publicState = await protocol.dumpState()
    // Only public history is shared with later note sessions. Strip all secret
    // slices explicitly as well as relying on the SDK's public dump method.
    for (const state of Object.values(publicState)) {
      for (const key of ['userSecrets', 'signatureSecrets', 'legacySecrets']) delete (state as unknown as Record<string, unknown>)[key]
    }
    const withdrawal = operation.withdrawals[0]!
    const relayer = withdrawal.mode === 'relayer' ? relayers.selected(withdrawal, publicState) : undefined
    port.postMessage({ status: 'ready', withdrawal, relayer, publicState })
  } catch (error) {
    const reason = safeError(error)
    const message = route === 'relayer' && /No relayers available|All relayers failed liveness check/i.test(reason)
      ? 'No available registered TORN relayer supports this pool on the selected network. Switch to 4337 or try again later.' : reason
    console.error(`[Tornado withdrawal] Preparation failed: ${message}`)
    port.postMessage({ status: 'error', message })
  }
}
window.addEventListener('message', prepareFrame)
