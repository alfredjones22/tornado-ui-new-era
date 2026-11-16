import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiParameters, toHex, type Hex } from 'viem'
import { poolFor } from '../src/core/catalog'
import { parseNote } from '../src/core/notes'
import { noteIdentity } from '../src/core/batch-policy'
import { checkedRelayerStatus, createCheckedRelayerClient, relayerUrl, reconcileRelayerWithdrawal, submitRelayerWithdrawal, validateRelayerWithdrawal, type RelayerInfo, type RelayerQuote } from '../src/core/relayers'
import { publicClientFor, validateConnections, type ConnectionSettings } from '../src/core/rpc'
import type { Progress } from '../src/core/wallet'
import type { PublicSnapshot, RelayerWithdrawal } from '../src/core/withdrawals'

vi.mock('../src/core/rpc', async original => ({ ...await original<object>(), publicClientFor: vi.fn(), validateConnections: vi.fn() }))
const settings: ConnectionSettings = { chainId: 1, rpcUrl: 'https://rpc.example', bundler: 'custom', bundlerUrl: '' }
const recipient = '0x1111111111111111111111111111111111111111', reward = '0x2222222222222222222222222222222222222222'
const txHash: Hex = `0x${'aa'.repeat(32)}`
function fixture(symbol = 'ETH', denomination = symbol === 'ETH' ? '1' : '100') {
  const pool = poolFor(1, denomination, symbol)!
  const note = parseNote(`tornado-${symbol.toLowerCase()}-${pool.denomination}-1-0x${'13'.repeat(62)}`, 1)
  const serviceFee = pool.amount * 50n / 10_000n, networkFee = pool.amount / 1000n, fee = serviceFee + networkFee
  const relayer: RelayerInfo = { url: 'https://relay.example/', ensName: 'relay.eth', rewardAccount: reward, serviceFeeBps: 50 }
  const withdrawal: RelayerWithdrawal = { mode: 'relayer', relayerUrl: relayer.url, poolAddress: BigInt(pool.address) as RelayerWithdrawal['poolAddress'], fee, denomination: pool.amount,
    proof: { proof: `0x${'12'.repeat(256)}`, args: [toHex(1n, { size: 32 }), toHex(noteIdentity(note).nullifierHash, { size: 32 }), recipient, reward, toHex(fee), '0x0'] } }
  const quote: RelayerQuote = { id: 'single', note, recipient, relayer, withdrawal, fee, net: pool.amount - fee, serviceFee, networkFee, quotedAt: Date.now() }
  const status = { netId: 1, rewardAccount: reward, version: '5.0.0', currentQueue: 0, tornadoServiceFee: 0.5, ethPrices: { dai: '1' }, instances: { [symbol.toLowerCase()]: { instanceAddress: { [pool.denomination]: pool.address } } } }
  const event = parseAbi(['event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)'])
  const receipt = { status: 'success', logs: [{ address: pool.address, topics: encodeEventTopics({ abi: event, eventName: 'Withdrawal', args: { relayer: reward } }),
    data: encodeAbiParameters(parseAbiParameters('address, bytes32, uint256'), [recipient, withdrawal.proof.args[1], fee]) }] }
  return { note, relayer, withdrawal, quote, status, receipt }
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(validateConnections).mockResolvedValue(undefined) })
afterEach(() => vi.unstubAllGlobals())
function connection(quote: RelayerQuote, receipt: unknown) {
  const client = { readContract: vi.fn().mockResolvedValue([{ owner: reward, balance: 100n * 10n ** 18n, isRegistered: true, records: [new URL(quote.relayer.url).host] }]),
    getTransactionReceipt: vi.fn().mockResolvedValue(receipt) }
  vi.mocked(publicClientFor).mockReturnValue(client as unknown as ReturnType<typeof publicClientFor>)
  return client
}

describe('Classic TORN relayer scope and fee disclosure', () => {
  it('rejects an extended pool even when a relayer advertises support, before any submission', async () => {
    const { note, withdrawal, relayer, quote, status } = fixture('ETH', '0.01')
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    expect(() => checkedRelayerStatus(status, note)).toThrow('only support the original pools')
    expect(() => validateRelayerWithdrawal(note, recipient, withdrawal, relayer)).toThrow('only support the original pools')
    await expect(submitRelayerWithdrawal(quote, settings, vi.fn())).rejects.toThrow('only support the original pools')
    expect(validateConnections).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['ETH', 'DAI', 'USDC'])('separates the quoted service surcharge and network fee for %s', symbol => {
    const { note, withdrawal, relayer, quote, status } = fixture(symbol)
    expect(checkedRelayerStatus(status, note)).toBe(status)
    expect(validateRelayerWithdrawal(note, recipient, withdrawal, relayer)).toEqual({ fee: quote.fee, net: quote.net, serviceFee: quote.serviceFee, networkFee: quote.networkFee })
    expect(relayer.serviceFeeBps / 100).toBe(0.5)
  })
  it('rejects unsupported pools, wrong networks, overloaded queues and excessive service rates', () => {
    const { note, status } = fixture()
    expect(() => checkedRelayerStatus({ ...status, instances: {} }, note)).toThrow('does not support')
    for (const patch of [{ netId: 11155111 }, { currentQueue: 6 }, { tornadoServiceFee: 1 }, { tornadoServiceFee: NaN }, { rewardAccount: '0x0' }]) expect(() => checkedRelayerStatus({ ...status, ...patch }, note)).toThrow('outside')
  })
  it('requires HTTPS and forbids endpoint credentials, paths or query parameters', () => {
    expect(relayerUrl('https://relay.example')).toBe('https://relay.example/')
    for (const value of ['http://relay.example', 'https://user:secret@relay.example', 'https://relay.example/private', 'https://relay.example/?key=value']) expect(() => relayerUrl(value)).toThrow()
  })
  it('checks liveness without sending a proof and binds the selected reward to its registered stake', async () => {
    const { note, status, withdrawal } = fixture(), fetcher = vi.fn(async () => Response.json(status))
    vi.stubGlobal('fetch', fetcher)
    const bridge = createCheckedRelayerClient(note)
    await bridge.client.getStatus('relay.example')
    expect(fetcher).toHaveBeenCalledWith('https://relay.example/status', expect.objectContaining({ credentials: 'omit', redirect: 'error' }))
    expect(fetcher.mock.calls[0]).toHaveLength(2)
    const snapshot = { test: { relayers: { relayersTuples: [['relay.eth', { hostname: 'relay.example', relayerAddress: reward, stakeBalance: toHex(100n * 10n ** 18n) }]] } } } as unknown as PublicSnapshot
    expect(bridge.selected(withdrawal, snapshot).serviceFeeBps).toBe(50)
    await expect(bridge.client.withdraw()).rejects.toThrow('Submission is disabled')
    Object.values(snapshot)[0]!.relayers.relayersTuples[0]![1].relayerAddress = recipient
    expect(() => bridge.selected(withdrawal, snapshot)).toThrow('registered TORN stake')
  })
  it.each(['recipient', 'nullifier', 'reward', 'refund', 'pool', 'fee'])('rejects a changed %s before submission', field => {
    const { note, relayer, withdrawal } = fixture()
    if (field === 'recipient') withdrawal.proof.args[2] = reward
    if (field === 'nullifier') withdrawal.proof.args[1] = toHex(123n, { size: 32 })
    if (field === 'reward') withdrawal.proof.args[3] = recipient
    if (field === 'refund') withdrawal.proof.args[5] = '0x1'
    if (field === 'pool') withdrawal.poolAddress = 1n as RelayerWithdrawal['poolAddress']
    if (field === 'fee') withdrawal.fee += 1n
    expect(() => validateRelayerWithdrawal(note, recipient, withdrawal, relayer)).toThrow()
  })
})

describe('single relayer transaction and job reconciliation', () => {
  it('posts exactly one reviewed proof, stores the job ID, and verifies the matching on-chain event', async () => {
    const { quote, status, receipt } = fixture(); connection(quote, receipt)
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? { id: 'job-123' } : url.endsWith('/status') ? status : { status: 'CONFIRMED', txHash }))
    vi.stubGlobal('fetch', fetcher)
    let row: Partial<Progress> = {}
    await submitRelayerWithdrawal(quote, settings, (_id, patch) => { row = { ...row, ...patch } })
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0]![1]!.body as string)).toEqual({ proof: quote.withdrawal.proof.proof, args: quote.withdrawal.proof.args, contract: quote.note.pool.address })
    expect(posts[0]![1]!.body).not.toContain(quote.note.raw)
    expect(row).toMatchObject({ status: 'confirmed', relayerJobId: 'job-123', hash: txHash, transactionHash: txHash })
    expect(vi.mocked(validateConnections).mock.calls.every(([, bundler]) => bundler === false)).toBe(true)
  })
  it('never retries a timed-out submission or switches to a bundler', async () => {
    const { quote, status, receipt } = fixture(); connection(quote, receipt)
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => { if (init?.method === 'POST') throw new TypeError('Network timeout'); return Response.json(status) })
    vi.stubGlobal('fetch', fetcher)
    const update = vi.fn()
    await expect(submitRelayerWithdrawal(quote, settings, update)).rejects.toThrow('Could not reach')
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(update).toHaveBeenLastCalledWith(quote.id, expect.objectContaining({ status: 'unknown' }))
  })
  it('refuses to broadcast when the service rate or registration changes after review', async () => {
    const { quote, status, receipt } = fixture(), client = connection(quote, receipt)
    const fetcher = vi.fn(async () => Response.json({ ...status, tornadoServiceFee: 0.6 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(submitRelayerWithdrawal(quote, settings, vi.fn())).rejects.toThrow('service fee or reward address changed')
    client.readContract.mockResolvedValue([{ owner: reward, balance: 0n, isRegistered: false, records: ['relay.example'] }])
    await expect(submitRelayerWithdrawal(quote, settings, vi.fn())).rejects.toThrow('registration or endpoint changed')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('does not trust a relayer CONFIRMED status or an unrelated transaction receipt', async () => {
    const { quote, receipt } = fixture(); receipt.logs[0]!.address = recipient
    connection(quote, receipt)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'CONFIRMED', txHash })))
    const update = vi.fn()
    await expect(reconcileRelayerWithdrawal(quote, settings, 'job-123', update)).rejects.toThrow('does not confirm this withdrawal')
    expect(update.mock.calls.some(([, patch]) => patch.status === 'confirmed')).toBe(false)
  })
  it('rejects expired quotes and path-like job identifiers', async () => {
    const { quote } = fixture(); quote.quotedAt -= 6 * 60_000
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    await expect(submitRelayerWithdrawal(quote, settings, vi.fn())).rejects.toThrow('expired')
    await expect(reconcileRelayerWithdrawal(quote, settings, '../other-job', vi.fn())).rejects.toThrow('invalid job identifier')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
