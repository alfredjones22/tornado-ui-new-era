import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, parseAbi, parseAbiParameters, toHex } from 'viem'
import { canSubmitSimulation, retainSimulationFailure, simulateSmartWithdrawal, simulationMatches } from '../src/core/withdrawal-simulation'
import { EndpointRpcError, EndpointTransportError, jsonRpc } from '../src/core/rpc'
import { settings } from './fixtures/multi-withdrawal'
import { actionFixture } from './fixtures/smart-actions'
import { smartFixture } from './fixtures/smart-withdrawal'
import { batchTypedData } from '../src/core/batch-policy'

vi.mock('../src/core/rpc', async original => ({ ...await original<object>(), jsonRpc: vi.fn() }))
const events = parseAbi(['event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)', 'event UserOperationRevertReason(bytes32 indexed userOpHash,address indexed sender,uint256 nonce,bytes revertReason)'])
afterEach(() => vi.resetAllMocks())
function setup(success = true, outer = true, matching = true, actionIndex?: number, quote = actionFixture().quote) {
  const op = quote.withdrawal.userOperation
  const logs = [{ address: quote.withdrawal.entryPointAddress, topics: encodeEventTopics({ abi: events, eventName: 'UserOperationEvent', args: { userOpHash: matching ? quote.signedHash : toHex(1n, { size: 32 }), sender: op.sender, paymaster: op.paymaster! } }),
    data: encodeAbiParameters(parseAbiParameters('uint256 nonce,bool success,uint256 cost,uint256 gas'), [quote.scope.account.nonce, success, 100n, 200n]) }]
  if (actionIndex !== undefined) logs.push({ address: quote.withdrawal.entryPointAddress, topics: encodeEventTopics({ abi: events, eventName: 'UserOperationRevertReason', args: { userOpHash: quote.signedHash, sender: op.sender } }),
    data: encodeAbiParameters(parseAbiParameters('uint256 nonce,bytes reason'), [quote.scope.account.nonce, encodeErrorResult({ abi: parseAbi(['error ExecuteError(uint256 index,bytes reason)']), errorName: 'ExecuteError', args: [BigInt(quote.notes.length - 1 + actionIndex), '0x1234'] })]) })
  vi.mocked(jsonRpc).mockImplementation(async (_url, method) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_simulateV1') return [{ number: '0x100', calls: [{ status: outer ? '0x1' : '0x0', gasUsed: '0x1000', logs, error: outer ? undefined : { message: 'validation reverted' } }] }]
    throw new Error('Unexpected RPC')
  })
  return quote
}
describe('exact full UserOperation preview', () => {
  it.each([1, 2])('simulates the exact signed %s-note forwarding operation even without custom calls', async count => {
    const quote = setup(true, true, true, undefined, smartFixture(count, count === 1 ? 'eth' : 'usdc', 'custom', count === 2).quote)
    const result = await simulateSmartWithdrawal(quote, settings)
    expect(result.status).toBe('passed')
    const params = vi.mocked(jsonRpc).mock.calls.find(call => call[1] === 'eth_simulateV1')![2]!
    const payload = params[0] as { blockStateCalls: { stateOverrides: Record<string, unknown>; calls: { from: string; to: string; data: `0x${string}` }[] }[] }
    const tx = payload.blockStateCalls[0]!.calls[0]!
    const decoded = decodeFunctionData({ abi: parseAbi(['function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)']), data: tx.data })
    const canonical = (record: object) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, typeof value === 'string' ? value.toLowerCase() : value]))
    expect(canonical(decoded.args[0][0]!)).toEqual(canonical({ ...batchTypedData(quote.withdrawal, settings).message, signature: quote.withdrawal.userOperation.signature }))
    expect(Object.keys(payload.blockStateCalls[0]!.stateOverrides)).toEqual([tx.from])
    expect(vi.mocked(jsonRpc).mock.calls.every(call => call[1] === 'eth_chainId' || call[1] === 'eth_simulateV1')).toBe(true)
  })
  it('keeps preview optional without contract calls but blocks failed, mismatched and stale results once checked', () => {
    const { quote } = smartFixture(), result = { status: 'passed' as const, hash: quote.signedHash, checkedAt: Date.now(), message: 'Passed' }
    expect(canSubmitSimulation(undefined, quote)).toBe(true)
    expect(canSubmitSimulation(undefined, null)).toBe(false)
    expect(canSubmitSimulation(undefined, actionFixture().quote)).toBe(false)
    expect(canSubmitSimulation(result, quote)).toBe(true)
    expect(canSubmitSimulation({ ...result, status: 'failed' }, quote)).toBe(false)
    expect(canSubmitSimulation({ ...result, hash: toHex(999n, { size: 32 }) }, quote)).toBe(false)
    expect(canSubmitSimulation(result, quote, result.checkedAt + 300_001)).toBe(false)
  })
  it('simulates real handleOps including factory and proof, overriding only the simulated bundler balance', async () => {
    const quote = setup(), result = await simulateSmartWithdrawal(quote, settings)
    expect(result).toMatchObject({ status: 'passed', hash: quote.signedHash, block: 256n, gasUsed: 4096n })
    expect(simulationMatches(result, quote)).toBe(true)
    const params = vi.mocked(jsonRpc).mock.calls.find(call => call[1] === 'eth_simulateV1')![2]!
    const payload = params[0] as { blockStateCalls: { stateOverrides: Record<string, unknown>; calls: { from: string; to: string; data: `0x${string}` }[] }[] }
    const block = payload.blockStateCalls[0]!, tx = block.calls[0]!
    expect(Object.keys(block.stateOverrides)).toEqual([tx.from])
    expect(block.stateOverrides[tx.from]).toEqual({ balance: toHex(10n ** 30n) })
    expect(tx.to).toBe(quote.withdrawal.entryPointAddress)
    const decoded = decodeFunctionData({ abi: parseAbi(['function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)']), data: tx.data })
    expect(decoded.args[0][0]!.callData).toBe(quote.withdrawal.userOperation.callData)
    expect(decoded.args[0][0]!.initCode.startsWith(quote.scope.account.factory.toLowerCase())).toBe(true)
    expect(vi.mocked(jsonRpc).mock.calls.some(call => /send/.test(call[1]))).toBe(false)
  })
  it('treats inner execution failure as failure even when outer handleOps succeeds, and locates the action', async () => {
    const quote = setup(false, true, true, 1)
    expect(await simulateSmartWithdrawal(quote, settings)).toMatchObject({ status: 'failed', failedAction: 2 })
  })
  it('rejects a reverted outer transaction', async () => {
    expect(await simulateSmartWithdrawal(setup(false, false), settings)).toMatchObject({ status: 'failed' })
  })
  it('never calls a missing or unrelated UserOperation event a successful simulation', async () => {
    expect(await simulateSmartWithdrawal(setup(true, true, false), settings)).toMatchObject({ status: 'failed', failureKind: 'inconclusive' })
  })
  it('blocks RPC-level execution reverts instead of calling them an unavailable preview', async () => {
    const quote = setup()
    vi.mocked(jsonRpc).mockImplementation(async (_url, method) => {
      if (method === 'eth_chainId') return '0x1'
      throw new Error('eth_simulateV1 was rejected: execution reverted: AA33 reverted')
    })
    expect(await simulateSmartWithdrawal(quote, settings)).toMatchObject({ status: 'failed' })
  })
  it('rejects operation tampering before using any simulation endpoint', async () => {
    const quote = setup()
    quote.withdrawal.userOperation.preVerificationGas = '0x1'
    await expect(simulateSmartWithdrawal(quote, settings)).rejects.toThrow('changed after signing')
    expect(jsonRpc).not.toHaveBeenCalled()
  })
  it('allows explicit detailed-preview unavailability while preserving bundler-estimated status', async () => {
    const quote = setup()
    vi.mocked(jsonRpc).mockRejectedValue(new EndpointRpcError('eth_simulateV1', -32601, undefined, 'method not found'))
    const result = await simulateSmartWithdrawal(quote, settings, 'https://simulation.example.com')
    expect(result.status).toBe('unavailable')
    expect(result.message).toContain('Bundler estimation passed; detailed preview unavailable')
    expect(vi.mocked(jsonRpc)).toHaveBeenLastCalledWith('https://simulation.example.com/', 'eth_chainId')
    expect(simulationMatches({ ...result, checkedAt: Date.now() - 300001 }, quote)).toBe(false)
    expect(simulationMatches({ ...result, hash: toHex(1n, { size: 32 }) }, quote)).toBe(false)
  })
  it.each([
    ['out of gas', 'gas'], ['insufficient funds for transfer', 'funding'], ['ERC20: transfer amount exceeds balance', 'funding'],
    ['insufficient allowance', 'funding'], ['Unknown internal error', 'inconclusive'],
  ])('blocks a plain %s error rather than treating it as an optional preview', async (message, kind) => {
    const quote = setup()
    vi.mocked(jsonRpc).mockImplementation(async (_url, method) => { if (method === 'eth_chainId') return '0x1'; throw new Error(message) })
    const result = await simulateSmartWithdrawal(quote, settings)
    expect(result).toMatchObject({ status: 'failed', failureKind: kind })
    expect(canSubmitSimulation(result, quote)).toBe(false)
  })
  it('decodes a nested action token-balance failure without leaking calldata', async () => {
    const quote = setup(), data = encodeErrorResult({ abi: parseAbi(['error ExecuteError(uint256 index,bytes reason)']), errorName: 'ExecuteError', args: [1n,
      encodeErrorResult({ abi: parseAbi(['error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)']), errorName: 'ERC20InsufficientBalance', args: [quote.scope.account.address, 1n, 10n] })] })
    vi.mocked(jsonRpc).mockImplementation(async (_url, method) => { if (method === 'eth_chainId') return '0x1'; throw new EndpointRpcError('eth_simulateV1', -32000, { originalError: { data } }, 'execution reverted') })
    const result = await simulateSmartWithdrawal(quote, settings)
    expect(result).toMatchObject({ status: 'failed', failureKind: 'funding', failedAction: 1 })
    expect(result.message).toContain('1 available, 10 needed')
    expect(result.message).not.toContain(data)
  })
  it('allows recognized infrastructure unavailability but never lets it erase a known failure', async () => {
    const quote = setup()
    vi.mocked(jsonRpc).mockRejectedValue(new EndpointTransportError('Endpoint offline'))
    const unavailable = await simulateSmartWithdrawal(quote, settings)
    expect(unavailable).toMatchObject({ status: 'unavailable', availabilityReason: 'transport' })
    expect(canSubmitSimulation(unavailable, quote)).toBe(true)
    expect(canSubmitSimulation({ ...unavailable, availabilityReason: undefined }, quote)).toBe(false)
    const failed = { ...unavailable, status: 'failed' as const, failureKind: 'funding' as const }
    expect(retainSimulationFailure(failed, unavailable)).toBe(failed)
    const passed = { ...unavailable, status: 'passed' as const }
    expect(retainSimulationFailure(failed, passed)).toBe(passed)
  })
})
