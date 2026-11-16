<script setup lang="ts">
import { computed } from 'vue'
import Icon from './Icon.vue'
import { shorten } from './core/catalog'
import type { SmartWithdrawalQuote } from './core/smart-withdrawal'
import type { WithdrawalSimulation } from './core/withdrawal-simulation'

const props = defineProps<{ quote: SmartWithdrawalQuote; result?: WithdrawalSimulation; running: boolean; disabled: boolean; current: boolean; expired: boolean; customRpc: boolean }>()
defineEmits<{ simulate: []; recalculate: [] }>()
const title = computed(() => props.running ? 'Simulating complete withdrawal…' : props.expired ? 'Review expired'
  : props.result?.status === 'failed' ? 'Simulation failed' : props.result && !props.current ? 'Simulation needs refreshing'
    : props.result?.status === 'passed' ? 'Full simulation passed ✓' : props.result?.status === 'unavailable' ? 'Detailed preview unavailable' : 'Simulate before submitting')
const actionCount = computed(() => props.quote.scope.calls?.length ?? 0)
const appearance = computed(() => props.expired || props.result && !props.current && props.result.status !== 'failed' ? 'expired' : props.result?.status ?? 'ready')
</script>

<template>
  <section class="final-simulation" :class="[appearance, { checking: running }]" aria-labelledby="final-simulation-title" :aria-busy="running">
    <div class="final-simulation-heading"><Icon name="shield" /><h3 id="final-simulation-title">{{ title }}</h3><small v-if="!result && !running">{{ actionCount ? 'CONTRACT CALL CHECK' : 'OPTIONAL' }}</small></div>
    <p>Check the complete signed operation: account deployment if needed, all {{ quote.notes.length }} withdrawal{{ quote.notes.length === 1 ? '' : 's' }}<template v-if="actionCount"> and {{ actionCount }} contract call{{ actionCount === 1 ? '' : 's' }}</template><template v-else-if="quote.scope.payout !== 'account' && quote.notes.length > 1"> and forwarding to your recipient</template>.</p>
    <p v-if="expired" class="final-simulation-expiry">Recalculate the fee and gas to refresh proofs and signatures before simulating or submitting.</p>
    <p v-else-if="result && !running">{{ result.message }}</p>
    <small v-if="result && !running" class="final-simulation-meta">Operation {{ shorten(result.hash) }}<template v-if="result.block !== undefined"> · block {{ result.block }}</template><template v-if="result.gasUsed !== undefined"> · {{ result.gasUsed }} gas</template><template v-if="actionCount"> · {{ actionCount }} contract calls</template></small>
    <details v-if="result?.transfers?.length && current && !running"><summary>Transfers touching your smart account</summary><p v-for="(transfer, i) in result.transfers" :key="i"><code>{{ shorten(transfer.from) }} → {{ shorten(transfer.to) }}</code> · {{ transfer.value.toString() }} base units · {{ shorten(transfer.token) }}</p><p>ETH transfers use the 0xEeee… marker. Token logs are reported as emitted; this is not a complete asset or approval audit.</p></details>
    <div class="final-simulation-controls"><button class="button full" :disabled="disabled || expired" @click="$emit('simulate')"><Icon name="refresh" :size="16" />{{ running ? 'Simulating…' : result ? 'Simulate again' : 'Simulate withdrawal' }}</button><button class="text-button" :disabled="disabled" title="Refresh proofs and gas estimates; new wallet signatures will be requested" @click="$emit('recalculate')">Recalculate fee &amp; gas</button></div>
    <p class="input-hint">Simulation runs through {{ customRpc ? 'your custom simulation RPC' : 'the configured website RPC' }} using the existing signature. Simulating does not submit the operation or open a wallet prompt.</p>
    <details class="final-simulation-details"><summary>Simulation &amp; privacy details</summary><p>The RPC must support eth_simulateV1. It receives the signed operation and may log or retain it; no note secrets are sent. No Tenderly or shared dashboard is used.</p><p>{{ actionCount ? 'Contract calls use the net withdrawal before gas refunds. ' : '' }}Simulation reflects current chain state and cannot guarantee future execution. Submission remains a separate step.</p></details>
  </section>
</template>
