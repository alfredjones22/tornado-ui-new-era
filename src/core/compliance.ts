// Adapted from Classic's MIT-licensed pages/compliance.vue and application store.
// See LICENSE.classic and README.md. Hashes are derived locally; the note is
// never sent to an RPC, history provider, relayer or report-generation service.
import { decodeEventLog, parseAbi, toHex, type Address, type Hex, type Log } from 'viem'
import { noteIdentity } from './batch-policy'
import { parseNote, type ParsedNote } from './notes'
import { loadCachedHistory } from './history-cache'
import { createSagaHistory } from './saga-history'
import { publicClientFor, type ConnectionSettings } from './rpc'

export const complianceEvents = parseAbi([
  'event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)',
  'event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)',
])
const spentAbi = parseAbi(['function isSpent(bytes32 nullifierHash) view returns (bool)'])
type Client = ReturnType<typeof publicClientFor>
type Evidence = { transactionHash: Hex; blockNumber: bigint; blockHash: Hex; timestamp: bigint; transactionSender: Address; logIndex: number }
export type ComplianceReport = {
  note: ParsedNote; commitment: Hex; nullifierHash: Hex; checkedAt: bigint; checkedBlock: bigint; checkedBlockHash: Hex
  deposit: Evidence & { leafIndex: number }
  withdrawal: (Evidence & { recipient: Address; relayer: Address; fee: bigint; poolPayout: bigint }) | null
}

export const reportDate = (timestamp: bigint) => new Date(Number(timestamp) * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC')

/** Snapshot/Saga records are location hints, never report evidence. Fetch the
 * canonical log and its successful receipt again from the selected chain RPC.
 * A receipt's `from` may be a bundler/router, not the owner of the deposit.
 */
async function evidence(client: Client, address: Address, log: Log): Promise<Evidence> {
  if (log.removed || log.blockNumber === null || !log.blockHash || !log.transactionHash || log.logIndex === null) throw new Error('The matching event is not mined. Try again after confirmation.')
  const [receipt, block] = await Promise.all([
    client.getTransactionReceipt({ hash: log.transactionHash }), client.getBlock({ blockNumber: log.blockNumber }),
  ])
  if (receipt.status !== 'success' || receipt.transactionHash !== log.transactionHash || receipt.blockNumber !== log.blockNumber ||
    receipt.blockHash !== log.blockHash || block.hash !== log.blockHash || !receipt.logs.some(entry =>
      entry.address.toLowerCase() === address.toLowerCase() && entry.logIndex === log.logIndex && entry.data === log.data &&
      entry.topics.length === log.topics.length && entry.topics.every((topic, i) => topic === log.topics[i]))) {
    throw new Error('The event could not be verified against its transaction receipt. Refresh the report.')
  }
  return { transactionHash: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash,
    timestamp: block.timestamp, transactionSender: receipt.from, logIndex: log.logIndex }
}

function matching(logs: readonly Log[], address: Address, kind: 'Deposit' | 'Withdrawal', identity: Hex): Log | undefined {
  const found = logs.filter(log => {
    if (log.address.toLowerCase() !== address.toLowerCase() || log.removed) return false
    try {
      const event = decodeEventLog({ abi: complianceEvents, data: log.data, topics: log.topics, strict: true })
      return event.eventName === kind && (event.eventName === 'Deposit' ? event.args.commitment : event.args.nullifierHash).toLowerCase() === identity.toLowerCase()
    } catch { return false }
  })
  if (found.length > 1) throw new Error('More than one matching pool event was returned. Check the RPC endpoint.')
  return found[0]
}

/** No signing, proving or bundler access is needed. The cached pool history and
 * Saga locate older events; an RPC scan covers only the remaining tail. Absence
 * of a cached withdrawal is never treated as proof that a note is unspent.
 */
export async function createComplianceReport(input: string, settings: ConnectionSettings, progress: (message: string) => void,
  signal?: AbortSignal): Promise<ComplianceReport> {
  const check = () => signal?.throwIfAborted()
  const note = parseNote(input, settings.chainId)
  const identity = noteIdentity(note)
  const commitment = toHex(identity.commitment, { size: 32 }), nullifierHash = toHex(identity.nullifierHash, { size: 32 })
  check(); progress('Loading the selected pool’s history…')
  const snapshot = await loadCachedHistory(settings.chainId, [note.pool], undefined, progress, fetch, settings.artifactsUrl)
  check()
  const state = Object.values(snapshot)[0]!
  const pool = state.pools.poolsTuples[0]![1]
  const cursor = BigInt(pool.lastSyncedBlock!)
  const client = publicClientFor(settings, undefined, cursor)
  if (await client.getChainId() !== settings.chainId) throw new Error('The RPC endpoint is on a different network.')
  check()
  const head = await client.getBlock({ blockTag: 'latest' })
  if (head.number === null || !head.hash || head.number < cursor) throw new Error('The RPC is behind the cached history. Choose an up-to-date endpoint in Settings.')
  const spent = await client.readContract({ address: note.pool.address, abi: spentAbi, functionName: 'isSpent', args: [nullifierHash], blockNumber: head.number })
  check()
  let depositBlock: bigint | undefined, withdrawalBlock: bigint | undefined
  for (const [address, deposits] of state.deposits.depositsTuples) {
    if (BigInt(address) !== BigInt(note.pool.address)) continue
    for (const [key, entry] of deposits) if (BigInt(key) === identity.commitment) depositBlock = BigInt(entry.blockNumber)
  }
  for (const [key, entry] of state.withdrawals.withdrawalsTuples) {
    if (BigInt(key) === identity.nullifierHash && BigInt(entry.pool) === BigInt(note.pool.address)) withdrawalBlock = BigInt(entry.blockNumber)
  }
  const needsEvents = () => depositBlock === undefined || spent && withdrawalBlock === undefined
  const useLog = (log: Log) => {
    if (log.blockNumber === null) return
    if (matching([log], note.pool.address, 'Deposit', commitment)) depositBlock = log.blockNumber
    if (matching([log], note.pool.address, 'Withdrawal', nullifierHash)) withdrawalBlock = log.blockNumber
  }
  let covered = cursor
  if (needsEvents() && cursor < head.number) {
    const saga = createSagaHistory(settings.chainId, snapshot, head.number, progress, fetch, console.warn, settings.sagaUrl)
    const scope = { chainId: toHex(settings.chainId), address: note.pool.address }
    try {
      covered = BigInt(await saga.lastCoveredBlock(scope))
      check()
      // Advance coverage only after streaming the validated range successfully.
      for await (const event of saga.streamEvents({ ...scope, fromBlock: toHex(cursor + 1n), toBlock: toHex(covered) })) {
        check()
        useLog({ address: event.contractAddress, data: event.data, topics: event.topics, blockNumber: BigInt(event.blockNumber) } as Log)
      }
    } catch (error) { check(); covered = cursor /* Saga logs its fallback; RPC remains authoritative. */ }
  }
  // Bound requests for providers with small log-range limits. Split further on
  // explicit result/range limits, but do not turn connection failures into scans.
  async function range(fromBlock: bigint, toBlock: bigint): Promise<Log[]> {
    check()
    try { return await client.getLogs({ address: note.pool.address, events: complianceEvents, fromBlock, toBlock, strict: true }) }
    catch (error) {
      check()
      if (fromBlock >= toBlock || !/block range|range.*(?:large|limit|exceed)|too many (?:results|logs)|query returned|response size|maximum.*blocks/i.test(error instanceof Error ? error.message : '')) throw error
      const middle = (fromBlock + toBlock) / 2n
      return [...await range(fromBlock, middle), ...await range(middle + 1n, toBlock)]
    }
  }
  for (let from = covered + 1n; needsEvents() && from <= head.number; from += 5000n) {
    check(); progress(`Finding the note’s events… block ${from.toString()} of ${head.number.toString()}`)
    for (const log of await range(from, from + 4999n < head.number ? from + 4999n : head.number)) useLog(log)
  }
  if (depositBlock === undefined) throw new Error('No matching deposit was found. Check the note, selected network and deposit confirmation.')
  if (spent && withdrawalBlock === undefined) throw new Error('This note is spent, but its withdrawal event could not be located. Try another history source or RPC endpoint.')
  if (!spent && withdrawalBlock !== undefined) throw new Error('The cached withdrawal and the RPC spent status disagree. Refresh with an up-to-date RPC.')
  const locate = async (blockNumber: bigint, kind: 'Deposit' | 'Withdrawal', hash: Hex) => {
    check()
    if (blockNumber > head.number!) throw new Error('The event is newer than the checked block. Refresh the report.')
    const log = matching(await range(blockNumber, blockNumber), note.pool.address, kind, hash)
    if (!log) throw new Error('The cached event was not found on chain. Check the RPC endpoint and refresh the report.')
    return { log, verified: await evidence(client, note.pool.address, log) }
  }
  progress('Verifying deposit and withdrawal receipts…')
  const deposit = await locate(depositBlock, 'Deposit', commitment)
  const depositArgs = decodeEventLog({ abi: [complianceEvents[0]], data: deposit.log.data, topics: deposit.log.topics, strict: true }).args
  let withdrawal: ComplianceReport['withdrawal'] = null
  if (spent) {
    const found = await locate(withdrawalBlock!, 'Withdrawal', nullifierHash)
    const args = decodeEventLog({ abi: [complianceEvents[1]], data: found.log.data, topics: found.log.topics, strict: true }).args
    if (args.fee > note.pool.amount || found.verified.blockNumber < deposit.verified.blockNumber) throw new Error('The withdrawal evidence is inconsistent with this pool deposit.')
    withdrawal = { ...found.verified, recipient: args.to, relayer: args.relayer, fee: args.fee, poolPayout: note.pool.amount - args.fee }
  }
  check()
  if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new Error('The chain changed during verification. Refresh the report.')
  check()
  return { note, commitment, nullifierHash, checkedAt: head.timestamp, checkedBlock: head.number, checkedBlockHash: head.hash,
    deposit: { ...deposit.verified, leafIndex: depositArgs.leafIndex }, withdrawal }
}
