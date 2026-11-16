import { TornadoCashConfigs } from '@kohaku-eth/tornado-cash'
import { decodeEventLog, isAddress, parseAbi, toHex, type Address, type Hex } from 'viem'
import { namehash } from 'viem/ens'
import { parseNote, type ParsedNote } from './notes'
import { noteIdentity } from './batch-policy'
import { supportsClassicRelayer } from './catalog'
import { checkedUrl, publicClientFor, safeError, validateConnections, type ConnectionSettings } from './rpc'
import { prepareInFrame, type PublicSnapshot, type RelayerWithdrawal } from './withdrawals'
import { isHash, pause, type Update } from './wallet'

export interface RelayerInfo { url: string; ensName: string; rewardAccount: Address; serviceFeeBps: number }
// Classic mainnet relayers commonly charge above the SDK's default 0.30%.
// Keep an explicit service ceiling and retain its total-fee/token-price bounds.
export const RELAYER_FEE_CONFIG = { minFee: 0.01, maxFee: 1, maxTotalFeeBps: 2_000, maxPriceDeviationBps: 2_000 } as const
export interface RelayerQuote {
  id: string; note: ParsedNote; recipient: Address; withdrawal: RelayerWithdrawal; relayer: RelayerInfo
  fee: bigint; net: bigint; serviceFee: bigint; networkFee: bigint; quotedAt: number
}
type RelayerStatus = { currentQueue: number; netId: number; rewardAccount: Address; version: string; tornadoServiceFee: number; ethPrices: Record<string, string> }
const aggregatorAbi = parseAbi(['function relayersData(bytes32[] names, string[] subdomains) view returns ((address owner, uint256 balance, bool isRegistered, string[20] records)[])'])
const withdrawalEvents = parseAbi(['event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)'])

export function assertClassicRelayerPool(note: ParsedNote) {
  if (!supportsClassicRelayer(note.pool)) throw new Error('Classic TORN relayers only support the original pools. Use 4337 for this denomination.')
}

export function relayerUrl(value: string): string {
  const url = new URL(checkedUrl(value))
  if (url.protocol !== 'https:' || url.search || url.hash || url.pathname !== '/') throw new Error('The relayer must use a public HTTPS hostname without a path or credentials.')
  return url.href
}

async function request(url: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try { response = await fetch(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000) }) }
  catch { throw new Error('Could not reach the TORN relayer. Check its job before retrying a submitted withdrawal.') }
  if (!response.ok) throw new Error(`The TORN relayer returned HTTP ${response.status}.`)
  return response.json()
}

/** Check the advertised pool before letting the SDK price or prove a withdrawal. */
export function checkedRelayerStatus(value: unknown, note: ParsedNote): RelayerStatus {
  assertClassicRelayerPool(note)
  const status = value as RelayerStatus & { instances?: Record<string, { instanceAddress?: Record<string, string> }> }
  if (!status || status.netId !== note.pool.chainId || !Number.isInteger(status.currentQueue) || status.currentQueue < 0 || status.currentQueue > 5 ||
    !isAddress(status.rewardAccount ?? '') || BigInt(status.rewardAccount) === 0n || typeof status.version !== 'string' ||
    !Number.isFinite(status.tornadoServiceFee) || status.tornadoServiceFee < RELAYER_FEE_CONFIG.minFee || status.tornadoServiceFee >= RELAYER_FEE_CONFIG.maxFee) throw new Error('The relayer status or service fee is outside the supported limits.')
  const pools = status.instances?.[note.pool.asset.symbol.toLowerCase()]?.instanceAddress
  if (!pools || !Object.values(pools).some(address => isAddress(address) && BigInt(address) === BigInt(note.pool.address))) throw new Error('This TORN relayer does not support the selected pool.')
  if (note.pool.asset.token && (!status.ethPrices || typeof status.ethPrices !== 'object')) throw new Error('The relayer did not provide token prices.')
  return status
}

/** Read-only capability: the worker can check status, never broadcast a proof. */
export function createCheckedRelayerClient(note: ParsedNote) {
  const statuses = new Map<string, RelayerStatus>()
  return {
    client: {
      async getStatus(hostname: string) {
        const url = relayerUrl(`https://${hostname}/`)
        const status = checkedRelayerStatus(await request(`${url}status`), note)
        statuses.set(url, status)
        return status
      },
      async withdraw(): Promise<never> { throw new Error('Submission is disabled inside proof preparation.') },
    },
    selected(withdrawal: RelayerWithdrawal, snapshot: PublicSnapshot): RelayerInfo {
      const url = relayerUrl(withdrawal.relayerUrl), status = statuses.get(url)
      const registered = Object.values(snapshot).flatMap(state => state.relayers.relayersTuples)
        .find(([, info]) => { try { return relayerUrl(`https://${info.hostname}/`) === url } catch { return false } })
      if (!registered || !status || BigInt(registered[1].relayerAddress) !== BigInt(status.rewardAccount) || BigInt(registered[1].stakeBalance) < 40n * 10n ** 18n) throw new Error('The relayer reward address does not match its registered TORN stake.')
      return { url, ensName: registered[0], rewardAccount: status.rewardAccount, serviceFeeBps: Math.round(status.tornadoServiceFee * 100) }
    },
  }
}

export function validateRelayerWithdrawal(note: ParsedNote, recipient: Address, withdrawal: RelayerWithdrawal, relayer: RelayerInfo) {
  assertClassicRelayerPool(note)
  if (withdrawal.mode !== 'relayer' || withdrawal.poolAddress !== BigInt(note.pool.address) || withdrawal.denomination !== note.pool.amount ||
    relayerUrl(withdrawal.relayerUrl) !== relayerUrl(relayer.url)) throw new Error('The relayer withdrawal does not match the reviewed pool or endpoint.')
  const { proof, args } = withdrawal.proof
  if (!/^0x[\da-f]{512}$/i.test(proof) || !/^0x[\da-f]{64}$/i.test(args[0]) || BigInt(args[1]) !== noteIdentity(note).nullifierHash ||
    BigInt(args[2]) !== BigInt(recipient) || BigInt(args[3]) !== BigInt(relayer.rewardAccount) || BigInt(args[5]) !== 0n) throw new Error('The relayer proof does not match the note, recipient or reward address.')
  const fee = BigInt(args[4])
  if (!Number.isInteger(relayer.serviceFeeBps) || relayer.serviceFeeBps < 1 || relayer.serviceFeeBps >= RELAYER_FEE_CONFIG.maxFee * 100 || fee !== withdrawal.fee ||
    fee <= 0n || fee * 10_000n > note.pool.amount * BigInt(RELAYER_FEE_CONFIG.maxTotalFeeBps) || fee >= note.pool.amount) throw new Error('The relayer fee is outside the reviewed limits.')
  const serviceFee = note.pool.amount * BigInt(relayer.serviceFeeBps) / 10_000n
  if (fee < serviceFee) throw new Error('The relayer total is smaller than its service surcharge.')
  return { fee, net: note.pool.amount - fee, serviceFee, networkFee: fee - serviceFee }
}

export async function prepareRelayerWithdrawal(input: string, recipient: Address, settings: ConnectionSettings, progress: (message: string) => void): Promise<RelayerQuote> {
  const note = parseNote(input, settings.chainId)
  assertClassicRelayerPool(note)
  if (!isAddress(recipient) || BigInt(recipient) === 0n) throw new Error('Enter a valid nonzero recipient address.')
  await validateConnections(settings, false)
  const { withdrawal, relayer } = await prepareInFrame(note, recipient, settings, progress, 'relayer')
  if (withdrawal.mode !== 'relayer' || !relayer) throw new Error('Expected one registered TORN relayer withdrawal.')
  const amounts = validateRelayerWithdrawal(note, recipient, withdrawal, relayer)
  return { id: crypto.randomUUID(), note, recipient, withdrawal, relayer, ...amounts, quotedAt: Date.now() }
}

/** Refresh stake, ENS endpoint and service rate immediately before submission. */
async function recheckRelayer(quote: RelayerQuote, settings: ConnectionSettings) {
  const cfg = TornadoCashConfigs[settings.chainId], info = quote.relayer
  const client = publicClientFor(settings)
  const subdomains = cfg.ensSubdomainKey === 'mainnet-tornado' ? ['mainnet-tornado'] : ['mainnet-tornado', cfg.ensSubdomainKey]
  const [data] = await client.readContract({ address: toHex(cfg.aggregator.address, { size: 20 }), abi: aggregatorAbi, functionName: 'relayersData', args: [[namehash(info.ensName)], subdomains] })
  if (!data?.isRegistered || data.balance < 40n * 10n ** 18n || data.owner.toLowerCase() !== info.rewardAccount.toLowerCase() ||
    relayerUrl(`https://${data.records[subdomains.length - 1]}/`) !== info.url || !data.records[0]) throw new Error('The relayer registration or endpoint changed. Prepare a new review.')
  const status = checkedRelayerStatus(await request(`${info.url}status`), quote.note)
  if (status.rewardAccount.toLowerCase() !== info.rewardAccount.toLowerCase() || Math.round(status.tornadoServiceFee * 100) !== info.serviceFeeBps) throw new Error('The relayer service fee or reward address changed. Prepare a new review.')
}

export async function reconcileRelayerWithdrawal(quote: RelayerQuote, settings: ConnectionSettings, jobId: string, update: Update, timeout = 180_000) {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(jobId)) throw new Error('The relayer returned an invalid job identifier.')
  await validateConnections(settings, false)
  const end = Date.now() + timeout, client = publicClientFor(settings)
  do {
    const job = await request(`${relayerUrl(quote.relayer.url)}v1/jobs/${encodeURIComponent(jobId)}`) as { txHash?: unknown; status?: unknown }
    if (isHash(job.txHash)) {
      update(quote.id, { hash: job.txHash, transactionHash: job.txHash })
      const receipt = await client.getTransactionReceipt({ hash: job.txHash }).catch(() => null)
      if (receipt) {
        const matched = receipt.status === 'success' && receipt.logs.some(log => {
          if (log.address.toLowerCase() !== quote.note.pool.address.toLowerCase()) return false
          try {
            const { args } = decodeEventLog({ abi: withdrawalEvents, data: log.data, topics: log.topics })
            return args.nullifierHash === quote.withdrawal.proof.args[1] && args.to.toLowerCase() === quote.recipient.toLowerCase() &&
              args.relayer.toLowerCase() === quote.relayer.rewardAccount.toLowerCase() && args.fee === quote.fee
          } catch { return false }
        })
        if (!matched) throw new Error('The reported transaction does not confirm this withdrawal. Check the job and original note before retrying.')
        update(quote.id, { status: 'confirmed', message: undefined }); return
      }
    }
    if (job.status === 'FAILED') throw new Error('The relayer reports a failed job. Check the original note and job before retrying.')
    await pause(2000)
  } while (Date.now() < end)
  throw new Error('The relayer withdrawal is still pending. Check this job before retrying.')
}

export async function submitRelayerWithdrawal(quote: RelayerQuote, settings: ConnectionSettings, update: Update) {
  const note = parseNote(quote.note.raw, settings.chainId)
  if (Date.now() - quote.quotedAt > 5 * 60_000) throw new Error('This relayer fee quote expired. Prepare a new review.')
  const amounts = validateRelayerWithdrawal(note, quote.recipient, quote.withdrawal, quote.relayer)
  if (Object.entries(amounts).some(([key, value]) => quote[key as keyof typeof amounts] !== value)) throw new Error('The relayer withdrawal no longer matches the reviewed fee.')
  await validateConnections(settings, false)
  await recheckRelayer(quote, settings)
  update(quote.id, { status: 'submitted' })
  try {
    const { proof, args } = quote.withdrawal.proof
    // One POST only. A timeout is ambiguous; never send a duplicate or switch routes.
    const job = await request(`${quote.relayer.url}v1/tornadoWithdraw`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proof, args, contract: note.pool.address }) }) as { id?: unknown }
    if (typeof job.id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(job.id)) throw new Error('The relayer returned no usable job ID. Preserve the note and check the relayer before retrying.')
    update(quote.id, { relayerJobId: job.id, status: 'submitted' })
    await reconcileRelayerWithdrawal(quote, settings, job.id, update)
  } catch (error) {
    update(quote.id, { status: 'unknown', message: safeError(error) }); throw error
  }
}
