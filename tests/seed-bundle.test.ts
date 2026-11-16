import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, toHex } from 'viem'
import vectors from './fixtures/seeded-deposits.json'
import { poolFor, type ChainId } from '../src/core/catalog'
import { depositBatches } from '../src/core/deposit-session'
import { noteIdentity } from '../src/core/batch-policy'
import { extractNoteStrings, parseBatchNotes, parseNote, poolAbi } from '../src/core/notes'
import { formatDepositBackup, generateSeededDepositBundle, SEED_BUNDLE_RECOVERY } from '../src/core/seed-bundle'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function publicTestEntropy() {
  // Public BIP-39 zero-entropy fixture, never used by the application.
  return vi.spyOn(crypto, 'getRandomValues').mockImplementation(buffer => {
    new Uint8Array(buffer!.buffer, buffer!.byteOffset, buffer!.byteLength).fill(0)
    return buffer
  })
}

describe('optional seed-backed deposit sessions', () => {
  it.each(vectors.groups)('matches the CLI for $symbol on chain $chainId', async group => {
    publicTestEntropy()
    const pools = group.denominations.map(d => poolFor(group.chainId as ChainId, d, group.symbol)!)
    const bundle = await generateSeededDepositBundle(pools)
    expect(bundle.seedPhrase).toBe(vectors.mnemonic)
    expect(SEED_BUNDLE_RECOVERY.signingPath).toBe("m/29795'/1'/0'")
    expect(bundle.notes.map(n => ({ raw: n.raw, commitment: n.commitment, nonce: n.nonce })))
      .toEqual(group.notes.map(n => ({ raw: n.raw, commitment: n.commitment, nonce: n.nonce })))
    for (const [i, note] of bundle.notes.entries()) {
      expect(parseNote(note.raw, group.chainId as ChainId).preimage).toHaveLength(124)
      const identity = noteIdentity(note)
      expect(toHex(identity.nullifierHash, { size: 32 })).toBe(group.notes[i]!.nullifierHash)
      expect(toHex(identity.commitment, { size: 32 })).toBe(note.commitment)
      expect(decodeFunctionData({ abi: poolAbi, data: note.call.data }).args).toEqual([note.commitment])
      expect(note.call.to.toLowerCase()).toBe(group.notes[i]!.pool)
      expect(note.call.value).toBe(note.pool.asset.token ? 0n : note.pool.amount)
    }
  })
  it('uses 256 bits of CSPRNG entropy and consecutive nonces across denominations', async () => {
    const rng = publicTestEntropy()
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Insecure RNG must not be used') })
    const bundle = await generateSeededDepositBundle(['1', '0.01', '1', '3'].map(d => poolFor(1, d)!))
    expect(bundle.seedPhrase.split(' ')).toHaveLength(24)
    expect(rng).toHaveBeenCalledWith(expect.any(Uint8Array))
    expect(rng.mock.calls[0]![0]!.byteLength).toBe(32)
    expect(bundle.notes.map(n => n.nonce)).toEqual([0, 1, 2, 3])
    expect(new Set(bundle.notes.map(n => n.commitment)).size).toBe(4)
  })
  it('creates a new phrase and notes for every new session', async () => {
    const pools = [poolFor(1, '0.01')!]
    const a = await generateSeededDepositBundle(pools), b = await generateSeededDepositBundle(pools)
    expect(a.seedPhrase).not.toBe(b.seedPhrase)
    expect(a.notes[0]!.commitment).not.toBe(b.notes[0]!.commitment)
    expect(a.notes[0]!.nonce).toBe(0)
    expect(b.notes[0]!.nonce).toBe(0)
  })
  it('fails closed when secure randomness is unavailable, without disclosing library details', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => { throw new Error('private entropy provider detail') })
    await expect(generateSeededDepositBundle([poolFor(1, '1')!])).rejects.toThrow('Could not securely generate')
    await expect(generateSeededDepositBundle([poolFor(1, '1')!])).rejects.not.toThrow('private entropy')
  })
  it('keeps one phrase and continuous nonces across more than two wallet batches', async () => {
    publicTestEntropy()
    const bundle = await generateSeededDepositBundle(Array(25).fill(poolFor(1, '0.01')!))
    expect(bundle.seedPhrase).toBe(vectors.mnemonic)
    expect(depositBatches(bundle.notes).map(notes => notes.map(note => note.nonce)))
      .toEqual([Array.from({ length: 12 }, (_, i) => i), Array.from({ length: 12 }, (_, i) => i + 12), [24]])
    expect(new Set(bundle.notes.map(note => note.commitment)).size).toBe(25)
    const backup = formatDepositBackup(bundle.notes, bundle.seedPhrase)
    expect(backup.match(/SEED PHRASE/g)).toHaveLength(1)
    expect(backup.split('\n').filter(line => line.startsWith('tornado-'))).toHaveLength(25)
  })
  it('rejects empty, mixed-network and mixed-asset sessions before generating entropy', async () => {
    const rng = vi.spyOn(crypto, 'getRandomValues')
    for (const pools of [[], [poolFor(1, '1')!, poolFor(11155111, '1')!],
      [poolFor(1, '1')!, poolFor(1, '100', 'USDC')!]]) await expect(generateSeededDepositBundle(pools)).rejects.toThrow()
    expect(rng).not.toHaveBeenCalled()
  })
  it('downloads the phrase, every raw note and recovery metadata together; withdrawals stay note-only', async () => {
    publicTestEntropy()
    const bundle = await generateSeededDepositBundle([poolFor(1, '1')!, poolFor(1, '0.01')!])
    const backup = formatDepositBackup(bundle.notes, bundle.seedPhrase)
    expect(backup).toContain(`------- SEED PHRASE (SECRET) --------\n${bundle.seedPhrase}\n`)
    expect(backup).toContain(`-------- NOTES (SECRET) --------\n${bundle.notes.map(n => n.raw).join('\n')}\n`)
    const metadata = backup.split('-------- METADATA --------\n')[1]!
    expect(metadata).toContain('Anyone with the seed phrase above can find and control ALL of these Tornado notes.')
    expect(metadata).toContain('anyone with access to it can spend that note.')
    expect(metadata).toContain('https://github.com/ethereum/kohaku/blob/886f72ddd6e36d43e53675fc359fd4a315590ee8/packages/tornado-cash/src/account/signature-keys.ts')
    expect(metadata).toContain('/packages/plugins/src/host/mnemonic-keystore.ts')
    expect(metadata).not.toContain(bundle.seedPhrase)
    expect(bundle.notes.every(note => !metadata.includes(note.raw))).toBe(true)
    expect(backup).not.toContain('Signing path:')
    expect(backup).not.toContain('m/29795')
    expect(backup).toContain('Note nonces: 0, 1')
    expect(extractNoteStrings(backup)).toEqual(bundle.notes.map(note => note.raw))
    expect(parseBatchNotes(extractNoteStrings(backup).join('\n'), 1).map(note => note.raw)).toEqual(bundle.notes.map(note => note.raw))
    expect(() => parseNote(backup, 1)).toThrow('one note at a time')
    expect(() => parseNote(bundle.seedPhrase, 1)).toThrow('not a supported withdrawal note')
    expect(parseNote(bundle.notes[0]!.raw, 1).raw).toBe(bundle.notes[0]!.raw)
    expect(formatDepositBackup(bundle.notes)).toBe(bundle.notes.map(n => n.raw).join('\n') + '\n')
  })
})
