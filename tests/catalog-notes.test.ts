import { describe, expect, it } from 'vitest'
import { decodeFunctionData, parseEther, parseUnits } from 'viem'
import { TornadoPaymasterConfigs } from '@kohaku-eth/tornado-cash'
import { assetsFor, depositBatchLimit, depositCart, expandSelection, parseAmount, poolFor, poolsFor, supportsClassicRelayer, totalValue } from '../src/core/catalog'
import { extractNoteStrings, generateNote, parseBatchNotes, parseNote, poolAbi } from '../src/core/notes'

const note = (currency = 'eth', d = '0.1', chain = 1, byte = 'ab') => `tornado-${currency}-${d}-${chain}-0x${byte.repeat(62)}`
describe('note text-file extraction', () => {
  it('strips a seed phrase, headings and metadata while retaining every note in order', () => {
    const notes = [note(), note('eth', '1', 1, 'cd')]
    const text = `------- SEED PHRASE (SECRET) --------\r\npublic test words only\r\n-------------------------------------\r\n` +
      `-------- NOTES (SECRET) --------\r\n${notes.join('\r\n')}\r\n--------------------------------\r\n` +
      '-------- METADATA --------\r\nNote nonces: 0, 1.\r\nhttps://example.com/derivation.ts\r\n'
    expect(extractNoteStrings(text)).toEqual(notes)
    expect(parseBatchNotes(extractNoteStrings(text).join('\n'), 1).map(note => note.raw)).toEqual(notes)
    expect(() => parseNote(extractNoteStrings(text).join('\n'), 1)).toThrow('one note at a time')
  })
  it('accepts plain notes and quoted/labeled notes without surrounding punctuation', () => {
    const raw = note('dai', '100', 1, 'AB')
    expect(extractNoteStrings(`\ufeff${raw}\n`)).toEqual([raw])
    expect(extractNoteStrings(`Note: "${raw}",\nMetadata: backup`)).toEqual([raw])
    expect(parseNote(extractNoteStrings(`SEED PHRASE\npublic fixture words\nNOTES\n${raw}\nMETADATA\nnonce 0`).join('\n'), 1).raw).toBe(raw)
  })
  it('does not silently drop duplicates, malformed notes or notes from another network', () => {
    expect(() => parseBatchNotes(extractNoteStrings(`${note()}\n${note()}`).join('\n'), 1)).toThrow('duplicate')
    const malformed = note().slice(0, -2)
    const wrongChain = note('eth', '1', 11155111, 'cd')
    expect(extractNoteStrings(`${note()}\n${malformed}\n${wrongChain}`)).toEqual([note(), malformed, wrongChain])
    expect(() => parseNote(extractNoteStrings(malformed).join('\n'), 1)).toThrow('supported withdrawal')
    expect(() => parseBatchNotes(extractNoteStrings(`${note()}\n${wrongChain}`).join('\n'), 1)).toThrow('different network')
  })
  it('rejects files with no notes without echoing secret or metadata text', () => {
    const text = 'SEED PHRASE\nprivate fixture words\nMETADATA\nno notes here'
    expect(() => extractNoteStrings(text)).toThrow('No Tornado note strings were found')
    expect(() => extractNoteStrings(text)).not.toThrow('private fixture words')
  })
})

describe('the same deposit and withdrawal catalog as kohaku-cli', () => {
  it('includes every mainnet ETH denomination and leaves Sepolia 100 unavailable', () => {
    expect(poolsFor(1, 'ETH').map(p => p.denomination)).toEqual(['0.01', '0.03', '0.1', '0.3', '1', '3', '10', '30', '100'])
    expect(poolsFor(11155111, 'ETH')).toHaveLength(8)
    expect(poolFor(11155111, '100')).toBeUndefined()
  })
  it('exposes only tokens with a configured paymaster path', () => {
    expect(assetsFor(1).map(a => a.symbol).sort()).toEqual(['DAI', 'ETH', 'USDC', 'USDT', 'WBTC'])
    expect(assetsFor(11155111).map(a => a.symbol).sort()).toEqual(['DAI', 'ETH'])
    for (const chain of [1, 11155111] as const) {
      expect(poolsFor(chain).every(p => TornadoPaymasterConfigs[chain].supportedPools.some(a => a.toLowerCase() === p.address.toLowerCase()))).toBe(true)
    }
  })
  it.each([1, 11155111] as const)('limits Classic relayers to original pool addresses on chain %s', chain => {
    expect(poolsFor(chain, 'ETH').filter(supportsClassicRelayer).map(p => p.denomination))
      .toEqual(chain === 1 ? ['0.1', '1', '10', '100'] : ['0.1', '1'])
    expect(poolsFor(chain).filter(p => p.asset.token).every(supportsClassicRelayer)).toBe(true)
    expect(supportsClassicRelayer({ ...poolFor(chain, '1')!, address: '0x1111111111111111111111111111111111111111' })).toBe(false)
  })
  it('rejects both deposits and imports for deposit-only/unknown tokens', () => {
    expect(() => expandSelection(1, [{ denomination: '5000', count: 1 }], 'cDAI')).toThrow('unavailable')
    expect(() => parseNote(note('cdai', '5000'), 1)).toThrow('unavailable')
    expect(() => parseNote(note('usdc', '100', 11155111), 11155111)).toThrow('unavailable')
  })
})
describe('note cart arithmetic', () => {
  it('sums 3-style denominations exactly without floating point', () => {
    const pools = expandSelection(1, [{ denomination: '0.03', count: 3 }, { denomination: '0.01', count: 1 }])
    expect(totalValue(pools)).toBe(parseEther('0.1'))
    expect(pools).toHaveLength(4)
  })
  it('preserves ERC-20 decimals', () => {
    expect(totalValue(expandSelection(1, [{ denomination: '100', count: 2 }], 'USDC'))).toBe(parseUnits('200', 6))
    expect(totalValue(expandSelection(1, [{ denomination: '0.1', count: 2 }], 'WBTC'))).toBe(parseUnits('0.2', 8))
  })
  it('allows sessions larger than one batch and itemizes each denomination exactly', () => {
    const selection = [{ denomination: '0.1', count: 25 }, { denomination: '0.03', count: 3 }]
    expect(expandSelection(1, selection)).toHaveLength(28)
    expect(depositCart(1, selection).map(row => [row.count, row.total])).toEqual([[25, parseEther('2.5')], [3, parseEther('0.09')]])
    expect(totalValue(expandSelection(1, selection))).toBe(parseEther('2.59'))
    expect(depositBatchLimit(poolFor(1, '1')!.asset)).toBe(12)
    expect(depositBatchLimit(poolFor(1, '100', 'USDC')!.asset)).toBe(5)
  })
  it('rejects invalid quantities and empty carts', () => {
    for (const count of [-1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => expandSelection(1, [{ denomination: '1', count }])).toThrow()
    expect(() => expandSelection(1, [{ denomination: '1', count: 0 }])).toThrow('Select')
    expect(() => expandSelection(11155111, [{ denomination: '100', count: 1 }])).toThrow('unavailable')
  })
  it('calculates a large cart without expanding a note array', () => {
    const rows = depositCart(1, [{ denomination: '0.01', count: 1_000_000 }])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.total).toBe(parseEther('10000'))
  })
  it('does not round over-precise user amounts', () => {
    expect(parseAmount('1.75', 18)).toBe(parseEther('1.75'))
    for (const input of ['1e2', '-1', '0', 'NaN', '1.0000001']) expect(() => parseAmount(input, 6)).toThrow()
  })
})
describe('independent Classic notes', () => {
  it('generates independent notes and binds the call to the SDK commitment', async () => {
    const pool = poolFor(1, '0.03')!
    const a = await generateNote(pool), b = await generateNote(pool)
    expect(a.raw).not.toBe(b.raw)
    expect(parseNote(a.raw, 1).preimage).toHaveLength(124)
    expect(a.call.to).toBe(pool.address)
    expect(a.call.value).toBe(parseEther('0.03'))
    const decoded = decodeFunctionData({ abi: poolAbi, data: a.call.data })
    expect(decoded.functionName).toBe('deposit')
    expect(decoded.args).toEqual([a.commitment])
  })
  it('makes ERC-20 deposits zero ETH value and uses token metadata in the note', async () => {
    const generated = await generateNote(poolFor(1, '100', 'USDC')!)
    expect(generated.call.value).toBe(0n)
    expect(generated.raw.startsWith('tornado-usdc-100-1-0x')).toBe(true)
    expect(parseNote(generated.raw, 1).pool.asset.decimals).toBe(6)
  })
  it('rejects wrong chains and malformed or empty preimages', () => {
    expect(() => parseNote(note(), 11155111)).toThrow('different network')
    expect(() => parseNote(note().slice(0, -2), 1)).toThrow('supported withdrawal')
    expect(() => parseNote('garbage', 1)).toThrow()
    expect(() => parseNote('', 1)).toThrow('Paste one')
  })
  it('accepts a single exported note with surrounding whitespace and normalizes its preimage', () => {
    const raw = note('dai', '100', 1, 'AB')
    const result = parseNote(`\r\n ${raw} \r\n\r\n`, 1)
    expect(result.raw).toBe(raw)
    expect(result.preimage).toBe('ab'.repeat(62))
    expect(result.pool.asset.symbol).toBe('DAI')
  })
  it('rejects all multi-note input instead of silently selecting or queuing a note', () => {
    for (const input of [
      `${note()}\n${note()}`,
      `${note()}\r\n\r\n${note('dai', '100', 1, 'cd')}`,
      `${note()}\n${note('eth', '0.1', 1, 'AB')}`,
      Array(21).fill(note()).join('\n'),
    ]) expect(() => parseNote(input, 1)).toThrow('one note at a time')
  })
})
