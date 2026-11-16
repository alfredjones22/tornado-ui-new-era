import { decodeErrorResult, parseAbi, type Hex } from 'viem'
import { EndpointRpcError, EndpointTransportError, safeError } from './rpc'
const errors = parseAbi([
  'error ExecuteError(uint256 index,bytes reason)', 'error Error(string reason)', 'error Panic(uint256 code)',
  'error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)',
  'error ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)',
])
export type FailureKind = 'gas' | 'funding' | 'execution' | 'inconclusive'
function kindFor(message: string): FailureKind {
  if (/out.of.gas|\bAA(?:26|36|40|41|95)\b|(?:call|verification|execution).*gas.*(?:too low|insufficient|exceed)/i.test(message)) return 'gas'
  if (/insufficient (?:token )?(?:funds|balance|allowance)|not enough (?:funds|eth|balance|tokens)|(?:amount|value).*(?:exceed|greater than).*(?:balance|allowance)|ERC20Insufficient/i.test(message)) return 'funding'
  return 'execution'
}
export function revertExplanation(data: Hex | undefined, withdrawals: number, actions: number) {
  let reason = data, failedAction: number | undefined
  if (withdrawals === 1 && actions === 1) failedAction = 1
  for (let depth = 0; reason && reason !== '0x' && depth < 4; depth++) {
    try {
      const decoded = decodeErrorResult({ abi: errors, data: reason })
      if (decoded.errorName === 'ExecuteError') {
        const index = Number(decoded.args[0]) - (withdrawals - 1)
        if (index >= 0 && index < actions) failedAction = index + 1
        reason = decoded.args[1]; continue
      }
      const message = decoded.errorName === 'Error' ? safeError(decoded.args[0]) : decoded.errorName === 'Panic' ? `Contract panic (${decoded.args[0]}).`
        : decoded.errorName === 'ERC20InsufficientBalance' ? `Insufficient token balance: ${decoded.args[1]} available, ${decoded.args[2]} needed (base units).`
          : `Insufficient token allowance: ${decoded.args![1]} approved, ${decoded.args![2]} needed (base units).`
      return { message, failureKind: kindFor(message), failedAction }
    } catch { break }
  }
  return { message: 'A contract call reverted without a readable reason. Check its gas budget, funding, approvals and arguments.', failureKind: 'execution' as FailureKind, failedAction }
}
export function rpcRevertData(value: unknown, depth = 0): Hex | undefined {
  if (typeof value === 'string' && /^0x(?:[\da-f]{2})+$/i.test(value)) return value as Hex
  if (value && typeof value === 'object' && depth < 4) {
    const item = value as Record<string, unknown>
    for (const key of ['data', 'error', 'originalError']) { const data = rpcRevertData(item[key], depth + 1); if (data) return data }
  }
}
export function simulationError(error: unknown, withdrawals: number, actions: number) {
  const message = safeError(error), data = error instanceof EndpointRpcError ? rpcRevertData(error.data) : undefined
  const known = /execution reverted|\bAA\d{2}\b|\bFailedOp\b|out.of.gas|insufficient|not enough|(?:gas|amount|value).*exceed|allowance|invalid opcode|stack (?:under|over)flow/i.test(message)
  if (data) {
    const decoded = revertExplanation(data, withdrawals, actions)
    return { status: 'failed' as const, ...decoded, message: `Simulation failed${decoded.failedAction ? ` at custom action ${decoded.failedAction}` : ''}. ${decoded.message}` }
  }
  if (known) return { status: 'failed' as const, failureKind: kindFor(message), message: `Simulation failed. ${message}` }
  // Only positively identified infrastructure failures are optional previews.
  // Unknown RPC errors, wrong-chain responses and malformed results fail closed.
  const availabilityReason = error instanceof EndpointTransportError ? 'transport' as const
    : error instanceof EndpointRpcError && [-32601, -32004, 4200].includes(error.code!) ? 'unsupported' as const : undefined
  if (availabilityReason) return { status: 'unavailable' as const, availabilityReason, message: `Bundler estimation passed; detailed preview unavailable. ${message}` }
  return { status: 'failed' as const, failureKind: 'inconclusive' as const, message: `Execution could not be verified. Resolve this error before submitting. ${message}` }
}
