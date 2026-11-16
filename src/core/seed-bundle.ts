import { SignatureSecretManager, TORNADO_KEYSTORE_PREFIX } from '@kohaku-eth/tornado-cash'
import { english, generateMnemonic, mnemonicToAccount, type MnemonicToAccountOptions } from 'viem/accounts'
import { poolFor, type Pool } from './catalog'
import { depositNoteFromSecrets, type DepositNote } from './notes'

export const SEED_BUNDLE_RECOVERY = {
  protocol: 'tornado', scheme: 'signature-v1', accountIndex: 0,
  signingPath: `${TORNADO_KEYSTORE_PREFIX}/0'`, firstNonce: 0,
} as const

// Immutable source references for the signature-v1 scheme used by alpha.36.
const DERIVATION_REFERENCE = 'https://github.com/ethereum/kohaku/blob/886f72ddd6e36d43e53675fc359fd4a315590ee8/packages/tornado-cash/src/account/signature-keys.ts'
const SEED_KEY_REFERENCE = 'https://github.com/ethereum/kohaku/blob/886f72ddd6e36d43e53675fc359fd4a315590ee8/packages/plugins/src/host/mnemonic-keystore.ts'

export interface SeededDepositBundle { seedPhrase: string; notes: DepositNote[] }

/** Generate a fresh identity for one session. Existing phrases are never imported. */
export async function generateSeededDepositBundle(pools: readonly Pool[]): Promise<SeededDepositBundle> {
  if (!pools.length) throw new Error('Choose at least one note.')
  if (pools.some(pool => pool.chainId !== pools[0]!.chainId || pool.asset.symbol !== pools[0]!.asset.symbol ||
    poolFor(pool.chainId, pool.denomination, pool.asset.symbol)?.address !== pool.address)) throw new Error('Use supported pools of one asset on one network per deposit session.')
  try {
    // viem/scure uses crypto.getRandomValues, with no insecure RNG fallback.
    // A new 256-bit BIP-39 phrase makes nonce zero safe without scanning history
    // for an existing identity. Never reuse this phrase for a later UI session.
    const seedPhrase = generateMnemonic(english, 256)
    // viem's path type is restricted to m/44'/60', while its BIP-32 runtime
    // supports the protocol path. CLI parity vectors cover this exact path.
    const account = mnemonicToAccount(seedPhrase, { path: SEED_BUNDLE_RECOVERY.signingPath as MnemonicToAccountOptions['path'] })
    const manager = await SignatureSecretManager({
      host: { keystore: { deriveAt: async () => { throw new Error('Use the session note signer.') } } },
      signer: { signEnvelope: envelope => account.signTypedData(envelope) },
      accountIndex: SEED_BUNDLE_RECOVERY.accountIndex,
    })
    const notes: DepositNote[] = []
    // One contiguous sequence across all denominations.
    for (const [nonce, pool] of pools.entries()) {
      const secrets = await manager.getSignatureSecrets({ nonce, chainId: BigInt(pool.chainId), poolAddress: BigInt(pool.address) })
      notes.push({ ...depositNoteFromSecrets(pool, secrets), nonce })
    }
    return { seedPhrase, notes }
  } catch {
    // Never relay a library error that might include a phrase or private key.
    throw new Error('Could not securely generate the seed phrase and notes. No deposit was sent.')
  }
}

export function formatDepositBackup(notes: readonly DepositNote[], seedPhrase: string | null = null): string {
  const raw = notes.map(note => note.raw).join('\n') + '\n'
  if (!seedPhrase) return raw
  if (!notes.length) throw new Error('There are no notes to back up.')
  return `------- SEED PHRASE (SECRET) --------\n${seedPhrase}\n-------------------------------------\n\n` +
    `-------- NOTES (SECRET) --------\n${raw}--------------------------------\n\n` +
    '-------- METADATA --------\n' +
    'Anyone with the seed phrase above can find and control ALL of these Tornado notes.\n' +
    'Each individual note string is also secret material: anyone with access to it can spend that note.\n\n' +
    `Note nonces: ${notes.map(note => note.nonce).join(', ')} (in the same order as the notes above).\n\n` +
    `Exact note derivation reference (Kohaku SDK, fixed commit):\n${DERIVATION_REFERENCE}\n\n` +
    `Seed-to-key implementation (same commit):\n${SEED_KEY_REFERENCE}\n` +
    '--------------------------\n'
}
