import type { Address } from 'viem'
import { depositBatchLimit } from './catalog'
import type { DepositNote } from './notes'
import { publicClientFor, type ConnectionSettings } from './rpc'
import { assertWallet, depositCalls, executeDeposits, waitForWalletBatch, type DepositCall, type Progress, type Update, type WalletProvider } from './wallet'

export function depositBatches(notes: readonly DepositNote[]): DepositNote[][] {
  const first = notes[0]
  if (!first) throw new Error('Select at least one note.')
  if (notes.some(note => note.pool.chainId !== first.pool.chainId || note.pool.asset.symbol !== first.pool.asset.symbol ||
    note.pool.asset.token?.toLowerCase() !== first.pool.asset.token?.toLowerCase())) throw new Error('Use one asset and one network per deposit session.')
  if (new Set(notes.map(note => note.id)).size !== notes.length || new Set(notes.map(note => note.raw)).size !== notes.length) throw new Error('The session contains duplicate notes.')
  const limit = depositBatchLimit(first.pool.asset)
  const batches: DepositNote[][] = []
  for (let i = 0; i < notes.length; i += limit) batches.push(notes.slice(i, i + limit))
  return batches
}

/** One backup/nonce sequence for the whole session; only one wallet batch in flight. */
export async function executeDepositSession(options: {
  notes: readonly DepositNote[]; provider: WalletProvider; account: Address; settings: ConnectionSettings; atomic: boolean; update: Update;
  onBatch: (number: number, total: number, calls: DepositCall[]) => void;
}) {
  const { provider, account, settings, atomic, update, onBatch } = options
  const batches = depositBatches(options.notes)
  if (batches[0]![0]!.pool.chainId !== settings.chainId) throw new Error('The deposit session is on a different network.')
  for (const [index, notes] of batches.entries()) {
    await assertWallet(provider, account, settings)
    // Read allowances after the preceding batch confirms: an earlier batch may
    // have consumed an allowance that looked sufficient before the session.
    const calls = (await depositCalls(notes, settings, account)).map(call => ({ ...call,
      id: notes.some(note => note.id === call.id) ? call.id : `batch-${index + 1}-${call.id}`,
    }))
    onBatch(index + 1, batches.length, calls)
    // A rejected/uncertain batch stops the session. Never fall back and resend
    // it, nor submit any later notes before this batch has confirmed.
    await executeDeposits({ provider, account, settings, atomic, calls, update })
  }
}

/** Reconcile only submitted calls, never mark later, unsent batches confirmed. */
export async function reconcileDepositSession(options: {
  rows: readonly Progress[]; settings: ConnectionSettings; provider?: WalletProvider; account?: Address; update: Update;
}) {
  const { rows, settings, provider, account, update } = options
  const pending = rows.filter(row => ['submitted', 'unknown', 'awaiting-wallet'].includes(row.status))
  const batchIds = [...new Set(pending.flatMap(row => row.batchId ? [row.batchId] : []))]
  if (batchIds.length) {
    if (!provider || !account) throw new Error('Connect the wallet and account that sent these deposits to check their batches.')
    await assertWallet(provider, account, settings)
    for (const batchId of batchIds) {
      const hash = await waitForWalletBatch(provider, batchId, 10_000)
      pending.filter(row => row.batchId === batchId).forEach(row => update(row.id, { status: 'confirmed', hash, transactionHash: hash, message: undefined }))
    }
  }
  for (const row of pending.filter(row => !row.batchId && row.hash)) {
    const receipt = await publicClientFor(settings).getTransactionReceipt({ hash: row.hash! })
    update(row.id, { status: receipt.status === 'success' ? 'confirmed' : 'failed', transactionHash: row.hash, message: undefined })
  }
  if (pending.some(row => !row.batchId && !row.hash)) throw new Error('A submission returned no identifier. Check the sending wallet before starting another session.')
}
