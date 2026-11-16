import { erc20Abi, type Address } from 'viem'
import type { Asset } from './catalog'
import { publicClientFor, type ConnectionSettings } from './rpc'

export interface ActionBalances { eth: bigint | null; asset: bigint | null; block?: bigint }
export const unknownActionBalances = (): ActionBalances => ({ eth: null, asset: null })
/** Pin both balances to one block. Unavailable is not zero, including for a
 * counterfactual account that may already have been sent assets. */
export async function loadActionBalances(address: Address, asset: Asset, settings: ConnectionSettings): Promise<ActionBalances> {
  const client = publicClientFor(settings), block = await client.getBlockNumber()
  const [eth, token] = await Promise.allSettled([
    client.getBalance({ address, blockNumber: block }),
    asset.token ? client.readContract({ address: asset.token, abi: erc20Abi, functionName: 'balanceOf', args: [address], blockNumber: block }) : Promise.resolve(null),
  ])
  const native = eth.status === 'fulfilled' ? eth.value : null
  return { eth: native, asset: asset.token ? token.status === 'fulfilled' ? token.value : null : native, block }
}
export function actionBudget(total: bigint, balances: ActionBalances, fee?: bigint) {
  return { beforeFee: balances.asset === null ? null : total + balances.asset,
    spendable: fee === undefined || balances.asset === null ? null : total + balances.asset - fee }
}
