<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { NETWORKS, units, type ChainId } from './core/catalog'
import { createComplianceReport, reportDate, type ComplianceReport } from './core/compliance'
import { extractNoteStrings, parseNote } from './core/notes'
import { safeError, type ConnectionSettings } from './core/rpc'

const props = defineProps<{ chainId: ChainId; connectionKey: string; getSettings: () => ConnectionSettings }>()
const emit = defineEmits<{ back: []; settings: [] }>()
const input = ref(''), busy = ref(false), status = ref(''), error = ref(''), acknowledged = ref(false), exporting = ref(false)
const report = ref<ComplianceReport | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
let controller: AbortController | undefined
const parsed = computed(() => {
  if (!input.value.trim()) return { note: null, error: '' }
  try { return { note: parseNote(input.value, props.chainId), error: '' } }
  catch (error) { return { note: null, error: safeError(error) } }
})
const explorer = computed(() => NETWORKS[report.value?.note.pool.chainId ?? props.chainId].explorer)
function reset() {
  controller?.abort(); controller = undefined
  report.value = null; acknowledged.value = false; error.value = ''; status.value = ''; busy.value = false
}
watch([input, () => props.chainId, () => props.connectionKey], reset, { flush: 'sync' })
onUnmounted(reset)
async function inspect() {
  if (!parsed.value.note || busy.value) return
  reset()
  const request = new AbortController(); controller = request; busy.value = true
  try {
    const result = await createComplianceReport(input.value, props.getSettings(), message => {
      if (!request.signal.aborted) status.value = message
    }, request.signal)
    if (!request.signal.aborted) report.value = result
  } catch (reason) { if (!request.signal.aborted) error.value = safeError(reason) }
  finally { if (controller === request) { busy.value = false; status.value = ''; controller = undefined } }
}
async function importFile(event: Event) {
  const target = event.target as HTMLInputElement, file = target.files?.[0]
  if (!file) return
  reset()
  try {
    if (file.size > 1024 * 1024) throw new Error('Choose a note backup smaller than 1 MiB.')
    const notes = extractNoteStrings(await file.text())
    if (notes.length !== 1) throw new Error('This backup contains multiple notes. Paste one note at a time to create its report.')
    input.value = notes[0]!
  } catch (reason) { error.value = safeError(reason) }
  finally { target.value = '' }
}
async function download() {
  const current = report.value
  if (!current?.withdrawal || !acknowledged.value || exporting.value) return
  exporting.value = true; error.value = ''
  try {
    // Load the PDF library only when requested, keeping ordinary flows unchanged.
    const { downloadCompliancePdf } = await import('./core/compliance-pdf')
    if (report.value === current && acknowledged.value) downloadCompliancePdf(current)
  } catch { error.value = 'The PDF could not be generated. Please try downloading it again.' }
  finally { exporting.value = false }
}
</script>

<template>
  <section class="compliance-page" aria-labelledby="compliance-title">
    <button class="text-button compliance-back" @click="emit('back')">← Back to Tornado</button>
    <div class="compliance-intro">
      <div class="eyebrow">YOUR TRANSACTION HISTORY</div>
      <h1 id="compliance-title">Tornado <span>compliance tool</span></h1>
      <p>Use a Tornado note to link its deposit and withdrawal in a shareable report. The note’s hashes are calculated locally and checked against pool events on the selected network.</p>
      <p>No wallet connection or signature is needed. Your full note stays in this browser unless you download and share the report.</p>
    </div>
    <div class="compliance-form">
      <div class="field-heading"><label for="compliance-note">Note</label><button class="text-button" @click="fileInput?.click()"><Icon name="file" :size="14" /> Import .txt</button></div>
      <input id="compliance-note" v-model="input" class="text-input" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="Paste one Tornado note" aria-describedby="compliance-privacy" />
      <input ref="fileInput" type="file" accept=".txt,text/plain" hidden @change="importFile" />
      <p id="compliance-privacy" class="input-hint">Creating or sharing a report reveals the link between a deposit and withdrawal. RPC and history providers can see your IP address and the public records requested. Use only notes you intend to disclose.</p>
      <p v-if="parsed.error" class="compliance-validation" role="alert">{{ parsed.error }}</p>
      <div class="compliance-controls"><button class="button primary" :disabled="!parsed.note || busy" @click="inspect">{{ busy ? 'Checking history…' : report ? 'Refresh report' : 'Generate report' }} <Icon name="arrow" /></button><button class="text-button" @click="emit('settings')">RPC &amp; history settings</button><button v-if="busy" class="text-button" @click="reset">Cancel</button><button v-else-if="input" class="text-button" @click="input = ''; reset()">Clear note</button></div>
      <p v-if="busy" class="compliance-progress" role="status">{{ status }}</p>
    </div>
    <div v-if="error" class="error-box" role="alert"><Icon name="info" /><span>{{ error }}</span></div>
    <div v-if="report" class="compliance-results">
      <div class="compliance-context"><span>{{ NETWORKS[report.note.pool.chainId].name }} · {{ report.note.pool.denomination }} {{ report.note.pool.asset.symbol }} pool</span><a :href="`${explorer}/address/${report.note.pool.address}`" target="_blank" rel="noreferrer">{{ report.note.pool.address }} ↗</a><small>Checked at block {{ report.checkedBlock }} · {{ reportDate(report.checkedAt) }}</small></div>
      <div v-if="!report.withdrawal" class="privacy-warning"><Icon name="info" /><div><b>This note has not been spent</b>Anyone with the full note can withdraw its funds. Do not share it. A downloadable report becomes available after a withdrawal has been verified.</div></div>
      <div class="compliance-columns">
        <article class="compliance-card">
          <h2>Deposit <span>{{ report.note.pool.denomination }} {{ report.note.pool.asset.symbol }}</span></h2>
          <div class="compliance-status">✓ Event verified</div>
          <dl>
            <dt>Date</dt><dd>{{ reportDate(report.deposit.timestamp) }}</dd>
            <dt>Transaction</dt><dd><a :href="`${explorer}/tx/${report.deposit.transactionHash}`" target="_blank" rel="noreferrer">{{ report.deposit.transactionHash }} ↗</a></dd>
            <dt>Transaction sender</dt><dd><a :href="`${explorer}/address/${report.deposit.transactionSender}`" target="_blank" rel="noreferrer">{{ report.deposit.transactionSender }} ↗</a></dd>
            <dt>Commitment</dt><dd>{{ report.commitment }}</dd>
            <dt>Block / log index / leaf index</dt><dd>{{ report.deposit.blockNumber }} / {{ report.deposit.logIndex }} / {{ report.deposit.leafIndex }}</dd>
          </dl>
        </article>
        <article class="compliance-card">
          <h2>Withdrawal <span v-if="report.withdrawal">{{ units(report.withdrawal.poolPayout, report.note.pool.asset) }} {{ report.note.pool.asset.symbol }}</span></h2>
          <div class="compliance-status" :class="{ unspent: !report.withdrawal }">{{ report.withdrawal ? '✓ Event verified' : 'Note has not been spent' }}</div>
          <dl v-if="report.withdrawal">
            <dt>Date</dt><dd>{{ reportDate(report.withdrawal.timestamp) }}</dd>
            <dt>Transaction</dt><dd><a :href="`${explorer}/tx/${report.withdrawal.transactionHash}`" target="_blank" rel="noreferrer">{{ report.withdrawal.transactionHash }} ↗</a></dd>
            <dt>Pool recipient</dt><dd><a :href="`${explorer}/address/${report.withdrawal.recipient}`" target="_blank" rel="noreferrer">{{ report.withdrawal.recipient }} ↗</a></dd>
            <dt>Nullifier hash</dt><dd>{{ report.nullifierHash }}</dd>
            <dt>Block / log index</dt><dd>{{ report.withdrawal.blockNumber }} / {{ report.withdrawal.logIndex }}</dd>
            <dt>Pool fee (before any gas refund)</dt><dd>{{ units(report.withdrawal.fee, report.note.pool.asset) }} {{ report.note.pool.asset.symbol }}</dd>
            <dt>Relayer / paymaster</dt><dd><a v-if="BigInt(report.withdrawal.relayer) !== 0n" :href="`${explorer}/address/${report.withdrawal.relayer}`" target="_blank" rel="noreferrer">{{ report.withdrawal.relayer }} ↗</a><span v-else>None</span></dd>
          </dl>
          <p v-else class="compliance-empty">No withdrawal recorded as of block {{ report.checkedBlock }}.</p>
        </article>
      </div>
      <p class="compliance-explanation">The transaction sender may be a bundler or router. The pool recipient may be a smart account or an intermediate address. The pool payout and fee shown here do not include later gas refunds, transfers or contract calls.</p>
      <div v-if="report.withdrawal" class="compliance-export">
        <div class="privacy-warning"><Icon name="info" /><div><b>This report contains the full note</b>Sharing it permanently links this deposit and withdrawal. It is an informational record, not a legal certification or proof that you own either address.</div></div>
        <label class="backup-check"><input v-model="acknowledged" type="checkbox" />I understand that the PDF includes my full note and reveals this transaction history.</label>
        <button class="button primary" :disabled="!acknowledged || exporting" @click="download"><Icon name="download" />{{ exporting ? 'Creating PDF…' : 'Download PDF report' }}</button>
      </div>
    </div>
  </section>
</template>
