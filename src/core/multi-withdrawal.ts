import { appAssetUrl } from './app-assets'
import { hashTypedData, type Address, type Hex } from 'viem'
import { parseBatchNotes, type ParsedNote } from './notes'
import { jsonRpc, safeError, validateConnections, type ConnectionSettings } from './rpc'
import { reconcileWithdrawal, type Withdrawal } from './withdrawals'
import { isHash, type Update } from './wallet'
import { batchTypedData, checkFreshReceiver, validateMultiWithdrawal } from './batch-policy'
import { assertWithdrawalWallet, createWithdrawalSigner, type ApproveSigning, type WithdrawalWallet } from './wallet-signer'
export { checkFreshReceiver, noteIdentity, validateMultiWithdrawal } from './batch-policy'

export interface MultiWithdrawalQuote {
  id: string; notes: ParsedNote[]; recipient: Address; withdrawal: Withdrawal
  fee: bigint; net: bigint; quotedAt: number; signedHash: Hex
}

export async function prepareMultiWithdrawal(input: string, wallet: WithdrawalWallet, settings: ConnectionSettings,
  progress: (message: string) => void, approve: ApproveSigning, signal?: AbortSignal): Promise<MultiWithdrawalQuote> {
  const notes = parseBatchNotes(input, settings.chainId)
  const recipient = wallet.account
  let sharedCandidate = false
  const stopped = (fallback: string) => {
    const reason = signal?.reason
    const message = reason instanceof Error && reason.name !== 'AbortError' ? safeError(reason) : fallback
    return new Error(message)
  }
  if (signal?.aborted) throw stopped('Batch preparation was cancelled.')
  await assertWithdrawalWallet(wallet, settings)
  await validateConnections(settings)
  await checkFreshReceiver(recipient, settings)
  if (signal?.aborted) throw stopped('Batch preparation was cancelled.')
  const session = createWithdrawalSigner(wallet, notes, settings, approve, signal)
  try {
    const withdrawal = await new Promise<Withdrawal>((resolve, reject) => {
      const frame = document.createElement('iframe')
      frame.hidden = true; frame.title = 'Local wallet-signed multi-note proof session'
      const channel = new MessageChannel()
      let closed = false, signing = false, nextRequest = 1
      const cleanup = () => { closed = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); channel.port1.close(); channel.port2.close(); frame.remove() }
      const fail = (error: Error) => { if (!closed) { cleanup(); reject(error) } }
      const abort = () => fail(stopped('Batch preparation was cancelled.'))
      const timer = setTimeout(() => fail(stopped('Batch preparation timed out.')), 900_000)
      signal?.addEventListener('abort', abort, { once: true })
      channel.port1.onmessage = async ({ data }) => {
        if (closed) return
        if (data.status === 'progress') progress(data.message)
        if (data.status === 'sign') {
          if (signing || data.id !== nextRequest++ || !['signAuthorization', 'signTypedData'].includes(data.method)) return fail(new Error('Unexpected wallet signing request.'))
          signing = true
          try {
            const result = data.method === 'signAuthorization' ? await session.signer.signAuthorization(data.request) : await session.signer.signTypedData(data.request)
            if (!closed) {
              channel.port1.postMessage({ status: 'signature', id: data.id, result })
              if (data.method === 'signTypedData') sharedCandidate = true
            }
          } catch (error) { fail(new Error(safeError(error))) }
          finally { signing = false }
        }
        if (data.status === 'ready') {
          if (signing) return fail(new Error('The proof session finished while a wallet request was still pending.'))
          cleanup(); resolve(data.withdrawal)
        }
        if (data.status === 'error') fail(new Error(data.message))
      }
      frame.onload = () => {
        if (!closed) frame.contentWindow!.postMessage({ type: 'tornado-multi-prepare', notes: notes.map(n => n.raw), recipient, settings }, location.origin, [channel.port2])
      }
      frame.onerror = () => fail(new Error('Could not load the local batch proof session.'))
      frame.src = appAssetUrl('withdraw-frame.html')
      if (signal?.aborted) abort()
      else document.body.append(frame)
    })
    const { fee, net } = validateMultiWithdrawal(notes, recipient, withdrawal, settings)
    const signedHash = await session.verifyPrepared(withdrawal)
    return { id: crypto.randomUUID(), notes, recipient, withdrawal, fee, net, quotedAt: Date.now(), signedHash }
  } catch (error) {
    if (sharedCandidate) throw new Error(`${safeError(error).slice(0, 300)} A signed UserOperation may still be executable; check the receiver before retrying.`)
    throw error
  } finally { session.dispose() }
}

export async function submitMultiWithdrawal(quote: MultiWithdrawalQuote, settings: ConnectionSettings, wallet: WithdrawalWallet, update: Update) {
  if (Date.now() - quote.quotedAt > 5 * 60_000) throw new Error('This batch quote expired. Prepare a new review.')
  const result = validateMultiWithdrawal(quote.notes, quote.recipient, quote.withdrawal, settings)
  if (result.fee !== quote.fee || result.net !== quote.net) throw new Error('The batch changed after review.')
  if (hashTypedData(batchTypedData(quote.withdrawal, settings)) !== quote.signedHash) throw new Error('The signed batch changed after wallet approval.')
  if (wallet.account.toLowerCase() !== quote.recipient.toLowerCase()) throw new Error('Reconnect the receiver wallet before submitting this batch.')
  await assertWithdrawalWallet(wallet, settings)
  await validateConnections(settings)
  await checkFreshReceiver(quote.recipient, settings)
  await assertWithdrawalWallet(wallet, settings)
  update(quote.id, { status: 'submitted', hash: quote.signedHash })
  try {
    const hash = await jsonRpc<Hex>(settings.bundlerUrl, 'eth_sendUserOperation', [quote.withdrawal.userOperation, quote.withdrawal.entryPointAddress])
    if (!isHash(hash) || hash.toLowerCase() !== quote.signedHash.toLowerCase()) throw new Error('The bundler returned an unexpected UserOperation hash. Check the locally computed hash before retrying.')
    update(quote.id, { hash, status: 'submitted' })
    const tx = await reconcileWithdrawal(settings.bundlerUrl, hash)
    update(quote.id, { status: 'confirmed', message: `Transaction ${tx}` })
  } catch (error) {
    update(quote.id, { status: 'unknown', message: 'Check the UserOperation before retrying. Keep all notes and the receiver wallet for recovery.' })
    throw error
  }
}
