import { TornadoPaymasterConfigs } from '@kohaku-eth/tornado-cash'
import { encodeFunctionData, erc20Abi, getAddress, isAddress, keccak256, parseAbi, stringToHex, toHex, type Address, type Hex } from 'viem'
import { assetsFor, type Asset } from './catalog'
import { publicClientFor, validateConnections, type ConnectionSettings } from './rpc'
import { assertWithdrawalWallet, type WithdrawalWallet } from './wallet-signer'
import { isHash, type Update } from './wallet'

// eth-infinitism/account-abstraction v0.8.0 (4cbc060), verified on both supported chains.
export const SIMPLE_ACCOUNT_FACTORY = '0x13E9ed32155810FDbd067D4522C492D6f68E5944' as Address
const FACTORY_HASH = '0xa2e635152a61e180383c7afc045620b7461ef6f43ba27d592262513106b991b7'
const IMPLEMENTATION_HASH = '0x689a90eff03926a12aedad2fc6d4fdbcbdd9ffac86e7d0d70ce6355961305c74'
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
// Stable per owner/network: reconnecting the same wallet rediscovers its account.
export const WITHDRAWAL_ACCOUNT_SALT = BigInt(keccak256(stringToHex('tornado-ui-new-era:withdrawal-account:v1')))
export const simpleAccountAbi = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
  'function owner() view returns (address)',
  'function entryPoint() view returns (address)',
  'function withdrawDepositTo(address withdrawAddress, uint256 amount)',
])
const factoryAbi = parseAbi([
  'function accountImplementation() view returns (address)',
  'function getAddress(address owner, uint256 salt) view returns (address)',
  'function createAccount(address owner, uint256 salt) returns (address)',
])
const entryPointAbi = parseAbi([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
])
export interface SmartWithdrawalAccount {
  owner: Address; address: Address; factory: Address; salt: bigint; nonce: bigint; deployed: boolean
}
export type SmartPayout = 'wallet' | 'account' | 'custom'
export const accountFactoryData = (account: SmartWithdrawalAccount) => encodeFunctionData({ abi: factoryAbi,
  functionName: 'createAccount', args: [account.owner, account.salt] })

export class UnsupportedControllerError extends Error {
  constructor() { super('Select an EOA controller that can sign typed data. Contract-wallet owner signatures are not supported.') }
}

/** Only the pinned v0.8 factory/implementation; never accept an arbitrary account. */
export async function loadSmartAccount(owner: Address, settings: ConnectionSettings): Promise<SmartWithdrawalAccount> {
  await validateConnections(settings, false)
  const client = publicClientFor(settings), entryPoint = TornadoPaymasterConfigs[settings.chainId].entryPointAddress
  const factory = SIMPLE_ACCOUNT_FACTORY
  const [factoryCode, implementation, address, ownerCode] = await Promise.all([
    client.getCode({ address: factory }),
    client.readContract({ address: factory, abi: factoryAbi, functionName: 'accountImplementation' }),
    client.readContract({ address: factory, abi: factoryAbi, functionName: 'getAddress', args: [owner, WITHDRAWAL_ACCOUNT_SALT] }),
    client.getCode({ address: owner }),
  ])
  if (!factoryCode || keccak256(factoryCode) !== FACTORY_HASH) throw new Error('The expected SimpleAccount v0.8 factory is unavailable on this network.')
  if (ownerCode && ownerCode !== '0x' && !/^0xef0100[0-9a-f]{40}$/i.test(ownerCode)) throw new UnsupportedControllerError()
  const [implementationCode, implementationEntryPoint, code, nonce] = await Promise.all([
    client.getCode({ address: implementation }),
    client.readContract({ address: implementation, abi: simpleAccountAbi, functionName: 'entryPoint' }),
    client.getCode({ address }),
    client.readContract({ address: entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [address, 0n] }),
  ])
  if (!implementationCode || keccak256(implementationCode) !== IMPLEMENTATION_HASH || implementationEntryPoint.toLowerCase() !== entryPoint.toLowerCase()) throw new Error('The SimpleAccount implementation or EntryPoint does not match v0.8.')
  const deployed = Boolean(code && code !== '0x')
  if (deployed) {
    const [actualOwner, actualEntryPoint, slot] = await Promise.all([
      client.readContract({ address, abi: simpleAccountAbi, functionName: 'owner' }),
      client.readContract({ address, abi: simpleAccountAbi, functionName: 'entryPoint' }),
      client.getStorageAt({ address, slot: IMPLEMENTATION_SLOT }),
    ])
    if (actualOwner.toLowerCase() !== owner.toLowerCase() || actualEntryPoint.toLowerCase() !== entryPoint.toLowerCase() ||
      slot?.toLowerCase() !== `0x${implementation.slice(2).toLowerCase().padStart(64, '0')}`) throw new Error('This smart account has a different owner, implementation or EntryPoint.')
  }
  return { owner: getAddress(owner), address: getAddress(address), factory, salt: WITHDRAWAL_ACCOUNT_SALT, nonce, deployed }
}

export async function assertSmartAccount(account: SmartWithdrawalAccount, settings: ConnectionSettings) {
  const current = await loadSmartAccount(account.owner, settings)
  if (current.address !== account.address || current.nonce !== account.nonce || current.deployed !== account.deployed) throw new Error('The smart account changed or its nonce was used. Check existing operations before preparing another batch.')
}

export interface SmartBalance { asset: Asset; amount: bigint }
export async function smartAccountBalances(account: SmartWithdrawalAccount, settings: ConnectionSettings) {
  const client = publicClientFor(settings)
  const balances = await Promise.all(assetsFor(settings.chainId).map(async asset => ({ asset,
    amount: asset.token ? await client.readContract({ address: asset.token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
      : await client.getBalance({ address: account.address }),
  })))
  const deposit = await client.readContract({ address: TornadoPaymasterConfigs[settings.chainId].entryPointAddress, abi: entryPointAbi, functionName: 'balanceOf', args: [account.address] })
  return { balances, deposit }
}

/** Owner-paid escape hatch, independent of the bundler and Tornado paymaster.
 * Withdrawals need only typed-data signing. Recovery is a regular wallet tx;
 * its gas comes from the owner, so even token-only accounts can be emptied. */
export async function recoverSmartAccount(wallet: WithdrawalWallet, settings: ConnectionSettings, update: Update, recipient: Address = wallet.account) {
  if (!isAddress(recipient) || BigInt(recipient) === 0n) throw new Error('Enter a valid nonzero recovery recipient address.')
  const destination = getAddress(recipient)
  await assertWithdrawalWallet(wallet, settings)
  const account = await loadSmartAccount(wallet.account, settings)
  if (!account.deployed) throw new Error('This smart account has not been deployed yet.')
  if (destination === account.address) throw new Error('Choose a recovery recipient other than this smart account.')
  const { balances, deposit } = await smartAccountBalances(account, settings)
  const calls = balances.filter(row => row.amount > 0n).map(({ asset, amount }) => asset.token
    ? { target: asset.token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [destination, amount] }) }
    : { target: destination, value: amount, data: '0x' as Hex })
  if (deposit > 0n) calls.push({ target: account.address, value: 0n,
    data: encodeFunctionData({ abi: simpleAccountAbi, functionName: 'withdrawDepositTo', args: [destination, deposit] }) })
  if (!calls.length) throw new Error('There are no supported assets or EntryPoint deposits to recover.')
  const data = encodeFunctionData({ abi: simpleAccountAbi, functionName: 'executeBatch', args: [calls] })
  const client = publicClientFor(settings)
  await client.estimateGas({ account: account.owner, to: account.address, data })
  await assertWithdrawalWallet(wallet, settings)
  update('recovery', { status: 'awaiting-wallet' })
  let hash: unknown
  try {
    hash = await wallet.provider.request({ method: 'eth_sendTransaction', params: [{ from: account.owner, to: account.address, value: toHex(0n), data }] })
    if (!isHash(hash)) throw new Error('The wallet returned no recovery transaction hash. Check your wallet before retrying.')
  } catch (error) {
    update('recovery', { status: (error as { code?: number })?.code === 4001 ? 'failed' : 'unknown', message: 'Check recovery status in your wallet before retrying.' })
    throw error
  }
  if (!isHash(hash)) throw new Error('Invalid recovery transaction hash.')
  update('recovery', { status: 'submitted', hash, transactionHash: hash })
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 })
  update('recovery', { status: receipt.status === 'success' ? 'confirmed' : 'failed' })
  if (receipt.status !== 'success') throw new Error('Recovery reverted. The funds remain in your smart account.')
}
