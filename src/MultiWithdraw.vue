<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { formatEther, type Address } from 'viem'
import Icon from './Icon.vue'
import { checkFreshReceiver, SIMPLE_7702_IMPLEMENTATION } from './core/batch-policy'
import { MAX_MULTI_NOTES, parseBatchNotes, downloadText, extractNoteStrings } from './core/notes'
import { prepareMultiWithdrawal, submitMultiWithdrawal, type MultiWithdrawalQuote } from './core/multi-withdrawal'
import { reconcileWithdrawal } from './core/withdrawals'
import { safeError, type ConnectionSettings } from './core/rpc'
import { units, shorten, NETWORKS, type ChainId } from './core/catalog'
import type { Progress, WalletOption } from './core/wallet'
import type { SigningReview } from './core/wallet-signer'

const props = defineProps<{ active: boolean; chainId: ChainId; settings: () => ConnectionSettings; rpcUrl: string; blocked: boolean; wallet: WalletOption | null; account: Address | null; walletChainId: number | null; walletRevision: number }>()
const emit = defineEmits<{ busy: [value: boolean]; pending: [value: boolean]; back: []; configure: []; connect: [] }>()
const input = ref('')
const receiverChecking = ref(false), receiverError = ref(''), receiverValid = ref(false)
let receiverCheck = 0
const busy = ref(false), status = ref(''), error = ref('')
const quote = ref<MultiWithdrawalQuote | null>(null)
const frozen = ref<ConnectionSettings | null>(null)
const progress = ref<Progress | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const signingReview = ref<SigningReview | null>(null), approvalPending = ref(false)
let approval: { resolve: () => void; reject: (error: Error) => void } | undefined
let controller: AbortController | undefined
const pending = computed(() => !!progress.value && ['submitted', 'unknown'].includes(progress.value.status))
watch(pending, value => emit('pending', value))
const parsed = computed(() => {
  if (!input.value.trim()) return { notes: [], error: '' }
  try { return { notes: parseBatchNotes(input.value, props.chainId), error: '' } }
  catch (e) { return { notes: [], error: safeError(e) } }
})
const total = computed(() => parsed.value.notes.reduce((sum, n) => sum + n.pool.amount, 0n))
function walletContext() {
  if (!props.wallet || !props.account) throw new Error('Connect the fresh receiver wallet first.')
  return { provider: props.wallet.provider, account: props.account }
}
function cancelPreparation(reason = 'Batch preparation was stopped by you.') {
  const cancellation = new Error(reason)
  controller?.abort(cancellation)
  approval?.reject(cancellation)
  approval = undefined; approvalPending.value = false
}
watch([() => props.chainId, () => props.walletChainId, () => props.account, () => props.wallet?.provider, () => props.walletRevision], (next, previous) => {
  const reason = !next[2] ? 'The receiver wallet disconnected. Reconnect before preparing a new batch.'
    : next[3] !== previous[3] ? 'The connected wallet changed. Prepare a new batch with the selected wallet.'
    : next[2] !== previous[2] ? 'The receiver wallet account changed. Prepare a new batch with the selected account.'
    : next[0] !== previous[0] || next[1] !== previous[1] ? 'The network changed. Switch to the selected network and prepare a new batch.'
    : 'The wallet connection changed. Check the selected account and network before preparing a new batch.'
  cancelPreparation(reason)
  if (!progress.value) quote.value = null
})
watch(() => props.active, active => { if (!active && !progress.value) quote.value = null })
watch(() => [props.active, props.account, props.chainId, props.rpcUrl, props.wallet?.provider, props.walletRevision], async () => {
  const check = ++receiverCheck
  receiverValid.value = false; receiverError.value = ''; receiverChecking.value = false
  if (!props.active || !props.account || !props.wallet) return
  if (props.walletChainId !== props.chainId) { receiverError.value = `Switch your wallet to ${NETWORKS[props.chainId].name} before continuing.`; return }
  receiverChecking.value = true
  try {
    await checkFreshReceiver(props.account, { chainId: props.chainId, rpcUrl: props.rpcUrl })
    if (check === receiverCheck) receiverValid.value = true
  } catch (e) {
    if (check === receiverCheck) receiverError.value = safeError(e)
  } finally {
    if (check === receiverCheck) receiverChecking.value = false
  }
}, { immediate: true })
onUnmounted(() => { receiverCheck++; cancelPreparation('The multi-note withdrawal page was closed.') })
async function run(work: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; emit('busy', true); error.value = ''
  try { await work() } catch (e) { error.value = safeError(e) }
  finally { busy.value = false; emit('busy', false); status.value = ''; signingReview.value = null; approval = undefined; approvalPending.value = false; controller = undefined }
}
async function review() {
  await run(async () => {
    if (props.blocked || pending.value) throw new Error('Finish or check the pending session first.')
    if (!receiverValid.value || receiverChecking.value) throw new Error(receiverError.value || 'Wait for the receiver wallet check to finish.')
    const wallet = walletContext(), selected = props.settings()
    frozen.value = selected; quote.value = null; progress.value = null
    controller = new AbortController()
    status.value = 'Checking the receiver wallet and syncing notes…'
    quote.value = await prepareMultiWithdrawal(input.value, wallet, selected, message => { status.value = message }, review => {
      signingReview.value = review; approvalPending.value = true
      status.value = review.kind === 'authorization' ? 'Review receiver delegation before opening your wallet.' : `Review batch signature ${review.sequence} before opening your wallet.`
      return new Promise<void>((resolve, reject) => { approval = { resolve, reject } })
    }, controller.signal)
  })
}
function approveInWallet() {
  const current = approval
  if (!current) return
  approval = undefined; approvalPending.value = false
  status.value = 'Confirm the signature in your wallet…'
  current.resolve()
}
async function submit() {
  await run(async () => {
    if (!quote.value || !frozen.value || progress.value) throw new Error('Prepare a new batch review first.')
    const q = quote.value
    // Preflight failures leave the review available; only submission creates a
    // pending record, so changing wallet/network cannot strand a ready row.
    status.value = 'Checking the receiver and submitting one UserOperation…'
    await submitMultiWithdrawal(q, frozen.value, walletContext(), (_id, patch) => {
      progress.value ??= { id: q.id, label: `${q.notes.length} notes · 1 UserOperation`, status: 'ready' }
      Object.assign(progress.value, patch)
    })
  })
}
async function check() {
  await run(async () => {
    if (!progress.value?.hash || !frozen.value) throw new Error('No UserOperation hash was returned. Check the receiver and bundler before retrying.')
    const tx = await reconcileWithdrawal(frozen.value.bundlerUrl, progress.value.hash, 10_000)
    Object.assign(progress.value, { status: 'confirmed', message: `Transaction ${tx}` })
  })
}
function reset() {
  if (pending.value || busy.value) return
  quote.value = null; progress.value = null; error.value = ''
}
function exportSession() {
  if (!quote.value) return
  downloadText(`tornado-multi-session-${Date.now()}.json`, JSON.stringify({ version: 1, kind: 'multi-withdraw', network: frozen.value?.chainId,
    recipient: quote.value.recipient, userOperationHash: quote.value.signedHash, notes: quote.value.notes.map(n => n.raw), progress: progress.value }, null, 2))
}
async function importFile(event: Event) {
  await run(async () => {
    const file = (event.target as HTMLInputElement).files?.[0]
    if (!file) return
    try {
      if (file.size > 64_000) throw new Error('Choose a plain-text note file up to 64 KB.')
      input.value = extractNoteStrings(await file.text()).join('\n')
      parseBatchNotes(input.value, props.chainId)
    } finally { if (fileInput.value) fileInput.value.value = '' }
  })
}
</script>

<template>
  <section class="transaction-panel" aria-label="Multi-note withdrawal">
    <header class="multi-heading"><div><span class="pill">WALLET SIGNING</span><h2>Multi-note withdrawal</h2></div><button class="text-button" :disabled="busy || pending" @click="emit('back')">Single-note flow <Icon name="arrow" :size="14" /></button></header>
    <div class="panel-body">
      <template v-if="signingReview">
        <p class="modal-description">{{ signingReview.kind === 'authorization' ? 'Authorize the receiver' : `Review batch signature ${signingReview.sequence}` }} · {{ signingReview.chainId === 1 ? 'Ethereum' : 'Sepolia' }}</p>
        <div class="recipient-review"><span>Receiver &amp; executor · {{ wallet?.name }}</span><code>{{ signingReview.account }}</code></div>
        <template v-if="signingReview.kind === 'authorization'">
          <p class="input-hint">Your wallet will authorize this account to use the Tornado SDK executor. This delegation remains on the account after the withdrawal. It does not spend your wallet’s ETH on gas.</p>
          <div class="recipient-review"><span>Executor implementation</span><code>{{ SIMPLE_7702_IMPLEMENTATION }}</code></div>
        </template>
        <template v-else>
          <div class="quote-card"><div><span>Notes in one UserOperation</span><b>{{ parsed.notes.length }}</b></div><div><span>Paymaster fee</span><b>{{ units(signingReview.fee!, parsed.notes[0]!.pool.asset) }} {{ parsed.notes[0]!.pool.asset.symbol }}</b></div><div class="net-row"><span>Receiver keeps</span><b>{{ units(signingReview.net!, parsed.notes[0]!.pool.asset) }} {{ parsed.notes[0]!.pool.asset.symbol }}</b></div></div>
          <p class="input-hint">Gas budget: {{ formatEther(signingReview.maxGasCost!) }} ETH, covered by the sponsoring note’s fee. Gas estimation may require another signature if the payload changes. Each signature approves an executable batch that the selected bundler can submit.</p>
        </template>
        <button class="button primary full" :disabled="!approvalPending" @click="approveInWallet">{{ approvalPending ? 'Approve & open wallet' : 'Waiting for wallet / gas estimate…' }}<Icon name="wallet" /></button>
        <button class="button full" @click="cancelPreparation()">Stop preparation</button>
      </template>
      <template v-else-if="!quote">
        <p class="modal-description">Withdraw 2–{{ MAX_MULTI_NOTES }} notes of one asset in one UserOperation. Different denominations are welcome.</p>
        <div class="field-heading amount-heading"><label for="batch-notes">Withdrawal notes</label><button class="text-button" :disabled="busy || blocked" @click="fileInput?.click()"><Icon name="file" :size="14" />Import .txt</button></div>
        <input ref="fileInput" type="file" accept=".txt,text/plain" hidden @change="importFile" />
        <textarea id="batch-notes" v-model="input" :disabled="busy || blocked" rows="5" spellcheck="false" autocomplete="off" placeholder="Paste one note per line" />
        <p v-if="parsed.error" class="field-error" role="alert">{{ parsed.error }}</p><p v-else class="input-hint">{{ parsed.notes.length ? `${parsed.notes.length} notes · 1 UserOperation` : 'Only supported notes on the selected network.' }}</p>
        <div v-if="account" class="recipient-review"><span>Connected receiver &amp; executor · {{ wallet?.name }}</span><code>{{ account }}</code></div>
        <button class="button full" :disabled="busy || blocked" :aria-describedby="receiverError ? 'receiver-error' : undefined" @click="emit('connect')"><Icon name="wallet" />{{ account ? 'Change receiver wallet' : 'Connect receiver wallet' }}</button>
        <p v-if="receiverError" id="receiver-error" class="field-error" role="alert">{{ receiverError }}</p>
        <p v-else-if="receiverChecking" class="input-hint" role="status">Checking receiver wallet…</p>
        <p class="input-hint">The receiver wallet must be an unused EOA. Your wallet will sign the delegation and batch.</p>
        <div v-if="parsed.notes.length" class="withdraw-summary"><span>Total note value</span><b>{{ units(total, parsed.notes[0]!.pool.asset) }} {{ parsed.notes[0]!.pool.asset.symbol }}</b><small>The fee comes from one sponsoring note and covers the whole UserOperation.</small></div>
        <div class="field-heading recipient-heading"><span>Bundler &amp; RPC</span><button class="text-button" :disabled="busy || blocked" @click="emit('configure')">Configure <Icon name="settings" :size="14" /></button></div>
        <button class="button primary full" :disabled="busy || blocked || !parsed.notes.length || !account || !receiverValid || receiverChecking" @click="review">{{ busy ? 'Preparing batch…' : 'Review & sign one UserOperation' }}<Icon name="arrow" /></button>
        <button v-if="busy" class="button full" @click="cancelPreparation()">Stop preparation</button>
      </template>
      <template v-else>
        <p class="modal-description">{{ quote.notes.length }} notes · 1 UserOperation · {{ frozen!.chainId === 1 ? 'Ethereum' : 'Sepolia' }}</p>
        <div class="recipient-review"><span>Receiver &amp; executor</span><code>{{ quote.recipient }}</code></div>
        <div class="note-breakdown"><div v-for="(note, i) in quote.notes" :key="i"><span>Note {{ i + 1 }}</span><b>{{ note.pool.denomination }} {{ note.pool.asset.symbol }}</b></div></div>
        <div class="quote-card"><div><span>Total note value</span><b>{{ units(quote.net + quote.fee, quote.notes[0]!.pool.asset) }} {{ quote.notes[0]!.pool.asset.symbol }}</b></div><div><span>Paymaster fee</span><span>−{{ units(quote.fee, quote.notes[0]!.pool.asset) }}</span></div><div class="net-row"><span>Receiver keeps</span><b>{{ units(quote.net, quote.notes[0]!.pool.asset) }} {{ quote.notes[0]!.pool.asset.symbol }}</b></div></div>
        <p class="input-hint">Your wallet signed this batch for estimation. The selected bundler already has executable signatures. The sponsoring note is consumed in validation; the other notes execute together. If execution fails, sponsoring proceeds may remain on the receiver while other notes remain unspent. Keep every note and access to the receiver wallet. The displayed net excludes later gas refunds.</p>
        <button v-if="!progress" class="button primary full" :disabled="busy || blocked || !account || account.toLowerCase() !== quote.recipient.toLowerCase()" @click="submit">Submit {{ quote.notes.length }} notes in 1 UserOperation<Icon name="arrow" /></button>
        <div v-else class="progress-item"><div><b>{{ progress.label }}</b><span class="progress-state" :class="progress.status">{{ progress.status }}</span></div><code v-if="progress.hash">{{ shorten(progress.hash) }}</code><p v-if="progress.message">{{ progress.message }}</p></div>
        <button v-if="pending" class="button full" :disabled="busy" @click="check"><Icon name="refresh" />Check UserOperation</button>
        <button class="button full" :disabled="busy" @click="exportSession"><Icon name="download" />Download session &amp; notes</button>
        <button class="text-button multi-link" :disabled="busy || pending" @click="reset">Start a new batch</button>
      </template>
      <div v-if="status" class="modal-status" role="status"><span class="spinner"></span>{{ status }}</div>
      <div v-if="error" class="error-banner modal-error" role="alert"><Icon name="info" />{{ error }}</div>
    </div>
  </section>
</template>
