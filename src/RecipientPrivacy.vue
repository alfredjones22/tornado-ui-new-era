<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { isAddress, type Address } from 'viem'
import AddressPrivacyWarnings from './AddressPrivacyWarnings.vue'
import { loadAddressPrivacy, recipientPrivacyCheck, type AddressPrivacyState } from './core/address-privacy'
import type { ConnectionSettings } from './core/rpc'

const props = defineProps<{ address: string; active: boolean; disabled?: boolean; settings: Pick<ConnectionSettings, 'chainId' | 'rpcUrl'> }>()
const emit = defineEmits<{ loading: [value: boolean] }>()
const states = ref<ReadonlyMap<string, AddressPrivacyState>>(new Map()), loading = ref(false)
const address = computed(() => isAddress(props.address) && BigInt(props.address) !== 0n ? props.address as Address : undefined)
const checks = computed(() => props.active && address.value ? [recipientPrivacyCheck(address.value, states.value)] : [])
let request = 0, timer: ReturnType<typeof setTimeout> | undefined
function refresh(delay = 0) {
  const current = ++request, recipient = address.value, settings = { ...props.settings }
  clearTimeout(timer); states.value = new Map(); loading.value = false
  if (!props.active || !recipient) return
  loading.value = true
  timer = setTimeout(async () => {
    try {
      const result = await loadAddressPrivacy([recipient], settings)
      if (request === current) states.value = result
    } catch { /* Missing results remain unknown, never implicitly fresh. */ }
    finally { if (request === current) loading.value = false }
  }, delay)
}
watch([address, () => props.active, () => props.settings.chainId, () => props.settings.rpcUrl], () => refresh(250), { immediate: true })
watch(loading, value => emit('loading', value), { immediate: true })
onUnmounted(() => { request++; clearTimeout(timer); emit('loading', false) })
</script>

<template>
  <AddressPrivacyWarnings :checks="checks" :loading="loading" :disabled="disabled" :chain-id="settings.chainId" @recheck="refresh()" />
</template>
