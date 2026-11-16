import { TornadoPaymasterConfigs } from '@kohaku-eth/tornado-cash'
import { decodeAbiParameters, decodeFunctionData, erc20Abi, getAddress, isAddress, isHex, parseAbiParameters, slice, toHex, type Address, type Hex } from 'viem'
import { getUserOperationTypedData } from 'viem/account-abstraction'
import { noteIdentity, type BatchTypedData } from './batch-policy'
import { parseBatchNotes, poolAbi, type ParsedNote } from './notes'
import type { ConnectionSettings } from './rpc'
import { accountFactoryData, simpleAccountAbi, type SmartPayout, type SmartWithdrawalAccount } from './smart-account'
import type { Withdrawal } from './withdrawals'
import { smartWithdrawalGasLimits } from './withdrawal-gas'
import { callsHash, canonicalCalls, type ContractCall } from './transaction-builder'

export interface SmartWithdrawalScope { account: SmartWithdrawalAccount; payout: SmartPayout; recipient?: Address; calls?: ContractCall[]; callsHash?: Hex }
export function reviewedCalls(scope: SmartWithdrawalScope) {
  const calls = canonicalCalls(scope.calls ?? [], scope.account.address)
  if (calls.length && scope.payout !== 'account') throw new Error('Custom actions require Keep in smart account. Remove them to use forwarding.')
  if (scope.callsHash !== undefined && scope.callsHash !== callsHash(calls)) throw new Error('The reviewed action list changed.')
  if (calls.length && !scope.callsHash) throw new Error('Missing reviewed action hash.')
  return calls
}
export function smartRecipient({ account, payout, recipient }: SmartWithdrawalScope): Address {
  if (payout === 'wallet') return account.owner
  if (payout === 'account') return account.address
  if (payout !== 'custom' || !recipient || !isAddress(recipient) || BigInt(recipient) === 0n) throw new Error('Enter a valid nonzero recipient address.')
  return getAddress(recipient)
}
type Payload = Pick<Withdrawal['userOperation'], 'sender' | 'nonce' | 'callData' | 'callGasLimit' | 'paymaster' | 'paymasterData'>

function inspect(notes: ParsedNote[], scope: SmartWithdrawalScope, op: Payload, settings: ConnectionSettings) {
  notes = parseBatchNotes(notes.map(note => note.raw).join('\n'), settings.chainId, 1)
  const actions = reviewedCalls(scope)
  const { account } = scope, cfg = TornadoPaymasterConfigs[settings.chainId], recipient = smartRecipient(scope)
  // Omitted tails mean a direct one-note payout, even with a smart-account
  // sender. Its proof recipient also receives the paymaster's postOp refund.
  const direct = notes.length === 1 && actions.length === 0
  const sponsorRecipient = direct ? recipient : account.address
  const forwards = !direct && recipient.toLowerCase() !== account.address.toLowerCase()
  if (op.sender.toLowerCase() !== account.address.toLowerCase() || BigInt(op.nonce) !== account.nonce) throw new Error('Unexpected smart account or EntryPoint nonce.')
  if (op.paymaster?.toLowerCase() !== cfg.paymasterAddress.toLowerCase() || !op.paymasterData) throw new Error('Unexpected batch paymaster.')
  const [data] = decodeAbiParameters(parseAbiParameters('(address instance, bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, uint256 fee)'), op.paymasterData)
  const expected = new Map(notes.map(note => [noteIdentity(note).nullifierHash.toString(), note]))
  const sponsor = expected.get(BigInt(data.nullifierHash).toString())
  if (!sponsor || data.instance.toLowerCase() !== sponsor.pool.address.toLowerCase() || data.fee <= 0n || data.fee >= sponsor.pool.amount ||
    data.recipient.toLowerCase() !== sponsorRecipient.toLowerCase()) throw new Error('The sponsoring proof does not match the notes and reviewed recipient.')
  expected.delete(BigInt(data.nullifierHash).toString())
  const total = notes.reduce((sum, note) => sum + note.pool.amount, 0n), net = total - data.fee
  if (direct && (op.callData !== '0x' || BigInt(op.callGasLimit) !== 0n)) throw new Error('A direct single-note withdrawal must have empty calldata and zero execution gas.')
  const decoded = op.callData === '0x' ? undefined : decodeFunctionData({ abi: simpleAccountAbi, data: op.callData })
  if (decoded && decoded.functionName !== 'executeBatch' && decoded.functionName !== 'execute') throw new Error('Unexpected smart account execution method.')
  const calls = !decoded ? [] : decoded.functionName === 'executeBatch' ? [...decoded.args[0]] : [{ target: decoded.args[0], value: decoded.args[1], data: decoded.args[2] }]
  if (calls.length !== notes.length - 1 + (forwards ? 1 : actions.length)) throw new Error('Unexpected number of withdrawal, forwarding or custom calls.')
  if (calls.length && BigInt(op.callGasLimit) <= 0n) throw new Error('Withdrawal and custom calls require execution gas.')
  // The suffix is frozen before proving. Never grant permission for arbitrary
  // extra calls: check every target, value, byte and position at every signature.
  if (actions.length) {
    const suffix = calls.splice(notes.length - 1)
    if (suffix.some((call, i) => call.target.toLowerCase() !== actions[i]!.to.toLowerCase() || call.value !== actions[i]!.value || call.data.toLowerCase() !== actions[i]!.data)) throw new Error('Custom calls differ from the reviewed ordered action list.')
  }
  if (forwards) {
    const forward = calls.pop()!, token = notes[0]!.pool.asset.token
    if (token) {
      const transfer = decodeFunctionData({ abi: erc20Abi, data: forward.data })
      if (transfer.functionName !== 'transfer' || forward.target.toLowerCase() !== token.toLowerCase() || forward.value !== 0n ||
        transfer.args[0].toLowerCase() !== recipient.toLowerCase() || transfer.args[1] !== net) throw new Error('The token forwarding call differs from the reviewed payout.')
    } else if (forward.target.toLowerCase() !== recipient.toLowerCase() || forward.value !== net || forward.data !== '0x') throw new Error('The ETH forwarding call differs from the reviewed payout.')
  }
  for (const call of calls) {
    const direct = decodeFunctionData({ abi: poolAbi, data: call.data })
    if (direct.functionName !== 'withdraw') throw new Error('Unexpected smart account call.')
    const [, , nullifier, to, relayer, fee, refund] = direct.args
    const note = expected.get(BigInt(nullifier).toString())
    if (!note || call.target.toLowerCase() !== note.pool.address.toLowerCase() || call.value !== 0n || to.toLowerCase() !== account.address.toLowerCase() ||
      BigInt(relayer) !== 0n || fee !== 0n || refund !== 0n) throw new Error('A withdrawal does not match the selected notes and smart account.')
    expected.delete(BigInt(nullifier).toString())
  }
  if (expected.size) throw new Error('The batch is missing a selected note.')
  return { data, sponsor, fee: data.fee, net }
}

export function validateSmartWithdrawal(notes: ParsedNote[], scope: SmartWithdrawalScope, withdrawal: Withdrawal, settings: ConnectionSettings) {
  const cfg = TornadoPaymasterConfigs[settings.chainId], op = withdrawal.userOperation, { account } = scope
  if (withdrawal.mode !== 'paymaster' || withdrawal.bundlerUrl !== settings.bundlerUrl || withdrawal.entryPointAddress.toLowerCase() !== cfg.entryPointAddress.toLowerCase()) throw new Error('Unexpected batch transport.')
  if (op.eip7702Auth) throw new Error('Smart account withdrawals must not request an EIP-7702 authorization.')
  if (account.deployed ? op.factory !== undefined || op.factoryData !== undefined
    : op.factory?.toLowerCase() !== account.factory.toLowerCase() || op.factoryData?.toLowerCase() !== accountFactoryData(account).toLowerCase()) throw new Error('Unexpected smart account deployment data.')
  if (withdrawal.gasEstimation?.status !== 'estimated') throw new Error('Smart account withdrawals require successful bundler estimation.')
  if (withdrawal.withdrawnValue !== notes.reduce((sum, note) => sum + note.pool.amount, 0n) || withdrawal.isERC20 !== Boolean(notes[0]!.pool.asset.token)) throw new Error('The batch does not spend the full selected notes.')
  const { data, sponsor, fee, net } = inspect(notes, scope, op, settings)
  if (withdrawal.poolAddress !== BigInt(sponsor.pool.address) || data.proof !== withdrawal.proof.proof || data.root !== withdrawal.proof.args[0] ||
    data.nullifierHash !== withdrawal.proof.args[1] || BigInt(withdrawal.proof.args[2]) !== BigInt(data.recipient) ||
    BigInt(withdrawal.proof.args[3]) !== BigInt(cfg.paymasterAddress) || BigInt(withdrawal.proof.args[4]) !== fee || BigInt(withdrawal.proof.args[5]) !== 0n) throw new Error('The sponsoring proof differs from its paymaster data.')
  return { fee, net }
}

/** Check every signed candidate before it reaches the wallet, including factory,
 * owner, nonce, exact selected notes, fee and final forwarding destination. */
export function validateSmartSigningRequest(value: unknown, notes: ParsedNote[], scope: SmartWithdrawalScope, settings: ConnectionSettings) {
  const typed = value as BatchTypedData, { account } = scope
  const canonical = getUserOperationTypedData({ chainId: settings.chainId, entryPointAddress: TornadoPaymasterConfigs[settings.chainId].entryPointAddress,
    userOperation: { sender: account.address, nonce: account.nonce, callData: '0x', callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
      maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: '0x' } })
  if (!typed || typed.primaryType !== canonical.primaryType || JSON.stringify(typed.types) !== JSON.stringify(canonical.types) ||
    typed.domain?.name !== canonical.domain!.name || typed.domain?.version !== canonical.domain!.version ||
    Number(typed.domain?.chainId) !== settings.chainId || typed.domain?.verifyingContract?.toLowerCase() !== canonical.domain!.verifyingContract!.toLowerCase() ||
    Object.keys(typed.domain).some(key => !['name', 'version', 'chainId', 'verifyingContract'].includes(key))) throw new Error('Unexpected smart account signing domain or schema.')
  const p = typed.message, initCode = account.deployed ? '0x' : `${account.factory}${accountFactoryData(account).slice(2)}`
  const fixed = (data: unknown, bytes: number): data is Hex => isHex(data, { strict: true }) && (data as string).length === 2 + bytes * 2
  if (!p || typeof p.initCode !== 'string' || p.initCode.toLowerCase() !== initCode.toLowerCase() || !fixed(p.accountGasLimits, 32) || !fixed(p.gasFees, 32) ||
    !isHex(p.callData, { strict: true }) || !isHex(p.paymasterAndData, { strict: true }) || p.paymasterAndData.length < 106 || BigInt(p.preVerificationGas) < 0n) throw new Error('Unexpected smart account signing payload.')
  const op = { sender: p.sender, nonce: toHex(BigInt(p.nonce)), callData: p.callData, callGasLimit: slice(p.accountGasLimits, 16), paymaster: slice(p.paymasterAndData, 0, 20), paymasterData: slice(p.paymasterAndData, 52) }
  const { fee, net } = inspect(notes, scope, op, settings)
  if (BigInt(slice(p.gasFees, 0, 16)) > BigInt(slice(p.gasFees, 16))) throw new Error('Invalid batch gas prices.')
  const gas = BigInt(slice(p.accountGasLimits, 0, 16)) + BigInt(slice(p.accountGasLimits, 16)) + BigInt(p.preVerificationGas) +
    BigInt(slice(p.paymasterAndData, 20, 36)) + BigInt(slice(p.paymasterAndData, 36, 52))
  const caps = smartWithdrawalGasLimits(account.deployed)
  if (BigInt(slice(p.accountGasLimits, 0, 16)) > caps.verificationGasLimit || BigInt(slice(p.accountGasLimits, 16)) > caps.callGasLimit ||
    BigInt(slice(p.paymasterAndData, 20, 36)) > caps.paymasterVerificationGasLimit) throw new Error('The smart account gas limits exceed this flow’s safety ceilings.')
  return { typedData: { ...canonical, message: typed.message }, fee, net, maxGasCost: gas * BigInt(slice(p.gasFees, 16)) }
}
