import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, toHex, type Hex } from 'viem'
import { complianceEvents, createComplianceReport } from '../src/core/compliance'
import { depositNoteFromSecrets, parseNote } from '../src/core/notes'
import { noteIdentity } from '../src/core/batch-policy'
import { poolFor, type ChainId } from '../src/core/catalog'
import { publicClientFor } from '../src/core/rpc'
import { loadCachedHistory } from '../src/core/history-cache'
import { createSagaHistory } from '../src/core/saga-history'
import type { PublicSnapshot } from '../src/core/withdrawals'

vi.mock('../src/core/rpc', async original => ({ ...await original<object>(), publicClientFor: vi.fn() }))
vi.mock('../src/core/history-cache', () => ({ loadCachedHistory: vi.fn() }))
vi.mock('../src/core/saga-history', () => ({ createSagaHistory: vi.fn() }))
const hash = (n: number) => toHex(n, { size: 32 })
const sender = '0x1111111111111111111111111111111111111111', recipient = '0x2222222222222222222222222222222222222222'
let settings = { chainId: 11155111 as ChainId, rpcUrl: 'https://rpc.example', bundler: 'custom' as const, bundlerUrl: '', sagaUrl: null, artifactsUrl: null }
let input: string, snapshot: PublicSnapshot, deposit: ReturnType<typeof event>, withdrawal: ReturnType<typeof event>
const client = { getChainId: vi.fn(), getBlock: vi.fn(), readContract: vi.fn(), getLogs: vi.fn(), getTransactionReceipt: vi.fn() }

function event(raw: string, kind: 'Deposit' | 'Withdrawal', block: number, fee = 12345n) {
  const note = parseNote(raw, settings.chainId), identity = noteIdentity(note)
  const commitment = toHex(identity.commitment, { size: 32 }), nullifierHash = toHex(identity.nullifierHash, { size: 32 })
  return { address: note.pool.address, blockNumber: BigInt(block), blockHash: hash(block), transactionHash: hash(block + 1000), logIndex: 2, removed: false,
    topics: kind === 'Deposit' ? encodeEventTopics({ abi: complianceEvents, eventName: kind, args: { commitment } })
      : encodeEventTopics({ abi: complianceEvents, eventName: kind, args: { relayer: sender } }),
    data: kind === 'Deposit' ? encodeAbiParameters(parseAbiParameters('uint32, uint256'), [3, 1700000000n])
      : encodeAbiParameters(parseAbiParameters('address, bytes32, uint256'), [recipient, nullifierHash, fee]) }
}

function setup(denomination = '0.01', symbol = 'ETH', chainId: ChainId = 11155111) {
  settings = { ...settings, chainId }
  const pool = poolFor(settings.chainId, denomination, symbol)!
  input = depositNoteFromSecrets(pool, { nullifier: 123n, salt: 456n, commitment: 1n }).raw
  const identity = noteIdentity(parseNote(input, settings.chainId))
  deposit = event(input, 'Deposit', 20); withdrawal = event(input, 'Withdrawal', 40)
  snapshot = { state: {
    pools: { poolsTuples: [[pool.address, { lastSyncedBlock: '0x32' }]] },
    deposits: { depositsTuples: [[pool.address, [[toHex(identity.commitment), { blockNumber: '0x14', transactionHash: '0x0' }]]]] },
    withdrawals: { withdrawalsTuples: [[toHex(identity.nullifierHash), { blockNumber: '0x28', transactionHash: '0x0', pool: pool.address }]] },
  } } as unknown as PublicSnapshot
  vi.mocked(loadCachedHistory).mockImplementation(async () => snapshot)
  vi.mocked(publicClientFor).mockReturnValue(client as unknown as ReturnType<typeof publicClientFor>)
  client.getChainId.mockResolvedValue(chainId)
  client.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({ number: blockNumber ?? 100n, hash: hash(Number(blockNumber ?? 100n)), timestamp: 1700000000n + (blockNumber ?? 100n) }))
  client.readContract.mockResolvedValue(true)
  client.getLogs.mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => [deposit, withdrawal].filter(log => log.blockNumber >= fromBlock && log.blockNumber <= toBlock))
  client.getTransactionReceipt.mockImplementation(async ({ hash: txHash }: { hash: Hex }) => {
    const log = [deposit, withdrawal].find(log => log.transactionHash === txHash)!
    return { status: 'success', transactionHash: txHash, blockNumber: log.blockNumber, blockHash: log.blockHash, from: sender, logs: [log] }
  })
  vi.mocked(createSagaHistory).mockReturnValue({ firstCoveredBlock: async () => '0x1', lastCoveredBlock: async () => '0x32', async *streamEvents() {} })
}
beforeEach(() => { vi.resetAllMocks(); setup() })

describe('Classic-compatible, read-only compliance reports', () => {
  it.each([[11155111, '0.01', 'ETH'], [1, '0.03', 'ETH'], [11155111, '100', 'DAI'], [1, '100', 'USDC']] as const)('verifies chain %s %s %s events from cache hints, even without cached transaction hashes', async (chainId, denomination, symbol) => {
    setup(denomination, symbol, chainId)
    const result = await createComplianceReport(input, settings, vi.fn())
    expect(result.deposit.transactionHash).toBe(deposit.transactionHash)
    expect(result.deposit.transactionSender).toBe(sender) // May be a 4337 bundler, not the depositor.
    expect(result.deposit.timestamp).toBe(1700000020n) // Read from block, not untrusted event timestamp.
    expect(result.withdrawal).toMatchObject({ recipient, fee: 12345n, poolPayout: result.note.pool.amount - 12345n })
    expect(createSagaHistory).not.toHaveBeenCalled() // Both old events are already located.
    expect(client.getLogs.mock.calls.every(([args]) => args.fromBlock === args.toBlock)).toBe(true)
    const sent = JSON.stringify([...client.getLogs.mock.calls, ...client.readContract.mock.calls], (_, value) => typeof value === 'bigint' ? value.toString() : value)
    expect(sent).not.toContain(input); expect(sent).not.toContain(parseNote(input, settings.chainId).preimage)
    expect(client.readContract.mock.calls[0]![0]).toMatchObject({ functionName: 'isSpent', blockNumber: 100n })
  })
  it('reports an unspent note only after checking its on-chain nullifier', async () => {
    Object.values(snapshot)[0]!.withdrawals.withdrawalsTuples = []
    client.readContract.mockResolvedValue(false)
    const result = await createComplianceReport(input, settings, vi.fn())
    expect(result.withdrawal).toBeNull(); expect(result.deposit).toBeDefined()
    expect(client.getTransactionReceipt).toHaveBeenCalledOnce()
  })
  it('falls back from unavailable Saga to RPC for newer withdrawal evidence', async () => {
    Object.values(snapshot)[0]!.withdrawals.withdrawalsTuples = []
    withdrawal = event(input, 'Withdrawal', 70)
    vi.mocked(createSagaHistory).mockReturnValue({ firstCoveredBlock: async () => '0x1', lastCoveredBlock: async () => { throw new Error('Offline') }, async *streamEvents() {} })
    expect((await createComplianceReport(input, settings, vi.fn())).withdrawal?.blockNumber).toBe(70n)
    expect(client.getLogs.mock.calls[0]![0]).toMatchObject({ fromBlock: 51n, toBlock: 100n })
  })
  it('uses Saga only to locate an event and verifies its real transaction on RPC', async () => {
    Object.values(snapshot)[0]!.withdrawals.withdrawalsTuples = []
    withdrawal = event(input, 'Withdrawal', 70)
    vi.mocked(createSagaHistory).mockReturnValue({ firstCoveredBlock: async () => '0x1', lastCoveredBlock: async () => '0x64', async *streamEvents() {
      yield { contractAddress: withdrawal.address, topics: withdrawal.topics, data: withdrawal.data, blockNumber: '0x46', logIndex: '0x2' } as never
    } })
    expect((await createComplianceReport(input, settings, vi.fn())).withdrawal?.transactionHash).toBe(withdrawal.transactionHash)
    expect(client.getLogs.mock.calls.every(([args]) => args.fromBlock === args.toBlock)).toBe(true)
  })
  it('does not infer an unspent note from missing history when the contract says spent', async () => {
    Object.values(snapshot)[0]!.withdrawals.withdrawalsTuples = []
    client.getLogs.mockResolvedValue([deposit])
    await expect(createComplianceReport(input, settings, vi.fn())).rejects.toThrow('spent, but its withdrawal event could not be located')
  })
  it.each(['receipt', 'address', 'block', 'reverted'])('refuses contradictory %s evidence', async kind => {
    client.getTransactionReceipt.mockImplementation(async ({ hash: txHash }: { hash: Hex }) => {
      const log = [deposit, withdrawal].find(log => log.transactionHash === txHash)!
      return { status: kind === 'reverted' ? 'reverted' : 'success', transactionHash: txHash, blockNumber: log.blockNumber,
        blockHash: kind === 'block' ? hash(999) : log.blockHash, from: sender,
        logs: kind === 'receipt' ? [] : [{ ...log, address: kind === 'address' ? sender : log.address }] }
    })
    await expect(createComplianceReport(input, settings, vi.fn())).rejects.toThrow('could not be verified')
  })
  it('refuses an RPC on another chain or behind the bundled checkpoint', async () => {
    client.getChainId.mockResolvedValue(1)
    await expect(createComplianceReport(input, settings, vi.fn())).rejects.toThrow('different network')
    client.getChainId.mockResolvedValue(11155111); client.getBlock.mockResolvedValue({ number: 10n, hash: hash(10), timestamp: 1n })
    await expect(createComplianceReport(input, settings, vi.fn())).rejects.toThrow('behind the cached history')
  })
  it('detects a reorg while a report is being assembled', async () => {
    client.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({ number: blockNumber ?? 100n, hash: blockNumber === 100n ? hash(999) : hash(Number(blockNumber ?? 100n)), timestamp: 1700000000n }))
    await expect(createComplianceReport(input, settings, vi.fn())).rejects.toThrow('chain changed')
  })
  it('rejects an incorrect note/network before requesting history', async () => {
    await expect(createComplianceReport(input, { ...settings, chainId: 1 }, vi.fn())).rejects.toThrow('different network')
    expect(loadCachedHistory).not.toHaveBeenCalled()
  })
  it('stops a cancelled lookup before making chain requests', async () => {
    const cancel = new AbortController(); cancel.abort()
    await expect(createComplianceReport(input, settings, vi.fn(), cancel.signal)).rejects.toThrow()
    expect(loadCachedHistory).not.toHaveBeenCalled(); expect(client.getChainId).not.toHaveBeenCalled()
  })
})
