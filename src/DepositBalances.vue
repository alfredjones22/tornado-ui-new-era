<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { erc20Abi, formatUnits, type Address } from 'viem'
import Icon from './Icon.vue'
import { NETWORKS, shorten, type Asset } from './core/catalog'
import { publicClientFor, type ConnectionSettings } from './core/rpc'

const props = withDefaults(defineProps<{
  account: Address | null; walletRevision: number; asset: Asset; total: bigint
  settings: Pick<ConnectionSettings, 'chainId' | 'rpcUrl'>; active: boolean; disabled?: boolean; review?: boolean
}>(), { disabled: false, review: false })
defineEmits<{ connect: [] }>()
const ethBalance = ref<bigint | null>(null), tokenBalance = ref<bigint | null>(null)
const loading = ref(false), checked = ref(false)
let request = 0
let timer: ReturnType<typeof setInterval> | undefined
const selectedBalance = computed(() => props.asset.token ? tokenBalance.value : ethBalance.value)
const warnings = computed(() => {
  if (!props.account || !checked.value) return []
  const messages: string[] = []
  if (props.total > 0n && selectedBalance.value !== null && props.total > selectedBalance.value) {
    messages.push(`Your selection exceeds this wallet’s ${props.asset.symbol} balance by ${formatUnits(props.total - selectedBalance.value, props.asset.decimals)} ${props.asset.symbol}.`)
  }
  if (ethBalance.value === 0n) messages.push('This wallet needs ETH to pay network fees.')
  else if (!props.asset.token && props.total > 0n && ethBalance.value === props.total) messages.push('This selection leaves no ETH for network fees.')
  return messages
})
const unavailable = computed(() => !props.account || !checked.value ? [] : [
  ...(ethBalance.value === null ? ['ETH'] : []),
  ...(props.asset.token && tokenBalance.value === null ? [props.asset.symbol] : []),
])
function display(value: bigint | null, decimals: number) {
  if (value === null) return '—'
  const exact = formatUnits(value, decimals), [whole, fraction = ''] = exact.split('.')
  const short = fraction.slice(0, 6).replace(/0+$/, '')
  if (value > 0n && whole === '0' && !short) return '<0.000001'
  return short ? `${whole}.${short}` : whole
}
async function refresh(reset = false) {
  if (loading.value && !reset || props.disabled && !reset) return
  const current = ++request, account = props.account, settings = { ...props.settings }, token = props.asset.token
  if (reset) { ethBalance.value = null; tokenBalance.value = null; checked.value = false }
  loading.value = false
  if (!props.active || !account) return
  loading.value = true
  try {
    const client = publicClientFor(settings)
    if (await client.getChainId() !== settings.chainId) throw new Error('Balance RPC is on another network.')
    const [native, asset] = await Promise.allSettled([
      client.getBalance({ address: account }),
      token ? client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] }) : Promise.resolve(null),
    ])
    if (request !== current) return
    ethBalance.value = native.status === 'fulfilled' ? native.value : null
    tokenBalance.value = asset.status === 'fulfilled' ? asset.value : null
  } catch {
    if (request === current) { ethBalance.value = null; tokenBalance.value = null }
  } finally {
    if (request === current) { loading.value = false; checked.value = true }
  }
}
watch([() => props.account, () => props.walletRevision, () => props.asset.token, () => props.settings.chainId,
  () => props.settings.rpcUrl], () => { void refresh(true) }, { immediate: true })
watch(() => props.active, active => {
  if (active) void refresh()
  else { request++; loading.value = false }
})
const refreshVisible = () => {
  if (document.visibilityState === 'visible' && props.active) void refresh()
}
onMounted(() => {
  timer = setInterval(refreshVisible, 30_000)
  window.addEventListener('focus', refreshVisible)
  document.addEventListener('visibilitychange', refreshVisible)
})
onUnmounted(() => {
  request++; clearInterval(timer)
  window.removeEventListener('focus', refreshVisible)
  document.removeEventListener('visibilitychange', refreshVisible)
})
</script>

<template>
  <section class="deposit-balances" :aria-label="review ? 'Paying wallet balances' : 'Deposit wallet balances'">
    <div class="balance-heading">
      <span><span v-if="review" class="checkout-step-number" aria-hidden="true">2</span><Icon v-else name="wallet" :size="15" />{{ review ? 'Paying wallet' : 'Wallet balance' }}<small>{{ NETWORKS[settings.chainId].name }}</small></span>
      <div class="balance-actions">
        <button v-if="account" class="icon-button" aria-label="Refresh wallet balances" title="Refresh balances" :disabled="disabled || loading" @click="refresh()"><Icon name="refresh" :size="14" /></button>
        <button class="text-button" :disabled="disabled" @click="$emit('connect')">{{ account ? 'Change wallet' : 'Connect wallet' }}</button>
      </div>
    </div>
    <template v-if="account">
      <code class="balance-account" :title="account">{{ shorten(account) }}</code>
      <div class="deposit-balance-values" aria-live="polite" :aria-busy="loading">
        <div><span>ETH<small>{{ asset.token ? 'for gas' : 'available' }}</small></span><b :title="ethBalance === null ? undefined : `${formatUnits(ethBalance, 18)} ETH`">{{ display(ethBalance, 18) }} <small>ETH</small></b></div>
        <div v-if="asset.token"><span>{{ asset.symbol }}<small>available</small></span><b :title="tokenBalance === null ? undefined : `${formatUnits(tokenBalance, asset.decimals)} ${asset.symbol}`">{{ display(tokenBalance, asset.decimals) }} <small>{{ asset.symbol }}</small></b></div>
      </div>
      <p v-if="loading" class="balance-hint" role="status">Updating balances…</p>
      <p v-else-if="unavailable.length" class="balance-hint" role="status">{{ unavailable.join(' and ') }} balance unavailable. Refresh to try again.</p>
      <p v-else class="balance-hint">Leave ETH for gas. Final fees are shown in your wallet.</p>
      <p v-for="message in warnings" :key="message" class="balance-warning" role="status"><Icon name="info" :size="14" /><span>{{ message }}</span></p>
    </template>
    <p v-else class="balance-hint">Connect a wallet to see your ETH{{ asset.token ? ` and ${asset.symbol}` : '' }} balance before depositing.</p>
    <p v-if="review" class="balance-hint balance-switch-hint">Changing the paying wallet keeps your saved notes.</p>
  </section>
</template>
