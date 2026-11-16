import { appAssetUrl } from './app-assets'
import { decodeEventLog, hashTypedData, parseAbi, recoverTypedDataAddress, toHex, TransactionReceiptNotFoundError, type Hex } from 'viem'
import { createWalletClient, custom, type EIP1193Provider } from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import { batchTypedData } from './batch-policy'
import { parseBatchNotes, type ParsedNote } from './notes'
import { EndpointRpcError, jsonRpc, publicClientFor, safeError, validateConnections, type ConnectionSettings } from './rpc'
import { assertSmartAccount } from './smart-account'
import { smartRecipient, validateSmartSigningRequest, validateSmartWithdrawal, type SmartWithdrawalScope } from './smart-withdrawal-policy'
import { assertWithdrawalWallet, type ApproveSigning, type WithdrawalWallet } from './wallet-signer'
import { isHash, pause, type Update } from './wallet'
import type { Withdrawal } from './withdrawals'
import { NETWORKS } from './catalog'
import { walletRpcBridge } from './wallet-rpc'
import { canSubmitSimulation, type WithdrawalSimulation } from './withdrawal-simulation'

export interface SmartWithdrawalQuote {
  id: string; notes: ParsedNote[]; scope: SmartWithdrawalScope; withdrawal: Withdrawal
  fee: bigint; net: bigint; quotedAt: number; signedHash: Hex
  simulation?: WithdrawalSimulation
}

export function createSmartWithdrawalSigner(wallet: WithdrawalWallet, notes: ParsedNote[], scope: SmartWithdrawalScope,
  settings: ConnectionSettings, approve: ApproveSigning, signal?: AbortSignal) {
  let invalid = false, disposed = false, sequence = 0
  let last: { hash: Hex; signature: Hex } | undefined
  const listeners = {
    accountsChanged: (accounts: unknown) => { if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== scope.account.owner.toLowerCase()) invalid = true },
    chainChanged: (chain: unknown) => { try { if (BigInt(chain as string) !== BigInt(settings.chainId)) invalid = true } catch { invalid = true } },
    disconnect: () => { invalid = true },
  }
  for (const [event, listener] of Object.entries(listeners)) wallet.provider.on?.(event, listener)
  const active = async () => {
    if (invalid || disposed || signal?.aborted) throw new Error('The wallet signing session changed or was cancelled. Prepare a new batch.')
    if (wallet.account.toLowerCase() !== scope.account.owner.toLowerCase()) throw new Error('Reconnect the smart account owner.')
    await assertWithdrawalWallet(wallet, settings)
    if (invalid || disposed || signal?.aborted) throw new Error('The wallet signing session changed or was cancelled. Prepare a new batch.')
  }
  const client = createWalletClient({ account: scope.account.owner, chain: settings.chainId === 1 ? mainnet : sepolia,
    transport: custom(wallet.provider as EIP1193Provider, { retryCount: 0 }) })
  return {
    async signTypedData(value: unknown): Promise<Hex> {
      const reviewed = validateSmartSigningRequest(structuredClone(value), notes, scope, settings)
      await active()
      await approve({ kind: 'user-operation', account: scope.account.owner, chainId: settings.chainId, sequence: ++sequence,
        fee: reviewed.fee, net: reviewed.net, maxGasCost: reviewed.maxGasCost })
      await active()
      // Some injected providers (including Ambire) cache eth_chainId in-page.
      // Explicitly select the pinned chain in the wallet's background before
      // each signature, even if that cached read already reports the right one.
      try {
        await wallet.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(settings.chainId) }] })
      } catch (error) {
        // Switching is optional for wallets that already sign on the right chain.
        // Rejections and all other switch failures must stop before signing.
        if (![-32601, 4200].includes((error as { code?: number })?.code!)) throw error
      }
      await active()
      let signature: Hex
      try { signature = await client.signTypedData(reviewed.typedData) }
      catch (error) {
        if (/domain chainId.*does not match.*(?:current )?network chainId/i.test(safeError(error))) {
          throw new Error(`The wallet's signing network does not match ${NETWORKS[settings.chainId].name} (${settings.chainId}). Select this network for this site in your wallet and retry. ${safeError(error)}`)
        }
        throw error
      }
      await active()
      if ((await recoverTypedDataAddress({ ...reviewed.typedData, signature })).toLowerCase() !== scope.account.owner.toLowerCase()) throw new Error('The signature does not belong to the selected EOA owner.')
      last = { hash: hashTypedData(reviewed.typedData), signature }
      return signature
    },
    async verifyPrepared(withdrawal: Withdrawal) {
      await active()
      const hash = hashTypedData(batchTypedData(withdrawal, settings))
      if (!last || hash !== last.hash || withdrawal.userOperation.signature.toLowerCase() !== last.signature.toLowerCase()) throw new Error('The prepared batch differs from the last wallet-approved operation.')
      return hash
    },
    dispose() {
      disposed = true
      for (const [event, listener] of Object.entries(listeners)) wallet.provider.removeListener?.(event, listener)
    },
  }
}

export async function prepareSmartWithdrawal(input: string, wallet: WithdrawalWallet, scopeInput: SmartWithdrawalScope,
  settings: ConnectionSettings, progress: (message: string) => void, approve: ApproveSigning, signal?: AbortSignal): Promise<SmartWithdrawalQuote> {
  const notes = parseBatchNotes(input, settings.chainId, 1), scope = structuredClone(scopeInput)
  const recipient = smartRecipient(scope)
  const stopped = () => new Error(signal?.reason instanceof Error && signal.reason.name !== 'AbortError' ? safeError(signal.reason) : 'Batch preparation was cancelled.')
  if (signal?.aborted) throw stopped()
  await assertWithdrawalWallet(wallet, settings)
  await validateConnections(settings)
  await assertSmartAccount(scope.account, settings)
  if (signal?.aborted) throw stopped()
  const signer = createSmartWithdrawalSigner(wallet, notes, scope, settings, approve, signal)
  let sharedCandidate = false
  try {
    const withdrawal = await new Promise<Withdrawal>((resolve, reject) => {
      const frame = document.createElement('iframe'), channel = new MessageChannel()
      const readBridge = walletRpcBridge(channel.port1, settings.chainId)
      frame.hidden = true; frame.title = 'Local smart account withdrawal proof session'
      let closed = false, signing = false, next = 1
      const cleanup = () => { closed = true; clearTimeout(timer); readBridge.dispose(); signal?.removeEventListener('abort', abort); channel.port1.close(); channel.port2.close(); frame.remove() }
      const fail = (error: Error) => { if (!closed) { cleanup(); reject(error) } }
      const abort = () => fail(stopped())
      let timer: ReturnType<typeof setTimeout>
      const keepAlive = () => { clearTimeout(timer); timer = setTimeout(() => fail(new Error('Batch preparation timed out.')), 900_000) }
      keepAlive()
      signal?.addEventListener('abort', abort, { once: true })
      channel.port1.onmessage = async ({ data }) => {
        if (closed || !data || typeof data !== 'object') return
        if (data.status === 'read-rpc') { void readBridge.handle(data); return }
        if (data.status === 'progress' && typeof data.message === 'string') { keepAlive(); progress(data.message) }
        if (data.status === 'sign') {
          if (signing || data.id !== next++ || data.method !== 'signTypedData') return fail(new Error('Unexpected signing request. Smart accounts only use typed-data signing.'))
          keepAlive()
          signing = true
          try {
            const result = await signer.signTypedData(data.request)
            if (!closed) { keepAlive(); channel.port1.postMessage({ status: 'signature', id: data.id, result }); sharedCandidate = true }
          } catch (error) { fail(new Error(safeError(error))) }
          finally { signing = false }
        }
        if (data.status === 'ready') {
          if (signing) return fail(new Error('The proof session finished before wallet signing completed.'))
          cleanup(); resolve(data.withdrawal)
        }
        if (data.status === 'error') fail(new Error(typeof data.message === 'string' ? data.message : 'Batch preparation failed.'))
      }
      frame.onload = () => {
        if (closed) return
        try {
          if (!frame.contentWindow) throw new Error('Missing proof session window')
          frame.contentWindow.postMessage({ type: 'tornado-smart-prepare', notes: notes.map(note => note.raw), recipient, scope, settings, walletRpc: readBridge.enabled }, location.origin, [channel.port2])
        } catch { fail(new Error('Could not start the smart account proof session.')) }
      }
      frame.onerror = () => fail(new Error('Could not load the local proof session.'))
      frame.src = appAssetUrl('withdraw-frame.html')
      if (signal?.aborted) abort(); else document.body.append(frame)
    })
    const { fee, net } = validateSmartWithdrawal(notes, scope, withdrawal, settings)
    const signedHash = await signer.verifyPrepared(withdrawal)
    return { id: crypto.randomUUID(), notes, scope, withdrawal, fee, net, quotedAt: Date.now(), signedHash }
  } catch (error) {
    if (sharedCandidate) throw new Error(`${safeError(error).slice(0, 260)} A signed UserOperation may still be executable; check the smart account and notes before retrying.`)
    throw error
  } finally { signer.dispose() }
}

const receiptEvents = parseAbi(['event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)'])
export async function reconcileSmartWithdrawal(quote: SmartWithdrawalQuote, settings: ConnectionSettings, update: Update, timeout = 180_000) {
  const end = Date.now() + timeout
  let transactionHash: Hex | undefined
  const waiting = () => update(quote.id, { hash: quote.signedHash, ...(transactionHash ? { transactionHash } : {}), status: 'submitted',
    message: 'Awaiting on-chain confirmation. View on Etherscan or check again before retrying.' })
  waiting()
  do {
    const result = await jsonRpc<{ receipt: { transactionHash: Hex } } | null>(settings.bundlerUrl, 'eth_getUserOperationReceipt', [quote.signedHash])
    if (result) {
      const hash = result.receipt?.transactionHash
      if (!isHash(hash)) throw new Error('The bundler returned an invalid transaction receipt.')
      transactionHash = hash
      waiting() // Publish the explorer link before waiting for the independent chain RPC.
    }
    if (transactionHash) {
      let receipt
      try { receipt = await publicClientFor(settings).getTransactionReceipt({ hash: transactionHash }) }
      catch (error) {
        // The bundler can see inclusion before the host RPC's receipt index catches up.
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error
      }
      if (receipt) {
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== quote.withdrawal.entryPointAddress.toLowerCase()) continue
          try {
            const { args } = decodeEventLog({ abi: receiptEvents, data: log.data, topics: log.topics })
            if (args.userOpHash.toLowerCase() !== quote.signedHash.toLowerCase() || args.sender.toLowerCase() !== quote.scope.account.address.toLowerCase() ||
              args.paymaster.toLowerCase() !== quote.withdrawal.paymasterAddress.toLowerCase() || args.nonce !== quote.scope.account.nonce) continue
            update(quote.id, { transactionHash, status: args.success ? 'confirmed' : 'failed',
              message: args.success ? undefined : quote.notes.length === 1 && !quote.scope.calls?.length
                ? 'Execution reported a failure. The note may already be spent; check the receipt and withdrawal recipient for the payout and refund before retrying.'
                : 'Execution reverted. Check the smart account for the sponsoring note’s proceeds and refund; the other notes may still be unspent. Recover funds before preparing another batch.' })
            return args.success
          } catch { /* Ignore unrelated EntryPoint logs. */ }
        }
        throw new Error('The reported transaction does not confirm this UserOperation. Check the smart account and original notes before retrying.')
      }
    }
    if (Date.now() < end) await pause(Math.min(2000, end - Date.now()))
  } while (Date.now() < end)
  waiting()
  return null // Pending is not failure; keep its hashes and allow an explicit later status check.
}

export async function submitSmartWithdrawal(quote: SmartWithdrawalQuote, settings: ConnectionSettings, wallet: WithdrawalWallet, update: Update) {
  if (!canSubmitSimulation(quote.simulation, quote)) throw new Error(`Resolve the ${quote.scope.calls?.length ? 'contract-call' : 'withdrawal'} simulation before submitting this operation.`)
  if (Date.now() - quote.quotedAt > 5 * 60_000) throw new Error('This batch quote expired. Prepare a new review.')
  const result = validateSmartWithdrawal(quote.notes, quote.scope, quote.withdrawal, settings)
  const typed = batchTypedData(quote.withdrawal, settings)
  if (result.fee !== quote.fee || result.net !== quote.net || hashTypedData(typed) !== quote.signedHash ||
    (await recoverTypedDataAddress({ ...typed, signature: quote.withdrawal.userOperation.signature })).toLowerCase() !== quote.scope.account.owner.toLowerCase()) throw new Error('The signed batch changed after wallet approval.')
  if (wallet.account.toLowerCase() !== quote.scope.account.owner.toLowerCase()) throw new Error('Reconnect the smart account owner before submitting.')
  await assertWithdrawalWallet(wallet, settings)
  await validateConnections(settings)
  await assertSmartAccount(quote.scope.account, settings)
  await assertWithdrawalWallet(wallet, settings)
  update(quote.id, { status: 'submitted', hash: quote.signedHash })
  let accepted = false
  try {
    const hash = await jsonRpc<Hex>(settings.bundlerUrl, 'eth_sendUserOperation', [quote.withdrawal.userOperation, quote.withdrawal.entryPointAddress])
    accepted = true // Even an unexpected returned hash is an uncertain submission.
    if (!isHash(hash) || hash.toLowerCase() !== quote.signedHash.toLowerCase()) throw new Error('The bundler returned a different UserOperation hash. Check the locally computed hash before retrying.')
    await reconcileSmartWithdrawal(quote, settings, update)
  } catch (error) {
    // Only a structured, pre-acceptance minimum-fee rejection permits returning
    // to the same draft. Timeouts, malformed replies, arbitrary RPC errors and
    // failures after acceptance must retain the uncertain/pending state.
    const rejectedFee = !accepted && error instanceof EndpointRpcError && error.method === 'eth_sendUserOperation' && error.code === -32602 &&
      /(?:maxFeePerGas|maxPriorityFeePerGas).*?(?:must be at least|too low|below)/i.test(error.message)
    update(quote.id, { status: rejectedFee ? 'rejected' : 'unknown', message: rejectedFee
      ? 'The bundler rejected this gas price. Return to review to refresh fees, regenerate proofs and request new signatures.'
      : 'Check this UserOperation and the smart account before retrying. Keep the original notes.' })
    throw error
  }
}
