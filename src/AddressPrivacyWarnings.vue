<script setup lang="ts">
import Icon from './Icon.vue'
import { NETWORKS, type ChainId } from './core/catalog'
import type { AddressPrivacyCheck } from './core/address-privacy'

defineProps<{ checks: AddressPrivacyCheck[]; loading: boolean; disabled?: boolean; chainId: ChainId }>()
defineEmits<{ recheck: [] }>()
</script>

<template>
  <div v-if="checks.length" class="address-privacy" aria-label="Address privacy checks">
    <div class="field-heading"><span>Address privacy</span><button class="text-button" :disabled="disabled || loading" @click="$emit('recheck')"><Icon name="refresh" :size="13" />Recheck</button></div>
    <p v-if="loading" class="input-hint" role="status">Checking ETH and token balances, nonces and code…</p>
    <template v-for="check in checks" :key="check.address">
      <div v-if="check.signals.length || !loading && check.incomplete" class="privacy-warning" role="status">
        <Icon name="info" :size="17" /><div><b>{{ check.label }}</b><code>{{ check.address }}</code>
          <p v-if="check.signals.length">This address is not fresh: {{ check.signals.join('; ') }}. This withdrawal can be linked to previous activity. {{ check.advice }}</p>
          <p v-if="!loading && check.incomplete">Some address checks failed. Freshness could not be fully checked; recheck or continue with care.</p>
        </div>
      </div>
    </template>
    <p class="input-hint">These checks use current state on {{ NETWORKS[chainId].name }}. Zero balances, nonces and code do not prove an address has no history.</p>
  </div>
</template>
