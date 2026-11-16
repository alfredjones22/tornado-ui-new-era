import { encodeAbiParameters, encodeFunctionData, hashTypedData, parseAbiParameters, toHex, type Address } from 'viem'
import { batchTypedData, noteIdentity } from '../../src/core/batch-policy'
import { poolAbi } from '../../src/core/notes'
import { accountFactoryData, SIMPLE_ACCOUNT_FACTORY, simpleAccountAbi, WITHDRAWAL_ACCOUNT_SALT, type SmartPayout } from '../../src/core/smart-account'
import type { SmartWithdrawalQuote } from '../../src/core/smart-withdrawal'
import type { WalletProvider } from '../../src/core/wallet'
import { fixture, recipient, settings, signingAccount } from './multi-withdrawal'
import { smartRecipient } from '../../src/core/smart-withdrawal-policy'

export function smartFixture(count = 2, symbol = 'eth', payout: SmartPayout = 'wallet', deployed = false, customRecipient: Address = '0x4444444444444444444444444444444444444444') {
  const old = fixture(count, symbol), notes = old.quote.notes, withdrawal = old.withdrawal
  const account = { owner: recipient, address: '0x3333333333333333333333333333333333333333' as const,
    factory: SIMPLE_ACCOUNT_FACTORY, salt: WITHDRAWAL_ACCOUNT_SALT, nonce: deployed ? 7n : 0n, deployed }
  const scope = { account, payout, ...(payout === 'custom' ? { recipient: customRecipient } : {}) }, destination = smartRecipient(scope)
  const sponsorRecipient = count === 1 ? destination : account.address
  const { userOperation: op, proof } = withdrawal
  delete op.eip7702Auth
  op.sender = account.address; op.nonce = toHex(account.nonce)
  op.verificationGasLimit = toHex(deployed ? 150_000n : 500_000n)
  if (!deployed) { op.factory = account.factory; op.factoryData = accountFactoryData(account) }
  proof.args[2] = sponsorRecipient
  op.paymasterData = encodeAbiParameters(parseAbiParameters('(address instance, bytes proof, bytes32 root, bytes32 nullifierHash, address recipient, uint256 fee)'), [{
    instance: notes[0]!.pool.address, proof: proof.proof, root: proof.args[0], nullifierHash: proof.args[1], recipient: sponsorRecipient, fee: old.quote.fee,
  }])
  const calls = notes.slice(1).map(note => ({ target: note.pool.address, value: 0n, data: encodeFunctionData({ abi: poolAbi, functionName: 'withdraw',
    args: [proof.proof, proof.args[0], toHex(noteIdentity(note).nullifierHash, { size: 32 }), account.address, '0x0000000000000000000000000000000000000000', 0n, 0n] }) }))
  if (count > 1 && destination.toLowerCase() !== account.address.toLowerCase()) {
    const token = notes[0]!.pool.asset.token
    calls.push(token ? { target: token, value: 0n, data: encodeFunctionData({ abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }], functionName: 'transfer', args: [destination, old.quote.net] }) }
      : { target: destination, value: old.quote.net, data: '0x' })
  }
  op.callData = calls.length ? encodeFunctionData({ abi: simpleAccountAbi, functionName: 'executeBatch', args: [calls] }) : '0x'
  if (count === 1) op.callGasLimit = '0x0'
  const quote: SmartWithdrawalQuote = { id: 'smart-batch', notes, scope, withdrawal, fee: old.quote.fee, net: old.quote.net,
    quotedAt: Date.now(), signedHash: hashTypedData(batchTypedData(withdrawal, settings)) }
  return { quote, scope, calls }
}

export function typedDataWallet(key = signingAccount) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const provider: WalletProvider = {
    request: async ({ method, params }) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_accounts') return [recipient]
      if (method === 'wallet_switchEthereumChain') return null
      if (method === 'eth_signTypedData_v4') return key.signTypedData(JSON.parse((params as string[])[1]!))
      throw new Error(`Unexpected wallet method ${method}`)
    },
    on: (event, listener) => { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set) },
    removeListener: (event, listener) => { listeners.get(event)?.delete(listener) },
  }
  return { provider, listeners, account: recipient }
}
