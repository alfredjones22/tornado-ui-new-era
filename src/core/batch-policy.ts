import { TornadoPaymasterConfigs } from '@kohaku-eth/tornado-cash'
import { Point, pedersenHash } from 'micro-zk-proofs/pedersen.js'
import { decodeAbiParameters, decodeFunctionData, hexToBytes, isHex, parseAbi, parseAbiParameters, slice, toHex, type Address, type Hex } from 'viem'
import { getUserOperationTypedData } from 'viem/account-abstraction'
import { parseBatchNotes, poolAbi, type ParsedNote } from './notes'
import { publicClientFor, type ConnectionSettings } from './rpc'
import type { Withdrawal } from './withdrawals'

export const SIMPLE_7702_IMPLEMENTATION = '0xe6Cae83BdE06E4c305530e199D7217f42808555B'
export type BatchTypedData = ReturnType<typeof getUserOperationTypedData>
const executeAbi = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
])
const entryPointAbi = parseAbi(['function getNonce(address sender, uint192 key) view returns (uint256)'])
export function noteIdentity(note: ParsedNote) {
  const bytes = hexToBytes(`0x${note.preimage}`)
  return { commitment: Point.decode(pedersenHash(bytes)).x, nullifierHash: Point.decode(pedersenHash(bytes.subarray(0, 31))).x }
}

/** An unused EOA has no code/delegation and zero account and EntryPoint nonces. */
export async function checkFreshReceiver(recipient: Address, settings: Pick<ConnectionSettings, 'chainId' | 'rpcUrl'>) {
  const client = publicClientFor(settings)
  const [accountNonce, entryPointNonce, code] = await Promise.all([
    client.getTransactionCount({ address: recipient, blockTag: 'pending' }),
    client.readContract({ address: TornadoPaymasterConfigs[settings.chainId].entryPointAddress, abi: entryPointAbi, functionName: 'getNonce', args: [recipient, 0n] }),
    client.getCode({ address: recipient, blockTag: 'pending' }),
  ])
  if (code?.toLowerCase().startsWith('0xef0100')) throw new Error('This receiver wallet already has a delegation. Connect an unused EOA.')
  if (code && code !== '0x') throw new Error('This receiver is a contract wallet, not an EOA. Connect an unused EOA.')
  if (accountNonce !== 0 || entryPointNonce !== 0n) throw new Error('This receiver wallet has already been used. Connect an unused EOA.')
}

type BatchPayload = Pick<Withdrawal['userOperation'], 'sender' | 'nonce' | 'callData' | 'paymaster' | 'paymasterData'>
function inspectBatchPayload(notes: ParsedNote[], recipient: Address, op: BatchPayload, settings: ConnectionSettings) {
  notes = parseBatchNotes(notes.map(note => note.raw).join('\n'), settings.chainId)
  const cfg = TornadoPaymasterConfigs[settings.chainId]
  if (op.sender.toLowerCase() !== recipient.toLowerCase() || BigInt(op.nonce) !== 0n) throw new Error('The batch sender must be the fresh receiver EOA.')
  if (op.paymaster?.toLowerCase() !== cfg.paymasterAddress.toLowerCase() || !op.paymasterData) throw new Error('The batch paymaster does not match the review.')
  const [data] = decodeAbiParameters(parseAbiParameters('(address instance, bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, uint256 fee)'), op.paymasterData)
  const expected = new Map(notes.map(note => [noteIdentity(note).nullifierHash.toString(), note]))
  const sponsor = expected.get(BigInt(data.nullifierHash).toString())
  if (!sponsor || data.instance.toLowerCase() !== sponsor.pool.address.toLowerCase() || data.fee <= 0n || data.fee >= sponsor.pool.amount ||
    data.recipient.toLowerCase() !== recipient.toLowerCase()) throw new Error('The sponsoring proof does not match a selected note and receiver.')
  expected.delete(BigInt(data.nullifierHash).toString())
  const decoded = decodeFunctionData({ abi: executeAbi, data: op.callData })
  const calls = decoded.functionName === 'executeBatch' ? decoded.args[0] : [{ target: decoded.args[0], value: decoded.args[1], data: decoded.args[2] }]
  if (calls.length !== notes.length - 1) throw new Error('Expected only the remaining note withdrawals in the batch.')
  for (const call of calls) {
    const direct = decodeFunctionData({ abi: poolAbi, data: call.data })
    if (direct.functionName !== 'withdraw') throw new Error('Unexpected batch call.')
    const [, , nullifier, to, relayer, directFee, refund] = direct.args
    const note = expected.get(BigInt(nullifier).toString())
    if (!note || call.target.toLowerCase() !== note.pool.address.toLowerCase() || call.value !== 0n || to.toLowerCase() !== recipient.toLowerCase() ||
      BigInt(relayer) !== 0n || directFee !== 0n || refund !== 0n) throw new Error('A direct withdrawal does not match the selected notes and receiver.')
    expected.delete(BigInt(nullifier).toString())
  }
  if (expected.size) throw new Error('The batch is missing a selected note.')
  return { data, sponsor, fee: data.fee, net: notes.reduce((sum, note) => sum + note.pool.amount, 0n) - data.fee }
}

export function validateMultiWithdrawal(notes: ParsedNote[], recipient: Address, withdrawal: Withdrawal, settings: ConnectionSettings) {
  notes = parseBatchNotes(notes.map(note => note.raw).join('\n'), settings.chainId)
  const cfg = TornadoPaymasterConfigs[settings.chainId], op = withdrawal.userOperation
  if (withdrawal.mode !== 'paymaster' || withdrawal.bundlerUrl !== settings.bundlerUrl || withdrawal.entryPointAddress.toLowerCase() !== cfg.entryPointAddress.toLowerCase()) throw new Error('The batch transport does not match the review.')
  const auth = op.eip7702Auth
  if (!auth || Number(BigInt(auth.chainId)) !== settings.chainId || BigInt(auth.nonce) !== 0n || auth.address.toLowerCase() !== SIMPLE_7702_IMPLEMENTATION.toLowerCase()) throw new Error('Unexpected batch executor authorization.')
  if (withdrawal.gasEstimation?.status !== 'estimated') throw new Error('The bundler did not successfully estimate this batch.')
  if (withdrawal.withdrawnValue !== notes.reduce((sum, note) => sum + note.pool.amount, 0n) || withdrawal.isERC20 !== Boolean(notes[0]!.pool.asset.token)) throw new Error('The batch does not spend the full selected notes.')
  const { data, sponsor, fee, net } = inspectBatchPayload(notes, recipient, op, settings)
  if (withdrawal.poolAddress !== BigInt(sponsor.pool.address) || data.proof !== withdrawal.proof.proof || data.root !== withdrawal.proof.args[0] ||
    data.nullifierHash !== withdrawal.proof.args[1] || BigInt(withdrawal.proof.args[2]) !== BigInt(recipient) ||
    BigInt(withdrawal.proof.args[3]) !== BigInt(cfg.paymasterAddress) || BigInt(withdrawal.proof.args[4]) !== fee || BigInt(withdrawal.proof.args[5]) !== 0n) throw new Error('The batch paymaster data does not match its proof.')
  return { fee, net }
}

/** Rebuild the exact EIP-712 payload to bind the reviewed quote to its signature. */
export function batchTypedData(withdrawal: Withdrawal, settings: ConnectionSettings): BatchTypedData {
  const op = withdrawal.userOperation
  return getUserOperationTypedData({ chainId: settings.chainId, entryPointAddress: withdrawal.entryPointAddress,
    userOperation: { ...op, nonce: BigInt(op.nonce), callGasLimit: BigInt(op.callGasLimit), verificationGasLimit: BigInt(op.verificationGasLimit),
      preVerificationGas: BigInt(op.preVerificationGas), maxFeePerGas: BigInt(op.maxFeePerGas), maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas),
      paymasterVerificationGasLimit: BigInt(op.paymasterVerificationGasLimit ?? '0x0'), paymasterPostOpGasLimit: BigInt(op.paymasterPostOpGasLimit ?? '0x0') } })
}

/** Inspect the payload BEFORE signing. The SDK also checks scope and signatures. */
export function validateBatchSigningRequest(value: unknown, notes: ParsedNote[], recipient: Address, settings: ConnectionSettings) {
  const typed = value as BatchTypedData
  const cfg = TornadoPaymasterConfigs[settings.chainId]
  const canonical = getUserOperationTypedData({ chainId: settings.chainId, entryPointAddress: cfg.entryPointAddress,
    userOperation: { sender: recipient, nonce: 0n, callData: '0x', callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
      maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: '0x' } })
  if (!typed || typed.primaryType !== canonical.primaryType || JSON.stringify(typed.types) !== JSON.stringify(canonical.types) ||
    typed.domain?.name !== canonical.domain!.name || typed.domain?.version !== canonical.domain!.version ||
    Number(typed.domain?.chainId) !== settings.chainId || typed.domain?.verifyingContract?.toLowerCase() !== cfg.entryPointAddress.toLowerCase() ||
    Object.keys(typed.domain).some(key => !['name', 'version', 'chainId', 'verifyingContract'].includes(key))) throw new Error('Unexpected batch signing domain or schema.')
  const packed = typed.message
  const fixedHex = (data: unknown, bytes: number): data is Hex => isHex(data, { strict: true }) && (data as string).length === 2 + bytes * 2
  if (!packed || packed.sender?.toLowerCase() !== recipient.toLowerCase() || BigInt(packed.nonce) !== 0n || packed.initCode !== '0x' ||
    !fixedHex(packed.accountGasLimits, 32) || !fixedHex(packed.gasFees, 32) || !isHex(packed.paymasterAndData, { strict: true }) || packed.paymasterAndData.length < 106 ||
    !isHex(packed.callData, { strict: true }) || BigInt(packed.preVerificationGas) < 0n) throw new Error('Unexpected batch signing payload.')
  const op = { sender: packed.sender, nonce: '0x0' as Hex, callData: packed.callData,
    callGasLimit: slice(packed.accountGasLimits, 16), verificationGasLimit: slice(packed.accountGasLimits, 0, 16),
    preVerificationGas: toHex(BigInt(packed.preVerificationGas)), maxFeePerGas: slice(packed.gasFees, 16), maxPriorityFeePerGas: slice(packed.gasFees, 0, 16),
    paymaster: slice(packed.paymasterAndData, 0, 20), paymasterVerificationGasLimit: slice(packed.paymasterAndData, 20, 36),
    paymasterPostOpGasLimit: slice(packed.paymasterAndData, 36, 52), paymasterData: slice(packed.paymasterAndData, 52) }
  const { fee, net } = inspectBatchPayload(notes, recipient, op, settings)
  if (BigInt(op.maxPriorityFeePerGas) > BigInt(op.maxFeePerGas)) throw new Error('Invalid batch gas prices.')
  const gas = BigInt(op.callGasLimit) + BigInt(op.verificationGasLimit) + BigInt(op.preVerificationGas) +
    BigInt(op.paymasterVerificationGasLimit!) + BigInt(op.paymasterPostOpGasLimit!)
  return { typedData: { ...canonical, message: typed.message }, fee, net, maxGasCost: gas * BigInt(op.maxFeePerGas) }
}
