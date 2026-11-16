import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeEventTopics, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, TransactionReceiptNotFoundError, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { batchTypedData } from '../src/core/batch-policy'
import { smartRecipient, validateSmartSigningRequest, validateSmartWithdrawal } from '../src/core/smart-withdrawal-policy'
import { actionFixture } from './fixtures/smart-actions'
import { simpleAccountAbi } from '../src/core/smart-account'
import { smartWithdrawalGasLimits } from '../src/core/withdrawal-gas'
import { createSmartWithdrawalSigner, prepareSmartWithdrawal, reconcileSmartWithdrawal, submitSmartWithdrawal } from '../src/core/smart-withdrawal'
import { EndpointRpcError, jsonRpc, publicClientFor, validateConnections } from '../src/core/rpc'
import { assertSmartAccount } from '../src/core/smart-account'
import type { Progress } from '../src/core/wallet'
import { settings, signingAccount } from './fixtures/multi-withdrawal'
import { smartFixture, typedDataWallet } from './fixtures/smart-withdrawal'

vi.mock('../src/core/rpc', async original => ({ ...await original<object>(), jsonRpc: vi.fn(), publicClientFor: vi.fn(), validateConnections: vi.fn() }))
vi.mock('../src/core/smart-account', async original => ({ ...await original<object>(), assertSmartAccount: vi.fn() }))
const sessions: ReturnType<typeof createSmartWithdrawalSigner>[] = [], ports: MessagePort[] = []
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('location', new URL('http://localhost:5173')) })
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); ports.splice(0).forEach(port => port.close()); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const txHash: Hex = `0x${'dd'.repeat(32)}`
const eventAbi = parseAbi(['event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)'])
function mockReceipt(quote: ReturnType<typeof smartFixture>['quote'], success = true) {
  vi.mocked(publicClientFor).mockReturnValue({ getTransactionReceipt: vi.fn(async () => ({ status: 'success', logs: [{
    address: quote.withdrawal.entryPointAddress,
    topics: encodeEventTopics({ abi: eventAbi, eventName: 'UserOperationEvent', args: { userOpHash: quote.signedHash, sender: quote.scope.account.address, paymaster: quote.withdrawal.paymasterAddress } }),
    data: encodeAbiParameters(parseAbiParameters('uint256, bool, uint256, uint256'), [quote.scope.account.nonce, success, 1n, 1n]),
  }] })) } as unknown as ReturnType<typeof publicClientFor>)
}

describe('smart account payout scope', () => {
  const directRoutes = ['eth', 'usdc'].flatMap(symbol => [false, true].flatMap(deployed =>
    (['account', 'wallet', 'custom'] as const).map(payout => ({ symbol, deployed, payout }))))
  it.each(directRoutes)('directly pays and refunds one $symbol note to $payout (deployed=$deployed)', async ({ symbol, deployed, payout }) => {
    const { quote } = smartFixture(1, symbol, payout, deployed), op = quote.withdrawal.userOperation
    expect(op.callData).toBe('0x'); expect(BigInt(op.callGasLimit)).toBe(0n)
    expect(BigInt(quote.withdrawal.proof.args[2])).toBe(BigInt(smartRecipient(quote.scope)))
    expect(validateSmartWithdrawal(quote.notes, quote.scope, quote.withdrawal, settings)).toEqual({ fee: quote.fee, net: quote.net })
    const wallet = typedDataWallet(), approve = vi.fn(async () => {})
    const signer = createSmartWithdrawalSigner(wallet, quote.notes, quote.scope, settings, approve); sessions.push(signer)
    quote.withdrawal.userOperation.signature = await signer.signTypedData(batchTypedData(quote.withdrawal, settings))
    expect(await signer.verifyPrepared(quote.withdrawal)).toBe(quote.signedHash)
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ fee: quote.fee, net: quote.net }))
  })
  it.each(['gas', 'calldata', 'recipient', 'proof', 'factory', 'nonce', 'fee', 'fallback'] as const)('rejects changed direct one-note %s before consent and submission', async change => {
    const { quote } = smartFixture(1, 'eth', 'custom'), op = quote.withdrawal.userOperation
    if (change === 'gas') op.callGasLimit = '0x1'
    if (change === 'calldata') op.callData = encodeFunctionData({ abi: simpleAccountAbi, functionName: 'executeBatch', args: [[]] })
    if (change === 'recipient') {
      quote.withdrawal.proof.args[2] = quote.scope.account.address
      const proof = quote.withdrawal.proof
      op.paymasterData = encodeAbiParameters(parseAbiParameters('(address instance, bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, uint256 fee)'), [{
        instance: quote.notes[0]!.pool.address, proof: proof.proof, root: proof.args[0], nullifierHash: proof.args[1], recipient: quote.scope.account.address, fee: quote.fee,
      }])
    }
    if (change === 'proof') quote.withdrawal.proof.args[2] = quote.scope.account.address
    if (change === 'factory') op.factoryData = '0x1234'
    if (change === 'nonce') op.nonce = '0x1'
    if (change === 'fee') quote.withdrawal.proof.args[4] = '0x1'
    if (change === 'fallback') quote.withdrawal.gasEstimation = { status: 'fallback', reason: 'bundler-internal', message: '' }
    expect(() => validateSmartWithdrawal(quote.notes, quote.scope, quote.withdrawal, settings)).toThrow()
    // A detached proof or result-status change is checked on the prepared result;
    // it is not part of the typed-data payload shown to the signing policy.
    if (['proof', 'fee', 'fallback'].includes(change)) return
    const approve = vi.fn(async () => {}), signer = createSmartWithdrawalSigner(typedDataWallet(), quote.notes, quote.scope, settings, approve)
    sessions.push(signer)
    await expect(signer.signTypedData(batchTypedData(quote.withdrawal, settings))).rejects.toThrow()
    expect(approve).not.toHaveBeenCalled()
  })
  it('accepts the reported buffered deployment estimate while retaining bounded gas and stricter reuse limits', () => {
    const { quote } = smartFixture()
    // The reported SDK-buffered value is 1,450,271 gas, not a fallback limit.
    quote.withdrawal.userOperation.verificationGasLimit = `0x${1_450_271n.toString(16)}`
    expect(smartWithdrawalGasLimits(false).verificationGasLimit).toBe(2_000_000n)
    expect(() => validateSmartSigningRequest(batchTypedData(quote.withdrawal, settings), quote.notes, quote.scope, settings)).not.toThrow()
    quote.withdrawal.userOperation.verificationGasLimit = `0x${2_000_001n.toString(16)}`
    expect(() => validateSmartSigningRequest(batchTypedData(quote.withdrawal, settings), quote.notes, quote.scope, settings)).toThrow('safety ceilings')
    const reused = smartFixture(2, 'eth', 'wallet', true).quote
    reused.withdrawal.userOperation.verificationGasLimit = `0x${1_450_271n.toString(16)}`
    expect(() => validateSmartSigningRequest(batchTypedData(reused.withdrawal, settings), reused.notes, reused.scope, settings)).toThrow('safety ceilings')
  })
  it.each([{ count: 2, symbol: 'eth', payout: 'wallet' as const, deployed: false }, { count: 12, symbol: 'eth', payout: 'account' as const, deployed: true },
    { count: 3, symbol: 'usdc', payout: 'wallet' as const, deployed: true }, { count: 3, symbol: 'eth', payout: 'custom' as const, deployed: false },
    { count: 3, symbol: 'usdc', payout: 'custom' as const, deployed: true }])('accepts only the selected $payout payout for $count $symbol notes', ({ count, symbol, payout, deployed }) => {
    const { quote } = smartFixture(count, symbol, payout, deployed)
    expect(validateSmartWithdrawal(quote.notes, quote.scope, quote.withdrawal, settings)).toEqual({ fee: quote.fee, net: quote.net })
    expect(validateSmartSigningRequest(batchTypedData(quote.withdrawal, settings), quote.notes, quote.scope, settings).fee).toBe(quote.fee)
  })
  it('allows a custom smart-account recipient without adding a redundant self-transfer', () => {
    const { quote } = smartFixture(2, 'eth', 'custom', true, '0x3333333333333333333333333333333333333333')
    expect(validateSmartWithdrawal(quote.notes, quote.scope, quote.withdrawal, settings)).toEqual({ fee: quote.fee, net: quote.net })
  })
  it('rejects a changed custom recipient before wallet consent and again before submission', async () => {
    for (const symbol of ['eth', 'usdc']) {
      const { quote } = smartFixture(2, symbol, 'custom'), wallet = typedDataWallet(), approve = vi.fn(async () => {})
      const session = createSmartWithdrawalSigner(wallet, quote.notes, quote.scope, settings, approve); sessions.push(session)
      const typed = batchTypedData(quote.withdrawal, settings)
      quote.scope.recipient = quote.scope.account.owner
      await expect(session.signTypedData(typed)).rejects.toThrow('forwarding call differs')
      expect(approve).not.toHaveBeenCalled()
      expect(() => validateSmartWithdrawal(quote.notes, quote.scope, quote.withdrawal, settings)).toThrow('forwarding call differs')
    }
  })
  it('rejects missing, malformed and zero custom recipients before preparing proofs', async () => {
    const { quote } = smartFixture()
    for (const recipient of [undefined, 'invalid', '0x0000000000000000000000000000000000000000']) {
      const scope = { ...quote.scope, payout: 'custom' as const, recipient: recipient as `0x${string}` | undefined }
      expect(() => smartRecipient(scope)).toThrow('valid nonzero')
      await expect(prepareSmartWithdrawal(quote.notes.map(note => note.raw).join('\n'), typedDataWallet(), scope, settings, vi.fn(), vi.fn(async () => {}))).rejects.toThrow('valid nonzero')
    }
    expect(validateConnections).not.toHaveBeenCalled()
  })
  it.each(['sender', 'nonce', 'factory', 'owner', 'authorization', 'fallback', 'forwarding', 'missing', 'extra'])('rejects changed %s data', change => {
    const { quote, calls } = smartFixture(), op = quote.withdrawal.userOperation
    if (change === 'sender') op.sender = quote.scope.account.owner
    if (change === 'nonce') op.nonce = '0x1'
    if (change === 'factory') op.factoryData = '0x1234'
    if (change === 'owner') quote.scope.account.owner = op.sender
    if (change === 'authorization') op.eip7702Auth = { address: op.sender, chainId: '0x1', nonce: '0x0', r: txHash, s: txHash, yParity: '0x0' }
    if (change === 'fallback') quote.withdrawal.gasEstimation = { status: 'fallback', reason: 'bundler-internal', message: '' }
    if (change === 'forwarding') calls[calls.length - 1]!.value++
    if (change === 'missing') calls.shift()
    if (change === 'extra') calls.push(calls[0]!)
    if (['forwarding', 'missing', 'extra'].includes(change)) op.callData = encodeFunctionData({ abi: simpleAccountAbi, functionName: 'executeBatch', args: [calls] })
    expect(() => validateSmartWithdrawal(quote.notes, quote.scope, quote.withdrawal, settings)).toThrow()
  })
  it('rejects a redirected owner, factory, domain and nonce before wallet consent', async () => {
    for (const change of ['factory', 'domain', 'nonce', 'call']) {
      const { quote } = smartFixture(), wallet = typedDataWallet(), approve = vi.fn(async () => {})
      const session = createSmartWithdrawalSigner(wallet, quote.notes, quote.scope, settings, approve); sessions.push(session)
      const typed = batchTypedData(quote.withdrawal, settings)
      if (change === 'factory') typed.message.initCode = '0x'
      if (change === 'domain') typed.domain!.chainId = 11155111
      if (change === 'nonce') typed.message.nonce = 1n
      if (change === 'call') typed.message.callData = '0x'
      await expect(session.signTypedData(typed)).rejects.toThrow()
      expect(approve).not.toHaveBeenCalled()
    }
  })
})

describe('typed-data-only external signer', () => {
  it('aligns the background wallet network before every signature even when eth_chainId is cached', async () => {
    const { quote } = smartFixture(), wallet = typedDataWallet(), original = wallet.provider.request
    let backgroundChain = '0xaa36a7'
    const request = vi.spyOn(wallet.provider, 'request').mockImplementation(async args => {
      // The injected provider says mainnet while its background has reset to Sepolia.
      if (args.method === 'wallet_switchEthereumChain') {
        backgroundChain = (args.params as { chainId: string }[])[0]!.chainId
        wallet.listeners.get('chainChanged')?.forEach(fn => fn(backgroundChain))
        return null
      }
      if (args.method === 'eth_signTypedData_v4' && backgroundChain !== '0x1') {
        throw { code: -32600, message: 'The domain chainId (1) does not match the current network chainId (11155111)' }
      }
      return original(args)
    })
    const session = createSmartWithdrawalSigner(wallet, quote.notes, quote.scope, settings, vi.fn(async () => {})); sessions.push(session)
    const typed = batchTypedData(quote.withdrawal, settings)
    quote.withdrawal.userOperation.signature = await session.signTypedData(typed)
    // Reproduce another background reset during a long proof/estimate cycle.
    backgroundChain = '0xaa36a7'
    quote.withdrawal.userOperation.signature = await session.signTypedData(typed)
    expect(await session.verifyPrepared(quote.withdrawal)).toBe(quote.signedHash)
    expect(request.mock.calls.filter(([r]) => /sign|switch/i.test(r.method)).map(([r]) => r.method)).toEqual([
      'wallet_switchEthereumChain', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'eth_signTypedData_v4',
    ])
    expect(request).toHaveBeenCalledWith({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] })
  })
  it.each([-32601, 4200])('allows typed-data-only wallets without the optional chain-switch method (%s)', async code => {
    const { quote } = smartFixture(), wallet = typedDataWallet(), original = wallet.provider.request
    vi.spyOn(wallet.provider, 'request').mockImplementation(async args => {
      if (args.method === 'wallet_switchEthereumChain') throw { code, message: 'Unsupported method' }
      return original(args)
    })
    const session = createSmartWithdrawalSigner(wallet, quote.notes, quote.scope, settings, vi.fn(async () => {})); sessions.push(session)
    quote.withdrawal.userOperation.signature = await session.signTypedData(batchTypedData(quote.withdrawal, settings))
    expect(await session.verifyPrepared(quote.withdrawal)).toBe(quote.signedHash)
  })
  it.each([4001, 4902, -32000])('does not sign or retry after a network selection failure (%s)', async code => {
    const { quote } = smartFixture(), wallet = typedDataWallet(), original = wallet.provider.request
    const request = vi.spyOn(wallet.provider, 'request').mockImplementation(async args => {
      if (args.method === 'wallet_switchEthereumChain') throw { code, message: 'Network selection failed' }
      return original(args)
    })
    const session = createSmartWithdrawalSigner(wallet, quote.notes, quote.scope, settings, vi.fn(async () => {})); sessions.push(session)
    await expect(session.signTypedData(batchTypedData(quote.withdrawal, settings))).rejects.toMatchObject({ code })
    expect(request.mock.calls.filter(([r]) => r.method === 'wallet_switchEthereumChain')).toHaveLength(1)
    expect(request.mock.calls.some(([r]) => /sign/i.test(r.method))).toBe(false)
  })
  it.each(['accountsChanged', 'chainChanged', 'disconnect', 'abort'])('retains the session guard during network alignment (%s)', async event => {
    const { quote } = smartFixture(), wallet = typedDataWallet(), original = wallet.provider.request, controller = new AbortController()
    const request = vi.spyOn(wallet.provider, 'request').mockImplementation(async args => {
      if (args.method === 'wallet_switchEthereumChain') {
        if (event === 'abort') controller.abort()
        else wallet.listeners.get(event)?.forEach(fn => fn(event === 'accountsChanged' ? [] : '0xaa36a7'))
        return null
      }
      return original(args)
    })
    const session = createSmartWithdrawalSigner(wallet, quote.notes, quote.scope, settings, vi.fn(async () => {}), controller.signal); sessions.push(session)
    await expect(session.signTypedData(batchTypedData(quote.withdrawal, settings))).rejects.toThrow('changed or was cancelled')
    expect(request.mock.calls.some(([r]) => /sign/i.test(r.method))).toBe(false)
  })
  it('explains a wallet-side chain mismatch without retrying the signature or changing its domain', async () => {
    const { quote } = smartFixture(), wallet = typedDataWallet(), original = wallet.provider.request
    const request = vi.spyOn(wallet.provider, 'request').mockImplementation(async args => {
      if (args.method === 'eth_signTypedData_v4') throw { code: -32600, message: 'JSON is not a valid request object. The domain chainId (1) does not match the current network chainId (11155111)' }
      return original(args)
    })
    const session = createSmartWithdrawalSigner(wallet, quote.notes, quote.scope, settings, vi.fn(async () => {})); sessions.push(session)
    await expect(session.signTypedData(batchTypedData(quote.withdrawal, settings))).rejects.toThrow("wallet's signing network does not match Ethereum (1)")
    const signatures = request.mock.calls.filter(([r]) => /sign/i.test(r.method))
    expect(signatures).toHaveLength(1)
    expect(JSON.parse((signatures[0]![0].params as string[])[1]!).domain.chainId).toBe(1)
  })
  it('uses only eth_signTypedData_v4 for a deployed reused account and binds the final signature', async () => {
    const { quote } = smartFixture(12, 'eth', 'account', true), wallet = typedDataWallet(), request = vi.spyOn(wallet.provider, 'request')
    const approve = vi.fn(async () => {}), session = createSmartWithdrawalSigner(wallet, quote.notes, quote.scope, settings, approve); sessions.push(session)
    quote.withdrawal.userOperation.signature = await session.signTypedData(batchTypedData(quote.withdrawal, settings))
    expect(await session.verifyPrepared(quote.withdrawal)).toBe(quote.signedHash)
    expect(request.mock.calls.filter(([r]) => /sign/i.test(r.method)).map(([r]) => r.method)).toEqual(['eth_signTypedData_v4'])
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ kind: 'user-operation', fee: quote.fee }))
    quote.withdrawal.userOperation.preVerificationGas = '0x100001'
    await expect(session.verifyPrepared(quote.withdrawal)).rejects.toThrow('differs')
  })
  it('rejects a signature from another EOA and account changes during consent', async () => {
    const { quote } = smartFixture(), wallet = typedDataWallet(privateKeyToAccount(`0x${'11'.repeat(32)}`))
    const session = createSmartWithdrawalSigner(wallet, quote.notes, quote.scope, settings, vi.fn(async () => {})); sessions.push(session)
    await expect(session.signTypedData(batchTypedData(quote.withdrawal, settings))).rejects.toThrow('does not belong')
    const normal = typedDataWallet(), request = vi.spyOn(normal.provider, 'request')
    const changed = createSmartWithdrawalSigner(normal, quote.notes, quote.scope, settings, async () => { normal.listeners.get('accountsChanged')?.forEach(fn => fn([])) }); sessions.push(changed)
    await expect(changed.signTypedData(batchTypedData(quote.withdrawal, settings))).rejects.toThrow('changed or was cancelled')
    expect(request.mock.calls.some(([r]) => /sign/i.test(r.method))).toBe(false)
  })
})

describe('submission and receipt recovery', () => {
  it.each(['maxFeePerGas must be at least 110000002 (current maxFeePerGas: 606375012)', 'maxPriorityFeePerGas is too low'])(
    'marks an explicit minimum-fee rejection as rejected without automatically sending again: %s', async reason => {
      const { quote } = smartFixture(), wallet = typedDataWallet(), update = vi.fn()
      quote.withdrawal.userOperation.signature = await signingAccount.signTypedData(batchTypedData(quote.withdrawal, settings))
      vi.mocked(jsonRpc).mockRejectedValueOnce(new EndpointRpcError('eth_sendUserOperation', -32602, undefined, reason))
      await expect(submitSmartWithdrawal(quote, settings, wallet, update)).rejects.toThrow(reason)
      expect(update).toHaveBeenLastCalledWith(quote.id, expect.objectContaining({ status: 'rejected', message: expect.stringContaining('refresh fees') }))
      expect(jsonRpc).toHaveBeenCalledOnce()
    })
  it.each(['unknown-code', 'invalid-params', 'transport', 'after-acceptance'])('keeps %s failures uncertain rather than enabling draft replacement', async scenario => {
    const { quote } = smartFixture(), wallet = typedDataWallet(), update = vi.fn()
    quote.withdrawal.userOperation.signature = await signingAccount.signTypedData(batchTypedData(quote.withdrawal, settings))
    const reason = 'maxFeePerGas must be at least 110000002'
    const error = scenario === 'transport' ? new Error(reason) : new EndpointRpcError('eth_sendUserOperation', scenario === 'unknown-code' ? -32500 : -32602, undefined,
      scenario === 'invalid-params' ? 'Invalid UserOperation parameters' : reason)
    if (scenario === 'after-acceptance') vi.mocked(jsonRpc).mockResolvedValueOnce(quote.signedHash)
    vi.mocked(jsonRpc).mockRejectedValueOnce(error)
    await expect(submitSmartWithdrawal(quote, settings, wallet, update)).rejects.toThrow()
    expect(update).toHaveBeenLastCalledWith(quote.id, expect.objectContaining({ status: 'unknown' }))
    expect(vi.mocked(jsonRpc).mock.calls.filter(([, method]) => method === 'eth_sendUserOperation')).toHaveLength(1)
  })
  it.each(['eth', 'usdc'].flatMap(symbol => [false, true].map(deployed => ({ symbol, deployed }))))(
    'submits the exact direct one-note $symbol operation (deployed=$deployed)', async ({ symbol, deployed }) => {
      const { quote } = smartFixture(1, symbol, 'custom', deployed), wallet = typedDataWallet(), update = vi.fn()
      quote.withdrawal.userOperation.signature = await signingAccount.signTypedData(batchTypedData(quote.withdrawal, settings))
      mockReceipt(quote)
      vi.mocked(jsonRpc).mockResolvedValueOnce(quote.signedHash).mockResolvedValueOnce({ receipt: { transactionHash: txHash } })
      await submitSmartWithdrawal(quote, settings, wallet, update)
      expect(jsonRpc).toHaveBeenCalledWith(settings.bundlerUrl, 'eth_sendUserOperation', [quote.withdrawal.userOperation, quote.withdrawal.entryPointAddress])
      expect(jsonRpc).toHaveBeenCalledTimes(2)
      expect(update).toHaveBeenLastCalledWith(quote.id, expect.objectContaining({ status: 'confirmed', transactionHash: txHash }))
    })
  it('points a failed direct one-note receipt at the recipient rather than claiming funds went through the account', async () => {
    const { quote } = smartFixture(1, 'eth', 'custom'), update = vi.fn()
    mockReceipt(quote, false); vi.mocked(jsonRpc).mockResolvedValue({ receipt: { transactionHash: txHash } })
    expect(await reconcileSmartWithdrawal(quote, settings, update, 0)).toBe(false)
    const message = update.mock.calls.at(-1)![1].message
    expect(message).toContain('withdrawal recipient for the payout and refund')
    expect(message).not.toContain('Check the smart account')
  })
  it.each(['missing', 'failed', 'unclassified', 'expired'])('blocks custom calls with a %s simulation before contacting a wallet or bundler', async mode => {
    const { quote } = actionFixture(), wallet = typedDataWallet(), request = vi.spyOn(wallet.provider, 'request')
    if (mode !== 'missing') quote.simulation = { status: mode === 'failed' ? 'failed' : mode === 'expired' ? 'passed' : 'unavailable', hash: quote.signedHash,
      checkedAt: Date.now() - (mode === 'expired' ? 300_001 : 0), message: 'Test simulation' }
    await expect(submitSmartWithdrawal(quote, settings, wallet, vi.fn())).rejects.toThrow('Resolve the contract-call simulation')
    expect(request).not.toHaveBeenCalled()
    expect(jsonRpc).not.toHaveBeenCalled()
  })
  it('blocks an explicitly failed optional simulation before any wallet or submission RPC request', async () => {
    const { quote } = smartFixture(1, 'eth', 'custom'), wallet = typedDataWallet(), request = vi.spyOn(wallet.provider, 'request')
    quote.simulation = { status: 'failed', hash: quote.signedHash, checkedAt: Date.now(), message: 'Validation failed', failureKind: 'gas' }
    await expect(submitSmartWithdrawal(quote, settings, wallet, vi.fn())).rejects.toThrow('Resolve the withdrawal simulation')
    expect(request).not.toHaveBeenCalled(); expect(jsonRpc).not.toHaveBeenCalled()
  })
  it('publishes both hashes immediately and retries a receipt while the chain RPC catches up', async () => {
    vi.useFakeTimers()
    const { quote } = smartFixture(); mockReceipt(quote)
    const read = vi.mocked(publicClientFor(settings).getTransactionReceipt)
    read.mockRejectedValueOnce(new TransactionReceiptNotFoundError({ hash: txHash }))
    vi.mocked(jsonRpc).mockResolvedValue({ receipt: { transactionHash: txHash } })
    const update = vi.fn(), pending = reconcileSmartWithdrawal(quote, settings, update, 5_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(update).toHaveBeenLastCalledWith(quote.id, expect.objectContaining({ hash: quote.signedHash, transactionHash: txHash, status: 'submitted' }))
    expect(update.mock.calls.some(([, row]) => row.status === 'confirmed')).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await pending).toBe(true)
    expect(read).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenLastCalledWith(quote.id, expect.objectContaining({ status: 'confirmed' }))
  })
  it.each([true, false])('leaves an unavailable receipt pending with a usable hash, transaction known: %s', async known => {
    const { quote } = smartFixture(); mockReceipt(quote)
    vi.mocked(publicClientFor(settings).getTransactionReceipt).mockRejectedValue(new TransactionReceiptNotFoundError({ hash: txHash }))
    vi.mocked(jsonRpc).mockResolvedValue(known ? { receipt: { transactionHash: txHash } } : null)
    const update = vi.fn()
    expect(await reconcileSmartWithdrawal(quote, settings, update, 0)).toBeNull()
    expect(update).toHaveBeenLastCalledWith(quote.id, expect.objectContaining({ hash: quote.signedHash, status: 'submitted', message: expect.stringContaining('Awaiting on-chain confirmation') }))
    if (known) expect(update).toHaveBeenLastCalledWith(quote.id, expect.objectContaining({ transactionHash: txHash }))
    expect(vi.mocked(jsonRpc).mock.calls.some(([, method]) => method === 'eth_sendUserOperation')).toBe(false)
    // A later explicit check can confirm without rebroadcasting or signing again.
    mockReceipt(quote); vi.mocked(jsonRpc).mockResolvedValue({ receipt: { transactionHash: txHash } })
    expect(await reconcileSmartWithdrawal(quote, settings, update, 0)).toBe(true)
  })
  it.each(['wallet', 'custom'] as const)('submits one operation to %s without authorization and links the transaction receipt', async payout => {
    const { quote } = smartFixture(12, 'eth', payout), wallet = typedDataWallet()
    quote.withdrawal.userOperation.signature = await signingAccount.signTypedData(batchTypedData(quote.withdrawal, settings))
    mockReceipt(quote)
    vi.mocked(jsonRpc).mockResolvedValueOnce(quote.signedHash).mockResolvedValueOnce({ receipt: { transactionHash: txHash } })
    let row: Partial<Progress> = {}
    await submitSmartWithdrawal(quote, settings, wallet, (_id, patch) => { row = { ...row, ...patch } })
    expect(row).toMatchObject({ hash: quote.signedHash, transactionHash: txHash, status: 'confirmed' })
    expect(vi.mocked(jsonRpc).mock.calls.filter(([, method]) => method === 'eth_sendUserOperation')).toHaveLength(1)
    expect(quote.withdrawal.userOperation).not.toHaveProperty('eip7702Auth')
    expect(assertSmartAccount).toHaveBeenCalled()
  })
  it('reports execution failure with its transaction hash and a recovery instruction', async () => {
    const { quote } = smartFixture(); mockReceipt(quote, false)
    vi.mocked(jsonRpc).mockResolvedValue({ receipt: { transactionHash: txHash } })
    const update = vi.fn()
    expect(await reconcileSmartWithdrawal(quote, settings, update)).toBe(false)
    expect(update).toHaveBeenCalledWith(quote.id, expect.objectContaining({ status: 'failed', transactionHash: txHash, message: expect.stringContaining('Recover funds') }))
  })
  it('rejects an unrelated receipt and never automatically resubmits an ambiguous operation', async () => {
    const { quote } = smartFixture(), wallet = typedDataWallet()
    quote.withdrawal.userOperation.signature = await signingAccount.signTypedData(batchTypedData(quote.withdrawal, settings))
    mockReceipt({ ...quote, signedHash: txHash })
    vi.mocked(jsonRpc).mockResolvedValueOnce({ receipt: { transactionHash: txHash } })
    await expect(reconcileSmartWithdrawal(quote, settings, vi.fn())).rejects.toThrow('does not confirm')
    vi.mocked(jsonRpc).mockReset().mockRejectedValueOnce(new Error('Disconnected'))
    const update = vi.fn()
    await expect(submitSmartWithdrawal(quote, settings, wallet, update)).rejects.toThrow('Disconnected')
    expect(update).toHaveBeenLastCalledWith(quote.id, expect.objectContaining({ status: 'unknown' }))
    expect(vi.mocked(jsonRpc).mock.calls.filter(([, method]) => method === 'eth_sendUserOperation')).toHaveLength(1)
  })
})

describe('SDK proof-frame bridge', () => {
  function frame(script: (payload: Record<string, unknown>, port: MessagePort) => void) {
    let child: MessagePort | undefined
    const frame = { hidden: false, title: '', src: '', onload: () => {}, onerror: () => {}, remove: vi.fn(() => child?.close()),
      contentWindow: { postMessage: (payload: Record<string, unknown>, _origin: string, transferred: MessagePort[]) => { child = transferred[0]!; ports.push(child); script(payload, child) } } }
    vi.stubGlobal('document', { createElement: () => frame, body: { append: () => queueMicrotask(() => frame.onload()) } })
    return frame
  }
  it('loads smart-account preparation beneath the IPFS directory without changing the signing origin', async () => {
    vi.stubGlobal('location', new URL('https://gateway.example/ipfs/bafy-test/#multi-withdraw'))
    vi.stubEnv('BASE_URL', './')
    const { quote } = smartFixture(), wallet = typedDataWallet()
    const child = frame((_payload, port) => port.postMessage({ status: 'error', message: 'Synthetic frame result' }))
    await expect(prepareSmartWithdrawal(quote.notes.map(note => note.raw).join('\n'), wallet, quote.scope, settings, vi.fn(), vi.fn(async () => {}))).rejects.toThrow('Synthetic frame result')
    expect(child.src).toBe('https://gateway.example/ipfs/bafy-test/withdraw-frame.html')
    expect(child.remove).toHaveBeenCalledOnce()
  })
  it.each(['wallet', 'custom'] as const)('passes the %s recipient through the frame and accepts only a wallet-approved result', async payout => {
    const { quote } = smartFixture(2, 'eth', payout), wallet = typedDataWallet(), request = vi.spyOn(wallet.provider, 'request')
    const child = frame((payload, port) => {
      expect(payload.type).toBe('tornado-smart-prepare'); expect(payload.scope).toEqual(quote.scope)
      expect(payload.recipient).toBe(smartRecipient(quote.scope))
      port.onmessage = ({ data }) => { quote.withdrawal.userOperation.signature = data.result; port.postMessage({ status: 'ready', withdrawal: quote.withdrawal }) }
      port.postMessage({ status: 'sign', id: 1, method: 'signTypedData', request: batchTypedData(quote.withdrawal, settings) })
    })
    const prepared = await prepareSmartWithdrawal(quote.notes.map(note => note.raw).join('\n'), wallet, quote.scope, settings, vi.fn(), vi.fn(async () => {}))
    expect(prepared.signedHash).toBe(quote.signedHash); expect(child.remove).toHaveBeenCalledOnce()
    expect(request.mock.calls.filter(([r]) => /sign/i.test(r.method)).map(([r]) => r.method)).toEqual(['eth_signTypedData_v4'])
  })
  it('blocks any authorization request without opening the wallet', async () => {
    const { quote } = smartFixture(), wallet = typedDataWallet(), request = vi.spyOn(wallet.provider, 'request')
    frame((_payload, port) => port.postMessage({ status: 'sign', id: 1, method: 'signAuthorization', request: {} }))
    await expect(prepareSmartWithdrawal(quote.notes.map(note => note.raw).join('\n'), wallet, quote.scope, settings, vi.fn(), vi.fn(async () => {}))).rejects.toThrow('only use typed-data')
    expect(request.mock.calls.some(([r]) => /sign/i.test(r.method))).toBe(false)
  })
})
