import { decodeEventLog, encodeFunctionData, hashTypedData, parseAbi, toHex, type Address, type Hex } from 'viem'
import { batchTypedData } from './batch-policy'
import { checkedUrl, EndpointRpcError, jsonRpc, safeError, type ConnectionSettings } from './rpc'
import type { SmartWithdrawalQuote } from './smart-withdrawal'
import { validateSmartWithdrawal } from './smart-withdrawal-policy'
import { revertExplanation, simulationError, type FailureKind } from './simulation-errors'

const entryAbi = parseAbi([
  'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)',
])
const eventsAbi = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)',
  'event UserOperationRevertReason(bytes32 indexed userOpHash,address indexed sender,uint256 nonce,bytes revertReason)',
])
const transferAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])
// A simulated bundler, not the controller or sender. Override only its ETH for
// the outer transaction. Never inject funds/code/storage into the smart account
// or token contracts: the actual proofs must fund execution in handleOps.
const simulator: Address = '0x000000000000000000000000000000000000dEaD'
interface RpcLog { address: Address; data: Hex; topics: [Hex, ...Hex[]] }
interface SimulatedBlock { number: Hex; calls: { status: Hex; gasUsed: Hex; logs?: RpcLog[]; error?: { data?: Hex; message?: string } }[] }
export interface SimulationTransfer { token: Address; from: Address; to: Address; value: bigint }
export interface WithdrawalSimulation {
  status: 'passed' | 'failed' | 'unavailable'; hash: Hex; checkedAt: number; message: string
  block?: bigint; gasUsed?: bigint; transfers?: SimulationTransfer[]; failedAction?: number
  failureKind?: FailureKind; availabilityReason?: 'transport' | 'unsupported'
}
export function canSubmitSimulation(result: WithdrawalSimulation | undefined, quote: SmartWithdrawalQuote | null, now = Date.now()) {
  if (!quote) return false
  // Detailed preview remains optional without custom calls. Once attempted,
  // a failure must block that exact operation, including in the submit adapter.
  if (!result) return !quote.scope.calls?.length
  return simulationMatches(result, quote, now) && (result.status === 'passed' || result.status === 'unavailable' &&
    ['transport', 'unsupported'].includes(result.availabilityReason ?? '') && quote.withdrawal.gasEstimation?.status === 'estimated')
}
/** A lost/unsupported RPC on recheck cannot erase a known failure of the same op. */
export function retainSimulationFailure(previous: WithdrawalSimulation | undefined, next: WithdrawalSimulation) {
  return previous?.hash === next.hash && previous.status === 'failed' && next.status === 'unavailable' ? previous : next
}
export function simulationMatches(result: WithdrawalSimulation | undefined, quote: SmartWithdrawalQuote | null, now = Date.now()) {
  return !!quote && !!result && result.hash === quote.signedHash && now - result.checkedAt < 5 * 60_000
}
export async function simulateSmartWithdrawal(quote: SmartWithdrawalQuote, settings: ConnectionSettings, rpcOverride?: string): Promise<WithdrawalSimulation> {
  validateSmartWithdrawal(quote.notes, quote.scope, quote.withdrawal, settings)
  const typed = batchTypedData(quote.withdrawal, settings)
  if (hashTypedData(typed) !== quote.signedHash) throw new Error('The prepared operation changed after signing.')
  const base = { hash: quote.signedHash, checkedAt: Date.now() }, endpoint = checkedUrl(rpcOverride?.trim() || settings.rpcUrl)
  try {
    if (BigInt(await jsonRpc<string>(endpoint, 'eth_chainId')) !== BigInt(settings.chainId)) throw new Error('The simulation RPC is on a different network.')
    const op = { ...typed.message, signature: quote.withdrawal.userOperation.signature }
    const gas = BigInt(`0x${op.accountGasLimits.slice(2, 34)}`) +
      BigInt(`0x${op.accountGasLimits.slice(34)}`) + BigInt(op.preVerificationGas) +
      BigInt(quote.withdrawal.userOperation.paymasterVerificationGasLimit ?? 0) + BigInt(quote.withdrawal.userOperation.paymasterPostOpGasLimit ?? 0) + 1_000_000n
    const data = encodeFunctionData({ abi: entryAbi, functionName: 'handleOps', args: [[op], simulator] })
    const blocks = await jsonRpc<SimulatedBlock[]>(endpoint, 'eth_simulateV1', [{
      blockStateCalls: [{ stateOverrides: { [simulator]: { balance: toHex(10n ** 30n) } },
        calls: [{ from: simulator, to: quote.withdrawal.entryPointAddress, data, gas: toHex(gas) }] }],
      traceTransfers: true, validation: false, returnFullTransactions: false,
    }, 'latest'])
    const block = blocks?.[0], call = block?.calls?.[0]
    if (!call || !['0x0', '0x1'].includes(call.status)) throw new Error('The simulation RPC returned an incomplete result.')
    if (call.status === '0x0') return { ...base, ...simulationError(new EndpointRpcError('eth_simulateV1', undefined, call.error?.data,
      `Execution reverted. ${safeError(call.error?.message ?? 'Review the calls, funding and gas limits.')}`), quote.notes.length, quote.scope.calls?.length ?? 0), status: 'failed' }
    let success: boolean | undefined, reason: Hex | undefined
    const transfers: SimulationTransfer[] = []
    for (const log of call.logs ?? []) {
      if (log.address.toLowerCase() === quote.withdrawal.entryPointAddress.toLowerCase()) {
        try {
          const event = decodeEventLog({ abi: eventsAbi, topics: log.topics, data: log.data })
          if ((event.eventName === 'UserOperationEvent' || event.eventName === 'UserOperationRevertReason') && event.args.userOpHash.toLowerCase() === quote.signedHash.toLowerCase() &&
            event.args.sender.toLowerCase() === quote.scope.account.address.toLowerCase() && event.args.nonce === quote.scope.account.nonce) {
            if (event.eventName === 'UserOperationEvent' && event.args.paymaster.toLowerCase() === quote.withdrawal.paymasterAddress.toLowerCase()) success = event.args.success
            if (event.eventName === 'UserOperationRevertReason') reason = event.args.revertReason
          }
        } catch { /* Unrelated EntryPoint log. */ }
      }
      try {
        const { args } = decodeEventLog({ abi: transferAbi, topics: log.topics, data: log.data })
        // Only show transfers touching this smart account; unrelated events are noise.
        if ([args.from, args.to].some(address => address.toLowerCase() === quote.scope.account.address.toLowerCase())) transfers.push({ token: log.address, ...args })
      } catch { /* Not a Transfer. */ }
    }
    if (success === undefined) throw new Error('No matching UserOperation result was returned. Detailed preview is unavailable.')
    const failure = success ? undefined : revertExplanation(reason, quote.notes.length, quote.scope.calls?.length ?? 0)
    return { ...base, status: success ? 'passed' : 'failed', block: BigInt(block!.number), gasUsed: BigInt(call.gasUsed), transfers,
      ...(failure ? { failureKind: failure.failureKind, failedAction: failure.failedAction } : {}), message: success
        ? `Full UserOperation simulation passed, including account validation, withdrawals${quote.scope.calls?.length ? ' and contract calls' : quote.scope.payout !== 'account' && quote.notes.length > 1 ? ' and forwarding' : ''}.`
        : `Execution reverted${failure?.failedAction ? ` at custom action ${failure.failedAction}` : ''}. ${failure!.message} The app has not submitted this operation.` }
  } catch (error) {
    // Some providers return an RPC error for a reverted simulated transaction
    // rather than a calls[0].status result. Do not downgrade a known revert to
    // an optional-preview warning and accidentally permit submission.
    return { ...base, ...simulationError(error, quote.notes.length, quote.scope.calls?.length ?? 0) }
  }
}
