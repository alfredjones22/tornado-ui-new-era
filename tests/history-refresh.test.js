import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem'
import { mergePoolLogs, sagaDelta } from '../scripts/refresh-tornado-history.mjs'

const abi = parseAbi([
  'event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)',
  'event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)',
])
const pool = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const commitment = `0x${'ab'.repeat(32)}`, nullifier = `0x${'cd'.repeat(32)}`
function fixture() {
  return { pools: { poolsTuples: [[pool, { lastSyncedBlock: '0x10' }]] },
    deposits: { depositsTuples: [] }, withdrawals: { withdrawalsTuples: [] },
    sync: { lastSyncedBlock: '0x10', relayerRegistrySyncedBlock: '0x5' } }
}
function deposit(overrides = {}) {
  return { address: pool, blockNumber: '0x11', logIndex: '0x1', transactionHash: `0x${'12'.repeat(32)}`, removed: false,
    topics: encodeEventTopics({ abi, eventName: 'Deposit', args: { commitment } }),
    data: encodeAbiParameters([{ type: 'uint32' }, { type: 'uint256' }], [0, 123n]), ...overrides }
}
function withdrawal() {
  return { address: pool, blockNumber: '0x12', logIndex: '0x2', transactionHash: `0x${'34'.repeat(32)}`, removed: false,
    topics: encodeEventTopics({ abi, eventName: 'Withdrawal', args: { relayer: recipient } }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }], [recipient, nullifier, 5n]) }
}
describe('public history refresh', () => {
  it('merges decoded public events and advances inclusive pool checkpoints without advancing relayer coverage', () => {
    const state = fixture()
    expect(mergePoolLogs(state, [deposit(), withdrawal()], 20n)).toEqual({ deposits: 1, withdrawals: 1 })
    expect(state.deposits.depositsTuples[0][1][0]).toEqual([commitment, {
      blockNumber: '0x11', transactionHash: `0x${'12'.repeat(32)}`, pool, commitment, leafIndex: 0, timestamp: '0x7b',
    }])
    expect(state.withdrawals.withdrawalsTuples[0]).toEqual([nullifier, {
      blockNumber: '0x12', transactionHash: `0x${'34'.repeat(32)}`, pool, nullifierHash: nullifier, to: recipient, relayer: recipient, fee: '0x5',
    }])
    expect(state.pools.poolsTuples[0][1].lastSyncedBlock).toBe('0x14')
    expect(state.sync).toEqual({ lastSyncedBlock: '0x14', relayerRegistrySyncedBlock: '0x5' })
  })
  it.each([{ removed: true }, { blockNumber: '0x10' }, { blockNumber: '0x15' }, { address: recipient }, { transactionHash: '0x0' }])(
    'rejects removed, out-of-range, wrong-pool and malformed logs: %j', overrides => {
      expect(() => mergePoolLogs(fixture(), [deposit(overrides)], 20n)).toThrow()
    })
  it('rejects duplicate, repeated and unordered events rather than silently advancing coverage', () => {
    expect(() => mergePoolLogs(fixture(), [deposit(), deposit()], 20n)).toThrow()
    expect(() => mergePoolLogs(fixture(), [withdrawal(), deposit()], 20n)).toThrow()
    const state = fixture()
    mergePoolLogs(state, [deposit()], 20n)
    expect(() => mergePoolLogs(state, [deposit({ blockNumber: '0x15' })], 21n)).toThrow('existing commitment')
  })
})

describe('Saga snapshot refresh coverage', () => {
  function sagaFixture() {
    const event = deposit()
    const raw = Buffer.from(`${JSON.stringify({ ...event, contractAddress: event.address })}\n`)
    const segment = { fromBlock: '0x10', toBlock: '0x14', file: 'pool-[0x10,0x14).jsonl.gz',
      digest: { type: 'sha256', data: `0x${createHash('sha256').update(raw).digest('hex')}` } }
    const index = { availableProtocols: { pool: { protocol: 'tornado-cash', chainId: '0x1', trackedAddresses: [pool], chunks: [segment] } } }
    const fetcher = vi.fn(async () => new Response(gzipSync(raw)))
    return { index, segment, fetcher }
  }
  it('uses verified half-open coverage and filters events to the requested finalized interval', async () => {
    const { index, fetcher } = sagaFixture()
    const result = await sagaDelta(index, 'https://saga.example', 1, pool, 17n, 18n, fetcher)
    expect(result.next).toBe(19n)
    expect(result.logs).toHaveLength(1)
    expect(result.logs[0].address).toBe(pool)
    expect((await sagaDelta(index, 'https://saga.example', 1, pool, 18n, 19n, fetcher)).logs).toEqual([])
  })
  it('does not advertise coverage when a chunk checksum fails', async () => {
    const { index, fetcher, segment } = sagaFixture()
    segment.digest.data = '0x00'
    await expect(sagaDelta(index, 'https://saga.example', 1, pool, 17n, 20n, fetcher)).rejects.toThrow('checksum')
  })
  it('rejects missing coverage, another network and unsafe chunk paths', async () => {
    const { index, fetcher, segment } = sagaFixture()
    await expect(sagaDelta(index, 'https://saga.example', 1, pool, 15n, 20n, fetcher)).rejects.toThrow('Gap')
    await expect(sagaDelta(index, 'https://saga.example', 11155111, pool, 17n, 20n, fetcher)).rejects.toThrow('unique')
    segment.file = '../escape.jsonl.gz'
    await expect(sagaDelta(index, 'https://saga.example', 1, pool, 17n, 20n, fetcher)).rejects.toThrow('filename')
  })
})
