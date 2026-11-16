import { SecretManager } from '@kohaku-eth/tornado-cash'
import { bytesToHex, encodeFunctionData, parseAbi, toHex, type Hex } from 'viem'
import { poolFor, type ChainId, type Pool } from './catalog'

export const poolAbi = parseAbi([
  'function deposit(bytes32 commitment) payable',
  'function denomination() view returns (uint256)',
  'function nextIndex() view returns (uint32)',
  'function withdraw(bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, address relayer, uint256 fee, uint256 refund)',
])
export interface ParsedNote { raw: string; preimage: string; pool: Pool }
export interface DepositNote extends ParsedNote { id: string; commitment: Hex; nonce?: number; call: { to: Hex; data: Hex; value: bigint } }
export const MAX_MULTI_NOTES = 12

/** Extract notes from backup prose without putting its seed phrase or metadata in a form.
 * Preserve order, duplicates and malformed note-like tokens for the normal validators. */
export function extractNoteStrings(text: string): string[] {
  const notes = text.match(/(?<![\w-])tornado-[a-zA-Z0-9]+-[\d.]+-\d+-0x[a-zA-Z0-9]+(?![\w-])/g)
  if (!notes?.length) throw new Error('No Tornado note strings were found in this file.')
  return notes
}

export function parseBatchNotes(input: string, chainId: ChainId, minimum = 2): ParsedNote[] {
  const lines = input.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (lines.length < minimum || lines.length > MAX_MULTI_NOTES) throw new Error(`Use ${minimum}–${MAX_MULTI_NOTES} notes for a ${minimum === 1 ? 'smart account' : 'multi-note'} withdrawal.`)
  const notes = lines.map(line => parseNote(line, chainId))
  if (notes.some(note => note.pool.asset.symbol !== notes[0]!.pool.asset.symbol)) throw new Error('Use notes of one asset per batch. Different denominations are allowed.')
  const nullifiers = notes.map(note => note.preimage.slice(0, 62))
  if (new Set(nullifiers).size !== notes.length) throw new Error('The batch contains duplicate notes or reused nullifiers.')
  return notes
}

export function parseNote(input: string, chainId: ChainId): ParsedNote {
  const lines = input.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (!lines.length) throw new Error('Paste one withdrawal note.')
  if (lines.length !== 1) throw new Error('Withdraw one note at a time. Paste or import a single note; multiple notes cannot be queued.')
  const raw = lines[0]!
  const match = /^tornado-([a-zA-Z0-9]+)-([0-9.]+)-(1|11155111)-0x([\da-fA-F]{124})$/.exec(raw)
  if (!match) throw new Error('This is not a supported withdrawal note.')
  if (Number(match[3]) !== chainId) throw new Error('This note belongs to a different network.')
  const pool = poolFor(chainId, match[2]!, match[1]!)
  if (!pool) throw new Error('This note uses an unavailable denomination.')
  return { raw, pool, preimage: match[4]!.toLowerCase() }
}

function littleEndian31(value: bigint): string {
  return Array.from({ length: 31 }, (_, i) => Number((value >> BigInt(i * 8)) & 255n).toString(16).padStart(2, '0')).join('')
}

export async function generateNote(pool: Pool): Promise<DepositNote> {
  // This ephemeral keystore exists only to use the SDK's secret/commitment
  // encoding. Each note gets independent entropy; no HD seed is retained.
  const keys = new Map<string, Hex>()
  const manager = await SecretManager({ host: { keystore: { deriveAt: async path => {
    if (!keys.has(path)) keys.set(path, bytesToHex(crypto.getRandomValues(new Uint8Array(32))))
    return keys.get(path)!
  } } } })
  const secret = await manager.getLegacyDepositSecrets({ chainId: BigInt(pool.chainId), poolAddress: BigInt(pool.address), depositIndex: 0 })
  keys.clear()
  return depositNoteFromSecrets(pool, secret)
}

export function depositNoteFromSecrets(pool: Pool, secret: { nullifier: bigint; salt: bigint; commitment: bigint }): DepositNote {
  const preimage = littleEndian31(secret.nullifier) + littleEndian31(secret.salt)
  const raw = `tornado-${pool.asset.symbol.toLowerCase()}-${pool.denomination}-${pool.chainId}-0x${preimage}`
  const commitment = toHex(secret.commitment, { size: 32 })
  return { raw, preimage, pool, commitment, id: crypto.randomUUID(), call: {
    to: pool.address, value: pool.asset.token ? 0n : pool.amount,
    data: encodeFunctionData({ abi: poolAbi, functionName: 'deposit', args: [commitment] }),
  } }
}

export function downloadText(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
