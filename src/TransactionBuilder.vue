<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { formatEther, toFunctionSignature, type Address } from 'viem'
import Icon from './Icon.vue'
import ActionBudget from './ActionBudget.vue'
import { NETWORKS, shorten, type Asset, type ChainId } from './core/catalog'
import type { ActionBalances } from './core/action-budget'
import { downloadText } from './core/notes'
import { safeError } from './core/rpc'
import { callEth, callSummary, canonicalCalls, encodeBuilderCall, ethValue, exportSafeBatch, importSafeBatch, MAX_ABI_BYTES, MAX_ACTIONS, MAX_IMPORT_BYTES, parseContractAbi, type BuilderAction } from './core/transaction-builder'

const props = defineProps<{ actions: BuilderAction[]; chainId: ChainId; account: Address; owner: Address; deployed: boolean; noteCount: number; canPrepare: boolean; simulationRpc: string; asset: Asset; total: bigint; balances: ActionBalances; balancesLoading: boolean }>()
const emit = defineEmits<{ close: []; save: [actions: BuilderAction[], simulate: boolean, rpc: string] }>()
const actions = ref<BuilderAction[]>(props.actions.map(call => ({ ...call }))), raw = ref(false)
const to = ref(''), value = ref('0'), data = ref('0x'), abiText = ref(''), method = ref(''), args = ref<string[]>([]), editing = ref<number | null>(null)
const error = ref(''), rpc = ref(props.simulationRpc), importInput = ref<HTMLInputElement | null>(null), abiInput = ref<HTMLInputElement | null>(null)
const panel = ref<HTMLElement | null>(null), title = ref<HTMLElement | null>(null)
onMounted(() => { panel.value?.scrollIntoView?.({ block: 'start' }); title.value?.focus({ preventScroll: true }) })
const abi = computed(() => { try { return { functions: abiText.value.trim() ? parseContractAbi(abiText.value) : [], error: '' } } catch (e) { return { functions: [], error: safeError(e) } } })
const selected = computed(() => abi.value.functions.find(fn => toFunctionSignature(fn) === method.value))
watch(abi, () => { method.value = abi.value.functions[0] ? toFunctionSignature(abi.value.functions[0]) : '' })
watch(selected, fn => { args.value = fn?.inputs.map(() => '') ?? [] })
const totalEth = computed(() => actions.value.reduce((sum, call) => sum + call.value, 0n))
function reset() { to.value = ''; value.value = '0'; data.value = '0x'; editing.value = null; error.value = '' }
function add() {
  error.value = ''
  try {
    const amount = ethValue(value.value)
    if (!raw.value && !selected.value) throw new Error('Paste an ABI and choose a function, or switch to custom data.')
    const call = raw.value ? canonicalCalls([{ to: to.value as Address, value: amount, data: data.value as `0x${string}` }], props.account)[0]!
      : encodeBuilderCall(to.value, amount, selected.value!, args.value, props.account)
    const next = [...actions.value]
    if (editing.value === null) next.push(call); else next[editing.value] = call
    canonicalCalls(next, props.account); actions.value = next; reset()
  } catch (e) { error.value = safeError(e) }
}
function edit(index: number) {
  const call = actions.value[index]!
  editing.value = index; to.value = call.to; value.value = callEth(call); data.value = call.data; raw.value = true; error.value = ''
}
function move(index: number, delta: number) {
  const next = [...actions.value], destination = index + delta
  if (editing.value !== null || destination < 0 || destination >= next.length) return
  ;[next[index], next[destination]] = [next[destination]!, next[index]!]; actions.value = next
}
function duplicate(index: number) {
  try { const next = [...actions.value]; next.splice(index + 1, 0, { ...next[index]! }); canonicalCalls(next, props.account); actions.value = next }
  catch (e) { error.value = safeError(e) }
}
async function importFile(event: Event, kind: 'abi' | 'batch') {
  const field = event.target as HTMLInputElement, file = field.files?.[0]
  if (!file) return
  try {
    if (file.size > (kind === 'abi' ? MAX_ABI_BYTES : MAX_IMPORT_BYTES)) throw new Error('This file is too large.')
    const text = await file.text()
    if (kind === 'abi') { parseContractAbi(text); abiText.value = text }
    else { const next = [...actions.value, ...importSafeBatch(text, props.chainId, props.account)]; canonicalCalls(next, props.account); actions.value = next }
    error.value = ''
  } catch (e) { error.value = safeError(e) } finally { field.value = '' }
}
function save(simulate: boolean) {
  try {
    if (editing.value !== null || to.value.trim()) throw new Error('Add or cancel the action you are editing first.')
    canonicalCalls(actions.value, props.account)
    emit('save', actions.value.map(call => ({ ...call })), simulate, rpc.value)
  } catch (e) { error.value = safeError(e) }
}
</script>

<template>
  <section ref="panel" class="transaction-panel action-builder" aria-label="Transaction builder">
    <div class="multi-heading"><div><span class="feature-label feature-label-advanced">ADVANCED</span><h2 ref="title" tabindex="-1">Transaction builder</h2></div><button class="text-button" @click="emit('close')">← Back to withdrawal</button></div>
    <div class="panel-body">
      <div class="builder-context"><b>Executing as your smart account</b><a v-if="account" :href="`${NETWORKS[chainId].explorer}/address/${account}`" target="_blank" rel="noopener noreferrer"><code>{{ account }}</code> ↗</a><span v-else>Connect your controller wallet on the withdrawal screen.</span><small>{{ NETWORKS[chainId].name }} · Controller {{ owner ? shorten(owner) : 'not connected' }} · {{ deployed ? 'Already deployed' : 'Deploys in this UserOperation' }}</small><p>Contracts see this smart account as the caller, not your connected wallet. Actions run in order after all withdrawals. Gas refunds arrive afterwards and cannot fund these actions.</p></div>
      <ActionBudget :asset="asset" :total="total" :balances="balances" :loading="balancesLoading" :eth-sent="totalEth" />
      <div class="builder-columns">
        <div class="builder-editor">
          <div class="field-heading"><h3>{{ editing === null ? 'New action' : `Edit action ${editing + 1}` }}</h3><label class="builder-toggle"><input v-model="raw" type="checkbox" />Custom data</label></div>
          <label class="builder-field" for="action-target">To address</label><input id="action-target" v-model.trim="to" class="text-input" placeholder="0x…" spellcheck="false" />
          <template v-if="!raw">
            <div class="field-heading"><label for="action-abi">Contract ABI</label><button class="text-button" @click="abiInput?.click()">Import ABI</button></div>
            <input ref="abiInput" type="file" accept=".json,application/json" hidden @change="importFile($event, 'abi')" />
            <textarea id="action-abi" v-model="abiText" :maxlength="MAX_ABI_BYTES" rows="4" placeholder="Paste the contract JSON ABI" spellcheck="false" />
            <p v-if="abi.error" class="field-error">{{ abi.error }}</p>
            <template v-if="abi.functions.length"><label class="builder-field" for="action-method">Contract method</label><div class="select-wrap"><select id="action-method" v-model="method"><option v-for="fn in abi.functions" :key="toFunctionSignature(fn)" :value="toFunctionSignature(fn)">{{ toFunctionSignature(fn) }}</option></select></div>
              <div v-for="(parameter, i) in selected?.inputs" :key="`${method}-${i}`"><label class="builder-field" :for="`action-arg-${i}`">{{ parameter.name || `Argument ${i + 1}` }} <small>({{ parameter.type }})</small></label><input :id="`action-arg-${i}`" v-model="args[i]" class="text-input" :placeholder="parameter.type.includes('[') || parameter.type === 'tuple' ? 'JSON array or object; quote large integers' : parameter.type" spellcheck="false" /></div>
            </template>
          </template>
          <label class="builder-field" for="action-value">ETH value</label><input id="action-value" v-model.trim="value" class="text-input" inputmode="decimal" placeholder="0" />
          <template v-if="raw"><label class="builder-field" for="action-data">Data (hex encoded)</label><textarea id="action-data" v-model.trim="data" rows="4" placeholder="0x" spellcheck="false" /></template>
          <p class="input-hint">Integer function arguments use base units. ETH value uses ETH. Tuples and arrays use JSON.</p>
          <button class="button primary full" :disabled="editing === null && actions.length >= MAX_ACTIONS" @click="add">{{ editing === null ? 'Add action' : 'Save changes' }} +</button>
          <button v-if="editing !== null || to" class="text-button builder-cancel" @click="reset">Cancel edit</button>
        </div>
        <div class="builder-queue">
          <div class="field-heading"><h3>Your batch</h3><span>{{ actions.length }} / {{ MAX_ACTIONS }} actions</span></div>
          <div class="builder-prefix"><span>01 · Locked</span><b>{{ noteCount || 'Selected' }} withdrawal{{ noteCount === 1 ? '' : 's' }} → smart account</b><small>The sponsoring note pays the fee during validation; remaining notes arrive before your actions.</small></div>
          <p v-if="!actions.length" class="builder-empty">Start building your batch.<br />Add an action or import a Safe batch JSON.</p>
          <ol class="builder-actions"><li v-for="(call, i) in actions" :key="i" :class="{ editing: editing === i }"><div><span>Action {{ i + 1 }}</span><b>{{ callSummary(call) }}</b><a :href="`${NETWORKS[chainId].explorer}/address/${call.to}`" target="_blank" rel="noopener noreferrer">{{ shorten(call.to) }} ↗</a><small>{{ callEth(call) }} ETH · {{ (call.data.length - 2) / 2 }} bytes</small></div><div class="builder-tools"><button :disabled="editing !== null || i === 0" :aria-label="`Move action ${i + 1} up`" @click="move(i, -1)">↑</button><button :disabled="editing !== null || i === actions.length - 1" :aria-label="`Move action ${i + 1} down`" @click="move(i, 1)">↓</button><button :disabled="editing !== null" @click="edit(i)">Edit</button><button :disabled="editing !== null || actions.length >= MAX_ACTIONS" @click="duplicate(i)">Copy</button><button :disabled="editing !== null" :aria-label="`Delete action ${i + 1}`" @click="actions.splice(i, 1)">×</button></div><details><summary>View calldata</summary><code>{{ call.data }}</code></details></li></ol>
          <div class="builder-import"><button class="text-button" @click="importInput?.click()">Import Safe JSON</button><button class="text-button" :disabled="!actions.length" @click="downloadText('tornado-custom-actions.json', exportSafeBatch(actions, chainId))">Export actions</button><input ref="importInput" type="file" accept=".json,application/json" hidden @change="importFile($event, 'batch')" /></div>
          <p class="input-hint">Total ETH sent by actions: {{ formatEther(totalEth) }} ETH. Existing smart-account balances and approvals may also be used.</p>
        </div>
      </div>
      <div class="builder-risk"><Icon name="info" :size="16" /><p>If execution reverts, the sponsoring note can still be spent and its proceeds remain in your smart account. Recover them from Manage smart account. Other notes may stay unspent. A successful call does not guarantee the intended result; review amounts, approvals and recipients.</p></div>
      <details class="builder-rpc"><summary>Advanced simulation settings</summary><label class="builder-field" for="simulation-rpc">Simulation RPC (optional)</label><input id="simulation-rpc" v-model.trim="rpc" class="text-input" placeholder="Use the configured website RPC" spellcheck="false" /><p class="input-hint">Full previews use eth_simulateV1. This endpoint sees the prepared operation, including public withdrawal proofs and calls. No note secrets are sent.</p></details>
      <div class="builder-simulation-note"><Icon name="shield" :size="18" /><p><b>Simulate the whole withdrawal</b>Review &amp; simulate checks the complete operation, including the withdrawals and all contract calls. It generates proofs and may open typed-data wallet prompts as the gas estimate changes. You can run the final simulation again before clicking Submit.</p></div>
      <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
      <div class="builder-footer"><button class="button" @click="save(false)">Save actions &amp; return</button><button class="button primary" :disabled="!canPrepare || !actions.length" @click="save(true)">Review &amp; simulate withdrawal <Icon name="arrow" /></button></div>
    </div>
  </section>
</template>
