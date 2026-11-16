<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { isAddress, type Address } from 'viem'
import Icon from './Icon.vue'
import { NETWORKS, shorten, units, type ChainId } from './core/catalog'
import { publicClientFor, safeError, type ConnectionSettings } from './core/rpc'
import { loadSmartAccount, recoverSmartAccount, smartAccountBalances, UnsupportedControllerError, type SmartWithdrawalAccount } from './core/smart-account'
import type { WithdrawalWallet } from './core/wallet-signer'
import type { Progress } from './core/wallet'

const props = defineProps<{ active: boolean; wallet: WithdrawalWallet | null; chainId: ChainId; walletRevision: number; connectionKey: string; getSettings: () => ConnectionSettings }>()
const emit = defineEmits<{ back: []; connect: []; settings: []; activity: [busy: boolean, pending: boolean]; 'reject-controller': [wallet: WithdrawalWallet] }>()
const account = ref<SmartWithdrawalAccount | null>(null), funds = ref<Awaited<ReturnType<typeof smartAccountBalances>> | null>(null)
const error = ref(''), loading = ref(false), busy = ref(false), progress = ref<Progress | null>(null), frozen = ref<ConnectionSettings | null>(null)
const recipient = ref(props.wallet?.account ?? ''), recoveryRecipient = ref<Address | null>(null)
let request = 0
const pending = computed(() => Boolean(progress.value && ['awaiting-wallet', 'submitted', 'unknown'].includes(progress.value.status)))
const hasFunds = computed(() => Boolean(funds.value && (funds.value.deposit > 0n || funds.value.balances.some(row => row.amount > 0n))))
const recipientError = computed(() => !isAddress(recipient.value) || BigInt(recipient.value) === 0n
  ? 'Enter a valid nonzero recipient address.'
  : account.value?.address.toLowerCase() === recipient.value.toLowerCase() ? 'Choose an address other than this smart account.' : '')
watch(() => props.wallet?.account, (owner, previous) => {
  if (!recipient.value || recipient.value.toLowerCase() === previous?.toLowerCase()) recipient.value = owner ?? ''
})
const update = (_id: string, patch: Partial<Progress>) => { if (progress.value) Object.assign(progress.value, patch) }
watch([busy, pending], () => emit('activity', busy.value, pending.value), { immediate: true })
async function refresh() {
  const current = ++request, wallet = props.wallet
  if (!wallet) { account.value = null; funds.value = null; return }
  loading.value = true; error.value = ''
  try {
    const settings = props.getSettings(), next = await loadSmartAccount(wallet.account, settings)
    const balances = await smartAccountBalances(next, settings)
    if (current === request) { account.value = next; funds.value = balances }
  } catch (e) { if (current === request) {
    account.value = null; funds.value = null; error.value = safeError(e)
    if (props.active && e instanceof UnsupportedControllerError) emit('reject-controller', wallet)
  } }
  finally { if (current === request) loading.value = false }
}
watch([() => props.active, () => props.wallet?.provider, () => props.wallet?.account?.toLowerCase(), () => props.walletRevision, () => props.connectionKey], () => {
  request++
  if (props.active) void refresh()
}, { immediate: true })
async function recover() {
  if (busy.value || pending.value || !props.wallet || recipientError.value) return
  busy.value = true; error.value = ''
  try {
    frozen.value = { ...props.getSettings() }
    recoveryRecipient.value = recipient.value as Address
    progress.value = { id: 'recovery', label: 'Recover smart account funds', status: 'ready' }
    await recoverSmartAccount(props.wallet, frozen.value, update, recoveryRecipient.value); await refresh()
  }
  catch (e) { error.value = safeError(e) }
  finally { busy.value = false }
}
async function check() {
  if (busy.value || !progress.value?.hash || !frozen.value) return
  busy.value = true; error.value = ''
  try {
    const receipt = await publicClientFor(frozen.value).getTransactionReceipt({ hash: progress.value.hash })
    update('recovery', { status: receipt.status === 'success' ? 'confirmed' : 'failed', message: undefined })
    await refresh()
  } catch (e) { error.value = safeError(e) }
  finally { busy.value = false }
}
onUnmounted(() => { request++; emit('activity', false, false) })
</script>

<template>
  <section class="transaction-panel" aria-label="Manage smart account">
    <div class="multi-heading"><div><span class="pill">YOUR WALLET</span><h2>Manage smart account</h2></div><button class="text-button" :disabled="busy || pending" @click="emit('back')"><Icon name="back" :size="13" />Back</button></div>
    <div class="panel-body">
      <p class="modal-description">View retained withdrawals and gas refunds, or sweep them to an address you choose. Reconnect the same EOA to find the same smart account.</p>
      <button v-if="!wallet" class="button full" @click="emit('connect')"><Icon name="wallet" />Connect controller wallet</button>
      <div v-if="account" class="smart-account-card">
        <span>Your smart account</span><a :href="`${NETWORKS[chainId].explorer}/address/${account.address}`" target="_blank" rel="noopener noreferrer"><code>{{ account.address }}</code><Icon name="arrow" :size="12" /></a>
        <small>{{ account.deployed ? 'Deployed' : 'Not deployed — your first multi-note withdrawal deploys this account' }}.</small>
        <small>Controller: {{ account.owner }}</small>
      </div>
      <div class="field-heading amount-heading"><span>Account balances</span><button class="text-button" :disabled="busy || loading || !wallet" @click="refresh"><Icon name="refresh" :size="14" />Refresh</button></div>
      <p v-if="loading" class="input-hint" role="status">Checking smart account…</p>
      <div v-else-if="funds" class="quote-card">
        <div v-for="row in funds.balances" :key="row.asset.symbol"><span>{{ row.asset.symbol }}</span><b>{{ units(row.amount, row.asset) }}</b></div>
        <div><span>EntryPoint deposit (ETH)</span><b>{{ units(funds.deposit, { symbol: 'ETH', token: null, decimals: 18 }) }}</b></div>
      </div>
      <div class="smart-recovery">
        <div class="field-heading"><span>Recover smart account funds</span></div>
        <p class="input-hint">Sweep supported tokens, ETH and EntryPoint deposits to the recipient below. This is a regular wallet transaction; your controller EOA pays the gas. Recovery does not use the Tornado paymaster or bundler.</p>
        <p class="input-hint">If a withdrawal’s execution reverted, its sponsoring note’s proceeds may remain here while other notes stay unspent. Check the withdrawal receipt before reusing notes.</p>
        <div class="field-heading recipient-heading"><label for="recovery-recipient">Recipient address</label></div>
        <input id="recovery-recipient" v-model.trim="recipient" class="text-input address-input" :disabled="busy || pending || !wallet" placeholder="0x…" spellcheck="false" autocomplete="off" />
        <p class="input-hint">Defaults to your controller wallet. You can enter another recipient.</p>
        <p v-if="wallet && recipientError" class="field-error" role="alert">{{ recipientError }}</p>
        <button class="button full" :disabled="busy || pending || loading || !wallet || !account?.deployed || !hasFunds || Boolean(recipientError)" @click="recover">Sweep funds to address <Icon name="arrow" /></button>
      </div>
      <div v-if="busy" class="modal-status" role="status"><span class="spinner"></span>{{ progress?.status === 'awaiting-wallet' ? 'Confirm recovery in your wallet…' : 'Checking recovery transaction…' }}</div>
      <div v-if="progress" class="progress-item"><div><b>{{ progress.label }}</b><span class="progress-state" :class="progress.status">{{ progress.status }}</span></div><a v-if="progress.transactionHash" class="transaction-link" :href="`${NETWORKS[frozen!.chainId].explorer}/tx/${progress.transactionHash}`" target="_blank" rel="noopener noreferrer"><code>{{ shorten(progress.transactionHash) }}</code><Icon name="arrow" :size="12" /></a><p v-if="progress.message">{{ progress.message }}</p></div>
      <div v-if="progress && recoveryRecipient" class="recipient-review"><span>Recovery recipient</span><code>{{ recoveryRecipient }}</code></div>
      <button v-if="pending && progress?.hash" class="button full" :disabled="busy" @click="check">Check recovery transaction</button>
      <button class="text-button account-settings" :disabled="busy || pending" @click="emit('settings')">RPC settings <Icon name="settings" :size="13" /></button>
      <div v-if="error" class="error-banner" role="alert"><Icon name="info" />{{ error }}</div>
    </div>
  </section>
</template>
