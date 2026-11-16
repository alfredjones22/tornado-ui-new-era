<script setup lang="ts">
import { computed } from 'vue'
import { formatEther } from 'viem'
import { units, type Asset } from './core/catalog'
import { actionBudget, type ActionBalances } from './core/action-budget'
const props = defineProps<{ asset: Asset; total: bigint; balances: ActionBalances; loading: boolean; fee?: bigint; ethSent?: bigint }>()
const budget = computed(() => actionBudget(props.total, props.balances, props.fee))
const nativeAvailable = computed(() => props.asset.token ? props.balances.eth : props.fee === undefined ? budget.value.beforeFee : budget.value.spendable)
</script>
<template>
  <div class="action-budget" aria-label="Contract call funding">
    <b>Funds for contract calls</b>
    <div><span>Selected withdrawals</span><span>{{ units(total, asset) }} {{ asset.symbol }}</span></div>
    <div><span>Already in smart account</span><span>{{ loading ? 'Checking…' : balances.asset === null ? 'Unavailable' : `${units(balances.asset, asset)} ${asset.symbol}` }}</span></div>
    <div><span>Maximum paymaster fee</span><span>{{ fee === undefined ? 'Calculated during review' : `${units(fee, asset)} ${asset.symbol}` }}</span></div>
    <div class="budget-net"><span>{{ fee === undefined ? 'Before paymaster fee' : 'Available before custom calls' }}</span><b>{{ budget.spendable !== null ? `${units(budget.spendable, asset)} ${asset.symbol}` : fee === undefined && budget.beforeFee !== null ? `${units(budget.beforeFee, asset)} ${asset.symbol}` : 'Not yet verified' }}</b></div>
    <div v-if="asset.token"><span>ETH for call values</span><span>{{ balances.eth === null ? 'Unavailable' : `${formatEther(balances.eth)} ETH` }}</span></div>
    <div v-if="ethSent !== undefined"><span>Total ETH values entered</span><span>{{ formatEther(ethSent) }} ETH</span></div>
    <p v-if="fee === undefined">This is not a spendable quote yet. Review calculates the fee and simulates the resulting balance.</p>
    <p v-if="nativeAvailable !== null && ethSent !== undefined && ethSent > nativeAvailable" class="budget-warning">Entered ETH values exceed the initial ETH available. Earlier calls would need to receive ETH for this sequence to work. Final simulation checks whether it is funded.</p>
    <p v-if="!loading && (balances.asset === null || asset.token && balances.eth === null)">A current balance could not be read; it has not been assumed to be zero. Final simulation checks actual funding.</p>
    <p>Later gas refunds are excluded. Calls may spend or receive assets in sequence; the total ETH values alone cannot prove affordability.</p>
  </div>
</template>
