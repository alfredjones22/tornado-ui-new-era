import { appAssetUrl } from './app-assets'
import { TornadoPaymasterConfigs, type TCInstance, type TCBroadcaster, type TornadoCashProtocol } from '@kohaku-eth/tornado-cash'
import { decodeAbiParameters, isAddress, parseAbiParameters, type Address, type Hex } from 'viem'
import { parseNote, type ParsedNote } from './notes'
import { jsonRpc, validateConnections, type ConnectionSettings } from './rpc'
import { isHash, pause, type Progress, type Update } from './wallet'
import type { RelayerInfo } from './relayers'
import { walletRpcBridge } from './wallet-rpc'

type Operation = Awaited<ReturnType<TCInstance['prepareUnshield']>>
export type Withdrawal = Extract<Operation['withdrawals'][number], { mode: 'paymaster' }>
export type RelayerWithdrawal = Extract<Parameters<TCBroadcaster['broadcast']>[0]['withdrawals'][number], { mode: 'relayer' }>
export type PublicSnapshot = Awaited<ReturnType<TornadoCashProtocol['dumpState']>>
const publicHistory = new Map<string, PublicSnapshot>()
export interface WithdrawalQuote { id: string; note: ParsedNote; withdrawal: Withdrawal; fee: bigint; net: bigint; quotedAt: number; recipient: Address }

export function validateWithdrawal(note: ParsedNote, recipient: Address, withdrawal: Withdrawal, settings: ConnectionSettings) {
  const cfg = TornadoPaymasterConfigs[settings.chainId]
  if (withdrawal.mode !== 'paymaster' || withdrawal.bundlerUrl !== settings.bundlerUrl || withdrawal.entryPointAddress.toLowerCase() !== cfg.entryPointAddress.toLowerCase()) throw new Error('The withdrawal transport does not match the reviewed settings.')
  const op = withdrawal.userOperation
  if (op.paymaster?.toLowerCase() !== cfg.paymasterAddress.toLowerCase()) throw new Error('Unexpected paymaster in prepared withdrawal.')
  if (withdrawal.poolAddress !== BigInt(note.pool.address) || withdrawal.isERC20 !== Boolean(note.pool.asset.token)) throw new Error('The prepared withdrawal does not match the note pool.')
  if (withdrawal.withdrawnValue !== undefined && withdrawal.withdrawnValue !== note.pool.amount) throw new Error('The prepared withdrawal does not spend the full note.')
  if (BigInt(withdrawal.proof.args[2]) !== BigInt(recipient)) throw new Error('The proof recipient does not match the reviewed recipient and quote.')
  if (BigInt(withdrawal.proof.args[3]) !== BigInt(cfg.paymasterAddress) || BigInt(withdrawal.proof.args[5]) !== 0n) throw new Error('The proof paymaster or refund input is inconsistent.')
  if (op.callData !== '0x' || BigInt(op.callGasLimit) !== 0n || BigInt(op.nonce) !== 0n) throw new Error('Single-note withdrawals must pay the recipient directly with zero execution gas and no forwarding calls.')
  if (!op.eip7702Auth || Number(BigInt(op.eip7702Auth.chainId)) !== settings.chainId) throw new Error('The executor authorization is on a different network.')
  const fee = BigInt(withdrawal.proof.args[4])
  if (fee <= 0n || fee >= note.pool.amount) throw new Error('The quoted fee cannot be covered by this note.')
  const estimation = withdrawal.gasEstimation
  if (estimation?.status !== 'estimated' && !(estimation?.status === 'fallback' &&
    ['bundler-internal', 'transport-unavailable'].includes(estimation.reason))) throw new Error('The withdrawal has no valid gas estimate or SDK fallback.')
  if (!op.paymasterData) throw new Error('The sponsored withdrawal is missing its proof data.')
  const [sponsor] = decodeAbiParameters(parseAbiParameters('(address instance, bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, uint256 fee)'), op.paymasterData)
  if (sponsor.instance.toLowerCase() !== note.pool.address.toLowerCase() || sponsor.proof !== withdrawal.proof.proof ||
    sponsor.root !== withdrawal.proof.args[0] || sponsor.nullifierHash !== withdrawal.proof.args[1] ||
    sponsor.recipient.toLowerCase() !== recipient.toLowerCase() || sponsor.fee !== fee) throw new Error('The paymaster data does not match the reviewed note proof.')
  const net = note.pool.amount - fee
  return { fee, net }
}

export async function prepareInFrame(note: ParsedNote, recipient: Address, settings: ConnectionSettings, onProgress: (message: string) => void,
  route: 'paymaster' | 'relayer' = 'paymaster'): Promise<{ withdrawal: Withdrawal | RelayerWithdrawal; relayer?: RelayerInfo }> {
  return new Promise((resolve, reject) => {
    const historyKey = `${settings.chainId}:${settings.rpcUrl}:${note.pool.address}`
    const frame = document.createElement('iframe')
    frame.hidden = true; frame.title = 'Local withdrawal proof session'
    const channel = new MessageChannel()
    const readBridge = walletRpcBridge(channel.port1, settings.chainId)
    let settled = false
    const cleanup = () => { settled = true; clearTimeout(timer); readBridge.dispose(); channel.port1.close(); channel.port2.close(); frame.remove() }
    const fail = (message: string) => { if (!settled) { cleanup(); reject(new Error(message)) } }
    let timer: ReturnType<typeof setTimeout>
    const keepAlive = () => {
      clearTimeout(timer)
      timer = setTimeout(() => fail(route === 'relayer' ? 'Relayer discovery or proof preparation timed out. No withdrawal was submitted.' : 'Proof preparation timed out. Preserve your note before retrying; signed estimation candidates may already be executable.'), 600_000)
    }
    keepAlive()
    channel.port1.onmessage = event => {
      if (settled) return
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.status === 'read-rpc') { void readBridge.handle(data); return }
      if (data.status === 'progress' && typeof data.message === 'string') { keepAlive(); onProgress(data.message) }
      if (data.status === 'ready') {
        if (data.publicState) publicHistory.set(historyKey, data.publicState)
        cleanup(); resolve({ withdrawal: data.withdrawal, relayer: data.relayer })
      }
      if (data.status === 'error') fail(typeof data.message === 'string' ? data.message : 'The local proof session failed.')
    }
    frame.onload = () => {
      if (settled) return
      try {
        if (!frame.contentWindow) throw new Error('Missing proof session window')
        frame.contentWindow.postMessage({ type: 'tornado-prepare', route, note, recipient, settings, walletRpc: readBridge.enabled, initialState: publicHistory.get(historyKey) }, location.origin, [channel.port2])
      } catch { fail('Could not start the local proof session. Please try again.') }
    }
    frame.onerror = () => fail('Could not load the local proof session.')
    frame.src = appAssetUrl('withdraw-frame.html')
    document.body.append(frame)
  })
}

export async function prepareWithdrawal(input: string, recipient: string, settings: ConnectionSettings, progress: (message: string) => void): Promise<WithdrawalQuote> {
  const note = parseNote(input, settings.chainId)
  if (!isAddress(recipient) || BigInt(recipient) === 0n) throw new Error('Enter a valid nonzero recipient address.')
  await validateConnections(settings)
  const { withdrawal } = await prepareInFrame(note, recipient, settings, progress)
  if (withdrawal.mode !== 'paymaster') throw new Error('Expected a 4337 paymaster withdrawal.')
  const { fee, net } = validateWithdrawal(note, recipient, withdrawal, settings)
  return { id: crypto.randomUUID(), note, withdrawal, fee, net, quotedAt: Date.now(), recipient }
}

export async function reconcileWithdrawal(url: string, hash: Hex, timeout = 180_000) {
  const end = Date.now() + timeout
  do {
    const result = await jsonRpc<{ success: boolean; receipt: { transactionHash: Hex } } | null>(url, 'eth_getUserOperationReceipt', [hash])
    if (result) {
      if (!result.success) throw new Error('The operation reported a failure. Check the recipient and transaction before retrying.')
      return result.receipt.transactionHash
    }
    await pause(2000)
  } while (Date.now() < end)
  throw new Error('The withdrawal is still pending. Check its UserOperation before retrying.')
}

export async function submitWithdrawal(quote: WithdrawalQuote, settings: ConnectionSettings, update: Update) {
  if (Array.isArray(quote)) throw new Error('Withdraw one note at a time. Multiple withdrawals cannot be queued.')
  const note = parseNote(quote.note.raw, settings.chainId)
  if (Date.now() - quote.quotedAt > 5 * 60_000) throw new Error('This fee quote expired. Prepare a new review before submitting.')
  const { fee, net } = validateWithdrawal(note, quote.recipient, quote.withdrawal, settings)
  if (quote.fee !== fee || quote.net !== net) throw new Error('The withdrawal no longer matches the reviewed fee and proceeds.')
  await validateConnections(settings)
  update(quote.id, { status: 'submitted' })
  try {
    const { userOperation, entryPointAddress } = quote.withdrawal
    const hash = await jsonRpc<Hex>(settings.bundlerUrl, 'eth_sendUserOperation', [userOperation, entryPointAddress])
    if (!isHash(hash)) throw new Error('The bundler returned no UserOperation hash.')
    update(quote.id, { hash, status: 'submitted' })
    const txHash = await reconcileWithdrawal(settings.bundlerUrl, hash)
    update(quote.id, { status: 'confirmed', transactionHash: txHash, message: undefined })
  } catch (error) {
    update(quote.id, { status: 'unknown', message: 'Check the bundler receipt and preserve the original note before retrying.' })
    throw error
  }
}
