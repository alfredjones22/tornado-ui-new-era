import type { Host } from '@kohaku-eth/plugins'
import type { ParsedNote } from './notes'
import type { PublicSnapshot } from './withdrawals'

function errorMentions(error: unknown, pattern: RegExp): boolean {
  const seen = new Set<unknown>()
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    const detail = error as { message?: string; details?: string; cause?: unknown; status?: number; code?: number }
    if (pattern.test(`${detail.message ?? ''} ${detail.details ?? ''} ${detail.status ?? ''} ${detail.code ?? ''}`)) return true
    error = detail.cause
  }
  return false
}

/** The SDK currently settles individual pool-sync failures without rejecting sync(). */
export function checkedHistoryProvider(provider: Host['provider'], progress: (message: string) => void, requestInterval = 0) {
  let failure: Error | undefined, ranges = 0, nextRequestAt = 0
  return {
    provider: { ...provider, async getLogs(params: Parameters<Host['provider']['getLogs']>[0]) {
      try {
        // Retry only read-only, rate-limited log queries. Never retry submissions.
        let logs: Awaited<ReturnType<Host['provider']['getLogs']>>
        for (let attempt = 0; ; attempt++) {
          const startAt = Math.max(Date.now(), nextRequestAt)
          nextRequestAt = startAt + requestInterval
          if (startAt > Date.now()) await new Promise(resolve => setTimeout(resolve, startAt - Date.now()))
          try { logs = await provider.getLogs(params); break }
          catch (error) {
            if (attempt >= 3 || !errorMentions(error, /rate.?limit|too many requests|\b429\b/i)) throw error
            progress('RPC rate limit reached. Retrying the pool-history read…')
            await new Promise(resolve => setTimeout(resolve, 2000 * 2 ** attempt))
          }
        }
        ranges++
        progress(`Syncing pool history… ${ranges} block ${ranges === 1 ? 'range' : 'ranges'} checked.`)
        return logs
      } catch (error) {
        failure ??= new Error(errorMentions(error, /pruned|histor(?:y|ical).*unavailable/i)
          ? 'The configured RPC has pruned the pool history. Choose an RPC with historical logs in Settings, then try again.'
          : 'Pool history could not be downloaded from the configured RPC. Check the endpoint in Settings, then try again.')
        throw error
      }
    } },
    assertHealthy() { if (failure) throw failure },
  }
}

export function assertPoolHistoryComplete(snapshot: PublicSnapshot, selected: ParsedNote[], head: bigint) {
  const pools = Object.values(snapshot).flatMap(state => state.pools.poolsTuples)
  for (const note of selected) {
    const pool = pools.find(([address]) => BigInt(address) === BigInt(note.pool.address))?.[1]
    if (!pool || pool.lastSyncedBlock === undefined || BigInt(pool.lastSyncedBlock) < head) {
      throw new Error('The selected pool history is incomplete. Check that your RPC supports historical logs in Settings, then try again.')
    }
  }
}

export function assertImportedNotes(imported: { status: string; poolAddress?: bigint }[], selected: ParsedNote[]) {
  if (imported.length !== selected.length) throw new Error('The SDK did not finish importing every selected note. Please try again.')
  for (let i = 0; i < selected.length; i++) {
    const result = imported[i]!
    if (result.status === 'wrong-chain') throw new Error('A selected note belongs to a different network.')
    if (result.status === 'not-found') throw new Error('No matching deposit was found in the synced pool history. Check the note, selected network and deposit confirmation.')
    if (result.status !== 'imported' || result.poolAddress !== BigInt(selected[i]!.pool.address)) throw new Error('A selected note does not match its expected pool.')
  }
}
