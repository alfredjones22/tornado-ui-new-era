import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TornadoPaymasterConfigs } from '@kohaku-eth/tornado-cash'
import { encodeFunctionData, parseAbi, toHex } from 'viem'
import { SIMPLE_7702_IMPLEMENTATION } from '../src/core/batch-policy'
import { fixture, rawNote, recipient, settings } from './fixtures/multi-withdrawal'
import type { WalletProvider } from '../src/core/wallet'
import { generateNote, parseBatchNotes, parseNote, poolAbi } from '../src/core/notes'
import { poolFor } from '../src/core/catalog'
import { checkFreshReceiver, noteIdentity, prepareMultiWithdrawal, submitMultiWithdrawal, validateMultiWithdrawal } from '../src/core/multi-withdrawal'
import { jsonRpc, publicClientFor, validateConnections } from '../src/core/rpc'
import type { Withdrawal } from '../src/core/withdrawals'
import type { Progress } from '../src/core/wallet'

vi.mock('../src/core/rpc', async original => ({ ...await original<object>(), jsonRpc: vi.fn(), validateConnections: vi.fn(), publicClientFor: vi.fn() }))
const cfg = TornadoPaymasterConfigs[1]
const executorAbi = parseAbi(['function execute(address target, uint256 value, bytes data)', 'function executeBatch((address target, uint256 value, bytes data)[] calls)'])
const provider: WalletProvider = { request: vi.fn() }
const wallet = { provider, account: recipient }
const getTransactionCount = vi.fn(), readContract = vi.fn(), getCode = vi.fn()
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(provider.request).mockImplementation(async ({ method }) => method === 'eth_chainId' ? '0x1' : [recipient])
  getTransactionCount.mockResolvedValue(0); readContract.mockResolvedValue(0n); getCode.mockResolvedValue('0x')
  vi.mocked(publicClientFor).mockReturnValue({ getTransactionCount, readContract, getCode } as unknown as ReturnType<typeof publicClientFor>)
})

describe('separate wallet input and receiver policy', () => {
  it('keeps single-note parsing strict while accepting mixed denominations in a batch', () => {
    const input = `${rawNote(1)}\n${rawNote(2, 'eth', '0.03')}`
    expect(parseBatchNotes(input, 1).map(n => n.pool.denomination)).toEqual(['1', '0.03'])
    expect(() => parseNote(input, 1)).toThrow('one note at a time')
  })
  it('rejects one/too many notes, duplicate secrets, mixed assets and wrong chains', () => {
    for (const input of [rawNote(1), Array.from({ length: 13 }, (_, i) => rawNote(i + 1)).join('\n'), `${rawNote(1)}\n${rawNote(1)}`, `${rawNote(1)}\n${rawNote(2, 'dai', '100')}`]) expect(() => parseBatchNotes(input, 1)).toThrow()
    expect(() => parseBatchNotes(`${rawNote(1)}\n${rawNote(2)}`, 11155111)).toThrow('different network')
  })
  it('checks receiver code and both transaction and EntryPoint nonces', async () => {
    await checkFreshReceiver(recipient, settings)
    expect(getTransactionCount).toHaveBeenCalledWith({ address: recipient, blockTag: 'pending' })
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'getNonce', args: [recipient, 0n] }))
    expect(getCode).toHaveBeenCalledWith({ address: recipient, blockTag: 'pending' })
    getTransactionCount.mockResolvedValueOnce(1)
    await expect(checkFreshReceiver(recipient, settings)).rejects.toThrow('already been used')
    readContract.mockResolvedValueOnce(1n)
    await expect(checkFreshReceiver(recipient, settings)).rejects.toThrow('already been used')
  })
  it('rejects a contract wallet even if its reported nonces are zero', async () => {
    getCode.mockResolvedValue('0x6001600055')
    await expect(checkFreshReceiver(recipient, settings)).rejects.toThrow('contract wallet, not an EOA')
  })
  it('reports an existing delegation distinctly from a used account', async () => {
    getTransactionCount.mockResolvedValue(1)
    getCode.mockResolvedValue(`0xef0100${SIMPLE_7702_IMPLEMENTATION.slice(2)}`)
    await expect(checkFreshReceiver(recipient, settings)).rejects.toThrow('already has a delegation')
  })
  it('accepts an unused EOA without requiring a balance or history check', async () => {
    getCode.mockResolvedValue(undefined)
    await expect(checkFreshReceiver(recipient, settings)).resolves.toBeUndefined()
  })
  it('keeps validation blocked when the code check fails', async () => {
    getCode.mockRejectedValue(new Error('RPC unavailable'))
    await expect(checkFreshReceiver(recipient, settings)).rejects.toThrow('RPC unavailable')
  })
  it('rejects a wallet mismatch or used receiver before proof preparation', async () => {
    const input = `${rawNote(1)}\n${rawNote(2)}`
    vi.mocked(provider.request).mockResolvedValueOnce('0xaa36a7')
    await expect(prepareMultiWithdrawal(input, wallet, settings, vi.fn(), vi.fn())).rejects.toThrow('Switch your wallet')
    expect(validateConnections).not.toHaveBeenCalled()
    getTransactionCount.mockResolvedValue(1)
    await expect(prepareMultiWithdrawal(input, wallet, settings, vi.fn(), vi.fn())).rejects.toThrow('already been used')
  })
})
describe('real consolidation payloads', () => {
  it('matches the SDK commitment encoding used to bind imported note identities', async () => {
    const note = await generateNote(poolFor(1, '0.03')!)
    expect(toHex(noteIdentity(note).commitment, { size: 32 })).toBe(note.commitment)
  })
  it.each([{ count: 2, asset: 'eth' }, { count: 12, asset: 'eth' }, { count: 3, asset: 'usdc' }])('validates every note for $count $asset notes in one operation', ({ count, asset }) => {
    const { quote } = fixture(count, asset)
    expect(validateMultiWithdrawal(quote.notes, recipient, quote.withdrawal, settings)).toEqual({ fee: quote.fee, net: quote.net })
  })
  it('rejects wrong sender, delegation target, nonce, paymaster, totals and fallback gas', () => {
    const cases: Array<(w: Withdrawal) => void> = [
      w => { w.userOperation.sender = cfg.paymasterAddress }, w => { w.userOperation.eip7702Auth!.address = recipient },
      w => { w.userOperation.nonce = '0x1' }, w => { w.userOperation.eip7702Auth!.nonce = '0x1' },
      w => { w.userOperation.paymaster = recipient }, w => { w.withdrawnValue = 1n },
      w => { w.gasEstimation = { status: 'fallback', reason: 'bundler-internal', message: '' } },
    ]
    for (const mutate of cases) { const { quote } = fixture(); mutate(quote.withdrawal); expect(() => validateMultiWithdrawal(quote.notes, recipient, quote.withdrawal, settings)).toThrow() }
  })
  it('rejects missing, repeated, extra or redirected direct calls', () => {
    for (const kind of ['missing', 'duplicate', 'extra', 'redirect']) {
      const { quote, calls } = fixture(3)
      const selected = kind === 'missing' ? calls.slice(1) : kind === 'duplicate' ? [calls[0]!, calls[0]!] : kind === 'extra' ? [...calls, calls[0]!] : calls.map(c => ({ ...c, target: recipient }))
      quote.withdrawal.userOperation.callData = encodeFunctionData({ abi: executorAbi, functionName: 'executeBatch', args: [selected] })
      expect(() => validateMultiWithdrawal(quote.notes, recipient, quote.withdrawal, settings)).toThrow()
    }
  })
  it('sends exactly one UserOperation for twelve notes', async () => {
    const { quote } = fixture(12), hash = quote.signedHash
    vi.mocked(jsonRpc).mockResolvedValueOnce(hash).mockResolvedValueOnce({ success: true, receipt: { transactionHash: hash } })
    let row: Partial<Progress> = {}
    await submitMultiWithdrawal(quote, settings, wallet, (_id, patch) => { row = { ...row, ...patch } })
    expect(row.status).toBe('confirmed'); expect(row.hash).toBe(hash)
    expect(vi.mocked(jsonRpc).mock.calls.filter(([, method]) => method === 'eth_sendUserOperation')).toHaveLength(1)
  })
  it('rechecks the receiver and quote before sending', async () => {
    const { quote } = fixture()
    getTransactionCount.mockResolvedValue(1)
    await expect(submitMultiWithdrawal(quote, settings, wallet, vi.fn())).rejects.toThrow('already been used')
    quote.quotedAt -= 6 * 60_000
    await expect(submitMultiWithdrawal(quote, settings, wallet, vi.fn())).rejects.toThrow('expired')
    expect(jsonRpc).not.toHaveBeenCalled()
  })
  it('rejects a changed gas budget after the wallet approved the batch', async () => {
    const { quote } = fixture()
    quote.withdrawal.userOperation.callGasLimit = '0xffffff'
    await expect(submitMultiWithdrawal(quote, settings, wallet, vi.fn())).rejects.toThrow('changed after wallet approval')
    expect(jsonRpc).not.toHaveBeenCalled()
  })
  it('retains the locally computed hash even when submission returns no response', async () => {
    const { quote } = fixture()
    vi.mocked(jsonRpc).mockRejectedValueOnce(new Error('Connection dropped'))
    let row: Partial<Progress> = {}
    await expect(submitMultiWithdrawal(quote, settings, wallet, (_id, patch) => { row = { ...row, ...patch } })).rejects.toThrow('Connection dropped')
    expect(row.status).toBe('unknown'); expect(row.hash).toBe(quote.signedHash)
    expect(vi.mocked(jsonRpc).mock.calls.filter(([, method]) => method === 'eth_sendUserOperation')).toHaveLength(1)
  })
  it('retains an ambiguous submission hash without retrying any notes', async () => {
    const { quote } = fixture(), hash = quote.signedHash
    vi.mocked(jsonRpc).mockResolvedValueOnce(hash).mockRejectedValueOnce(new Error('Disconnected'))
    let row: Partial<Progress> = {}
    await expect(submitMultiWithdrawal(quote, settings, wallet, (_id, patch) => { row = { ...row, ...patch } })).rejects.toThrow('Disconnected')
    expect(row.status).toBe('unknown'); expect(row.hash).toBe(hash)
    expect(vi.mocked(jsonRpc).mock.calls.filter(([, method]) => method === 'eth_sendUserOperation')).toHaveLength(1)
  })
})
