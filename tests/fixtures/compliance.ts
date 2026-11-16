import { toHex } from 'viem'
import { noteIdentity } from '../../src/core/batch-policy'
import { poolFor } from '../../src/core/catalog'
import { depositNoteFromSecrets } from '../../src/core/notes'
import type { ComplianceReport } from '../../src/core/compliance'

/** Synthetic, unfunded note, never a real user's backup. */
export function complianceFixture(): ComplianceReport {
  const note = depositNoteFromSecrets(poolFor(11155111, '0.01')!, { nullifier: 123n, salt: 456n, commitment: 1n })
  const identity = noteIdentity(note)
  const evidence = { transactionHash: toHex(123456n, { size: 32 }), blockNumber: 12000000n, blockHash: toHex(567890n, { size: 32 }),
    logIndex: 2, timestamp: 1794416400n, transactionSender: '0x1111111111111111111111111111111111111111' as const }
  return { note, commitment: toHex(identity.commitment, { size: 32 }), nullifierHash: toHex(identity.nullifierHash, { size: 32 }),
    checkedAt: evidence.timestamp + 3600n, checkedBlock: evidence.blockNumber + 1000n, checkedBlockHash: toHex(999999n, { size: 32 }),
    deposit: { ...evidence, leafIndex: 365 },
    withdrawal: { ...evidence, transactionHash: toHex(888888n, { size: 32 }), blockNumber: evidence.blockNumber + 500n,
      recipient: '0x2222222222222222222222222222222222222222', relayer: '0x3333333333333333333333333333333333333333', fee: 1234567891234567n, poolPayout: note.pool.amount - 1234567891234567n } }
}
