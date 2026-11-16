import { encodeAbiParameters, encodeFunctionData, formatEther, getAddress, isAddress, keccak256, parseAbiParameters, parseEther, toFunctionSignature, type Abi, type AbiFunction, type AbiParameter, type Address, type Hex } from 'viem'

export const MAX_ACTIONS = 12
export const MAX_ABI_BYTES = 128_000
export const MAX_IMPORT_BYTES = 512_000
const MAX_CALL_BYTES = 16_384, MAX_TOTAL_BYTES = 65_536
export interface ContractCall { to: Address; value: bigint; data: Hex }
export interface BuilderAction extends ContractCall { label?: string }
const uint256 = (value: bigint) => { if (value < 0n || value >= 2n ** 256n) throw new Error('Value must be a uint256.'); return value }
export function ethValue(text: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(text)) throw new Error('Enter an ETH amount with up to 18 decimal places.')
  return uint256(parseEther(text))
}
export function canonicalCalls(input: readonly ContractCall[], account?: Address): ContractCall[] {
  if (!Array.isArray(input) || input.length > MAX_ACTIONS) throw new Error(`Use up to ${MAX_ACTIONS} custom actions.`)
  let size = 0
  return input.map(call => {
    if (!call || typeof call.to !== 'string' || !isAddress(call.to) || BigInt(call.to) === 0n) throw new Error('Enter a valid nonzero target address.')
    if (account && call.to.toLowerCase() === account.toLowerCase()) throw new Error('Calls to the smart account itself are disabled to protect account recovery.')
    if (typeof call.value !== 'bigint') throw new Error('Action value must be an integer amount of wei.')
    uint256(call.value)
    if (typeof call.data !== 'string' || !/^0x(?:[\da-fA-F]{2})*$/.test(call.data)) throw new Error('Data must be even-length hex starting with 0x.')
    const bytes = (call.data.length - 2) / 2
    size += bytes
    if (bytes > MAX_CALL_BYTES || size > MAX_TOTAL_BYTES) throw new Error('Action data is too large (16 KiB per action, 64 KiB total).')
    return { to: getAddress(call.to), value: call.value, data: call.data.toLowerCase() as Hex }
  })
}
export function callsHash(calls: readonly ContractCall[]): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters('(address to,uint256 value,bytes data)[]'), [canonicalCalls(calls)]))
}
export function parseContractAbi(text: string): AbiFunction[] {
  if (text.length > MAX_ABI_BYTES) throw new Error('Choose an ABI up to 128 KB.')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('Paste a JSON ABI array or an artifact containing an abi array.') }
  if (value && typeof value === 'object' && !Array.isArray(value)) value = (value as { abi?: unknown }).abi
  if (!Array.isArray(value)) throw new Error('The ABI must contain an array.')
  const functions = value.filter(item => item?.type === 'function' && ['payable', 'nonpayable'].includes(item.stateMutability)) as AbiFunction[]
  if (!functions.length || functions.length > 256) throw new Error('The ABI must have 1–256 writable functions.')
  try { for (const fn of functions) { toFunctionSignature(fn); if (!Array.isArray(fn.inputs)) throw new Error() } }
  catch { throw new Error('Invalid function ABI.') }
  return functions
}

/** Complex inputs use JSON arrays/objects; integers remain strings to avoid JS rounding. */
function argument(parameter: AbiParameter, value: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error('ABI arguments are nested too deeply.')
  const type = parameter.type, array = /^(.*)\[(\d*)\]$/.exec(type)
  if (array || type === 'tuple') {
    if (typeof value === 'string') { try { value = JSON.parse(value) } catch { throw new Error('Use JSON for tuples and arrays; quote large integers.') } }
    if (array) {
      if (!Array.isArray(value) || value.length > 1024 || array[2] && value.length !== Number(array[2])) throw new Error('Invalid ABI array length.')
      return value.map(v => argument({ ...parameter, type: array[1]! } as AbiParameter, v, depth + 1))
    }
    const components = (parameter as AbiParameter & { components: readonly AbiParameter[] }).components
    if (!Array.isArray(value) && (!value || typeof value !== 'object')) throw new Error('Use a JSON array or object for a tuple.')
    return components.map((p, i) => argument(p, Array.isArray(value) ? value[i] : (value as Record<string, unknown>)[p.name!], depth + 1))
  }
  if (/^u?int\d*$/.test(type)) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Quote large integers to preserve their exact value.')
    if (!/^-?\d+$/.test(String(value))) throw new Error('Enter an integer in base units.')
    return BigInt(String(value))
  }
  if (type === 'bool') { if (value === true || value === 'true') return true; if (value === false || value === 'false') return false; throw new Error('Use true or false.') }
  return value
}
export function encodeBuilderCall(to: string, value: bigint, fn: AbiFunction, inputs: readonly unknown[], account?: Address): BuilderAction {
  if (inputs.length !== fn.inputs.length) throw new Error('Fill in every function argument.')
  if (value !== 0n && fn.stateMutability !== 'payable') throw new Error('This function does not accept ETH.')
  const data = encodeFunctionData({ abi: [fn] as Abi, functionName: fn.name, args: fn.inputs.map((p, i) => argument(p, inputs[i])) })
  return { ...canonicalCalls([{ to: to as Address, value, data }], account)[0]!, label: toFunctionSignature(fn) }
}
export function importSafeBatch(text: string, chainId: number, account?: Address): BuilderAction[] {
  if (text.length > MAX_IMPORT_BYTES) throw new Error('Choose a batch JSON up to 512 KB.')
  const batch = JSON.parse(text)
  if (batch?.version !== '1.0' || String(batch.chainId) !== String(chainId) || !Array.isArray(batch.transactions)) throw new Error('Choose a Safe batch v1.0 for the selected network.')
  const actions: BuilderAction[] = batch.transactions.map((tx: Record<string, unknown>) => {
    if (!tx || typeof tx !== 'object' || tx.operation !== undefined && tx.operation !== 0 && tx.operation !== '0') throw new Error('Only ordinary CALL actions are supported; delegatecall is disabled.')
    if (typeof tx.value !== 'string' || !/^\d+$/.test(tx.value)) throw new Error('Imported values must be integer strings in wei.')
    let action: BuilderAction | undefined
    if (tx.contractMethod) {
      const method = tx.contractMethod as { name?: string; inputs?: AbiParameter[]; payable?: boolean }
      if (!method.name || !Array.isArray(method.inputs)) throw new Error('Invalid imported contract method.')
      const fn: AbiFunction = { type: 'function', name: method.name, inputs: method.inputs, outputs: [], stateMutability: method.payable ? 'payable' : 'nonpayable' }
      const values = tx.contractInputsValues as Record<string, unknown> | undefined
      action = encodeBuilderCall(tx.to as string, BigInt(tx.value), fn, method.inputs.map(p => values?.[p.name ?? '']), account)
      if (tx.data !== null && tx.data !== undefined && (typeof tx.data !== 'string' || tx.data.toLowerCase() !== action.data)) throw new Error('Imported ABI arguments and calldata disagree.')
    } else {
      if (typeof tx.data !== 'string') throw new Error('Every imported action needs calldata or a contract method.')
      action = canonicalCalls([{ to: tx.to as Address, value: BigInt(tx.value), data: tx.data as Hex }], account)[0]!
    }
    return action
  })
  if (!actions.length) throw new Error('This batch has no actions.')
  canonicalCalls(actions, account)
  return actions
}
export function exportSafeBatch(actions: readonly BuilderAction[], chainId: number): string {
  // Export only reviewed public calls. Never include notes, proofs, or signatures.
  return JSON.stringify({ version: '1.0', chainId: String(chainId), createdAt: Date.now(), meta: { name: 'Tornado custom actions', description: 'Executed by the smart account after withdrawals.' },
    transactions: canonicalCalls(actions).map(call => ({ to: call.to, value: call.value.toString(), data: call.data, contractMethod: null, contractInputsValues: null })) }, null, 2)
}
export const callSummary = (call: BuilderAction) => call.label ?? (call.data === '0x' ? 'Send ETH' : `Custom data ${call.data.slice(0, 10)}`)
export const callEth = (call: ContractCall) => formatEther(call.value)
