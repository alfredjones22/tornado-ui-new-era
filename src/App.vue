<script setup lang="ts">
import { computed, markRaw, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { isAddress, type Address } from 'viem'
import Icon from './Icon.vue'
import MultiWithdrawal from './MultiWithdrawal.vue'
import ManageSmartAccount from './ManageSmartAccount.vue'
import RecipientPrivacy from './RecipientPrivacy.vue'
import DepositBalances from './DepositBalances.vue'
import Compliance from './Compliance.vue'
import { appAssetUrl } from './core/app-assets'
import { currentPage, pageUrl, type Page } from './core/routes'
import { DENOMINATIONS, NETWORKS, assetsFor, depositBatchLimit, depositCart, expandSelection, poolFor, poolsFor, shorten, supportsClassicRelayer, units, type ChainId } from './core/catalog'
import { downloadText, extractNoteStrings, generateNote, parseNote, poolAbi, type DepositNote } from './core/notes'
import { assertWallet, atomicBatchAvailable, discoverWallets, type DepositMode, type Progress, type WalletOption } from './core/wallet'
import { depositBatches, executeDepositSession, reconcileDepositSession } from './core/deposit-session'
import { checkedSourceUrl, checkedUrl, publicClientFor, safeError, validateConnections, type BundlerKind, type ConnectionSettings } from './core/rpc'
import { ARTIFACTS_URL, SAGA_URLS } from './core/data-sources'
import { prepareWithdrawal, reconcileWithdrawal, submitWithdrawal, type WithdrawalQuote } from './core/withdrawals'
import { prepareRelayerWithdrawal, reconcileRelayerWithdrawal, submitRelayerWithdrawal, type RelayerQuote } from './core/relayers'
import { createWalletConnection } from './core/wallet-connection'
import { setWalletRpcSource } from './core/wallet-rpc'
import type { WithdrawalWallet } from './core/wallet-signer'
import { formatDepositBackup, generateSeededDepositBundle, SEED_BUNDLE_RECOVERY } from './core/seed-bundle'

const logoUrl = appAssetUrl('logo.svg')
const chainId = ref<ChainId>(1)
const tab = ref<'deposit' | 'withdraw'>('deposit')
const page = ref<Page>(currentPage())
const multiOpened = ref(page.value === 'multi'), accountOpened = ref(page.value === 'account')
const multiBusy = ref(false), multiPending = ref(false)
const accountBusy = ref(false), accountPending = ref(false)
const flowBusy = computed(() => multiBusy.value || accountBusy.value)
const flowPending = computed(() => multiPending.value || accountPending.value)
const symbol = ref('ETH')
const overviewSymbol = ref('ETH')
const denomination = ref('0.01')
const browsePools = ref(false), recentPools = ref(['0.01'])
const quantities = ref<Record<string, number>>(Object.fromEntries(DENOMINATIONS.map(d => [d, d === '0.01' ? 1 : 0])))
const bundler = ref<BundlerKind>('pimlico')
const endpoint = ref('')
const rpcUrl = ref<string>(NETWORKS[chainId.value].rpc)
const sagaUrls = ref<Record<ChainId, string>>({ ...SAGA_URLS })
const artifactsUrl = ref(ARTIFACTS_URL)
const useSaga = ref(true), useRemoteArtifacts = ref(true)
const dataSourcesKey = computed(() => JSON.stringify([useSaga.value, sagaUrls.value[chainId.value], useRemoteArtifacts.value, artifactsUrl.value]))
const sendMode = ref<DepositMode>('auto')
const noteInput = ref('')
const recipient = ref('')
const recipientPrivacyLoading = ref(false)
const withdrawalRoute = ref<'paymaster' | 'relayer'>('paymaster')
const busy = ref(false)
const status = ref('')
const error = ref('')
const dialog = ref<'settings' | 'wallets' | 'deposit' | 'withdraw' | 'help' | null>(null)
const walletReturn = ref<'deposit' | null>(null)
const sessionKind = ref<'deposit' | 'withdraw'>('deposit')
const wallets = ref<WalletOption[]>([])
const walletConnection = createWalletConnection()
const connected = computed(() => walletConnection.state.value.wallet)
const account = computed(() => walletConnection.state.value.account)
const walletRevision = computed(() => walletConnection.state.value.revision)
watch(walletConnection.state, value => setWalletRpcSource(value.account ? value.wallet?.provider ?? null : null, value.chainId), { immediate: true, flush: 'sync' })
const canBatch = ref(false)
const generated = ref<DepositNote[]>([])
const bundleWithSeed = ref(false)
const depositSeedPhrase = ref<string | null>(null)
const backupDownloaded = ref(false)
const backupAcknowledged = ref(false)
const quote = ref<WithdrawalQuote | RelayerQuote | null>(null)
const relayerQuote = computed(() => quote.value && 'relayer' in quote.value ? quote.value : null)
const progress = ref<Progress[]>([])
const started = ref(false)
const sessionSettings = ref<ConnectionSettings | null>(null)
const sessionAtomic = ref(false)
const sessionWallet = ref<WalletOption | null>(null)
const sessionAccount = ref<Address | null>(null)
const depositCount = ref<number | null>(null)
const statsLoading = ref(false)
const statsError = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const modalRoot = ref<HTMLElement | null>(null)
let walletDiscovery: ReturnType<typeof discoverWallets> | undefined
let lastFocus: HTMLElement | null = null
let statsRequest = 0

const assets = computed(() => assetsFor(chainId.value))
const asset = computed(() => assets.value.find(a => a.symbol === symbol.value)!)
const availablePools = computed(() => poolsFor(chainId.value, symbol.value))
const denominations = computed(() => symbol.value === 'ETH' ? [...DENOMINATIONS] : availablePools.value.map(p => p.denomination))
const selection = computed(() => Object.entries(quantities.value).map(([denomination, count]) => ({ denomination, count })))
const cart = computed(() => {
  try { return depositCart(chainId.value, selection.value, symbol.value) } catch { return [] }
})
const total = computed(() => cart.value.reduce((sum, row) => sum + row.total, 0n))
const quantity = computed(() => cart.value.reduce((sum, row) => sum + row.count, 0))
const batchCount = computed(() => Math.ceil(quantity.value / depositBatchLimit(asset.value)))
const reviewBatches = computed(() => generated.value.length ? depositBatches(generated.value) : [])
const fallbackGas = computed(() => quote.value?.withdrawal.mode === 'paymaster' && quote.value.withdrawal.gasEstimation?.status === 'fallback')
const overviewPools = computed(() => poolsFor(chainId.value, overviewSymbol.value))
const statPool = computed(() => poolFor(chainId.value, denomination.value, overviewSymbol.value))
const overviewCartTabs = computed(() => page.value === 'basic' && tab.value === 'deposit' ? cart.value : [])
const overviewTabId = computed(() => overviewCartTabs.value.find(row => row.pool.address === statPool.value?.address)
  ? `pool-tab-${statPool.value!.address}` : undefined)
const parsed = computed(() => {
  if (!noteInput.value.trim()) return { note: null, error: '' }
  try { return { note: parseNote(noteInput.value, chainId.value), error: '' } }
  catch (e) { return { note: null, error: safeError(e) } }
})
const classicRelayerAvailable = computed(() => !parsed.value.note || supportsClassicRelayer(parsed.value.note.pool))
const pending = computed(() => progress.value.some(p => ['submitted', 'unknown', 'awaiting-wallet'].includes(p.status)))
const allConfirmed = computed(() => progress.value.length > 0 && progress.value.every(p => p.status === 'confirmed'))
const canStartNewDeposit = computed(() => sessionKind.value === 'deposit' && started.value && allConfirmed.value && progress.value.some(p => p.transactionHash))
const inlineWithdrawalFeedback = computed(() => tab.value === 'withdraw' && !dialog.value)
const settings = (requireBundler = true): ConnectionSettings => {
  let bundlerUrl = ''
  if (endpoint.value.trim()) bundlerUrl = checkedUrl(endpoint.value)
  else if (bundler.value === 'pimlico') bundlerUrl = `https://public.pimlico.io/v2/${chainId.value}/rpc`
  else if (requireBundler) throw new Error('Configure a bundler endpoint in Settings before withdrawing.')
  const backup = useRemoteArtifacts.value ? checkedSourceUrl(artifactsUrl.value) : null
  return { chainId: chainId.value, rpcUrl: checkedUrl(rpcUrl.value), bundler: bundler.value, bundlerUrl,
    sagaUrl: useSaga.value ? checkedSourceUrl(sagaUrls.value[chainId.value]) : null,
    ...(backup === ARTIFACTS_URL ? {} : { artifactsUrl: backup }) }
}
function resetDataSources() {
  sagaUrls.value = { ...SAGA_URLS }; artifactsUrl.value = ARTIFACTS_URL
  useSaga.value = true; useRemoteArtifacts.value = true
}
const managementSettings = (): ConnectionSettings => ({ chainId: chainId.value, rpcUrl: checkedUrl(rpcUrl.value), bundler: bundler.value, bundlerUrl: '' })
function changePage(value: Page) {
  if (busy.value || pending.value || flowBusy.value || flowPending.value) return
  if (value === 'basic' && page.value !== 'compliance') tab.value = 'withdraw'
  page.value = value
  history.pushState(null, '', pageUrl(value))
}
function readPage() {
  if (busy.value || pending.value || flowBusy.value || flowPending.value) { history.replaceState(null, '', pageUrl(page.value)); return }
  page.value = currentPage()
}
watch(page, async value => {
  if (value === 'multi') multiOpened.value = true
  if (value === 'account') accountOpened.value = true
  await nextTick()
  document.querySelector('.workspace')?.scrollIntoView({ block: 'start' })
})
const update = (id: string, patch: Partial<Progress>) => {
  const row = progress.value.find(p => p.id === id)
  if (row) Object.assign(row, patch)
}
async function run(work: () => Promise<void>) {
  if (busy.value) return
  error.value = ''; busy.value = true
  try { await work() } catch (e) { error.value = safeError(e) }
  finally { busy.value = false; status.value = '' }
}
async function connect(option: WalletOption) {
  await run(async () => {
    await walletConnection.connect(option)
    dialog.value = walletReturn.value
    walletReturn.value = null
  })
}
function chooseDepositWallet() {
  walletReturn.value = dialog.value === 'deposit' && !started.value ? 'deposit' : null
  dialog.value = 'wallets'
}
function disconnectWallet() {
  walletConnection.disconnect(); canBatch.value = false
  dialog.value = walletReturn.value; walletReturn.value = null
}
function rejectController(wallet: WithdrawalWallet) {
  // A late response from an old/hidden flow must not disconnect a different wallet.
  if (page.value !== 'basic' && connected.value?.provider === wallet.provider && account.value?.toLowerCase() === wallet.account.toLowerCase()) {
    walletConnection.disconnect(); canBatch.value = false
  }
}
watch([walletRevision, chainId], async () => {
  canBatch.value = false
  const wallet = connected.value, selected = account.value, revision = walletRevision.value, network = chainId.value
  if (!wallet || !selected) return
  const available = await atomicBatchAvailable(wallet.provider, selected, network)
  if (revision === walletRevision.value && network === chainId.value) canBatch.value = available
})
async function reviewDeposit() {
  await run(async () => {
    if (pending.value) { dialog.value = sessionKind.value; throw new Error('Check your pending session before starting another.') }
    if (!quantity.value) throw new Error('Select a valid note configuration.')
    status.value = bundleWithSeed.value ? 'Generating a new seed phrase and withdrawal notes…' : 'Generating independent notes…'
    const frozen = settings(false)
    const pools = expandSelection(chainId.value, selection.value, symbol.value)
    await validateConnections(frozen, false)
    const seeded = bundleWithSeed.value ? await generateSeededDepositBundle(pools) : null
    const notes: DepositNote[] = []
    if (seeded) notes.push(...seeded.notes)
    else for (const pool of pools) notes.push(await generateNote(pool))
    generated.value = notes
    depositSeedPhrase.value = seeded?.seedPhrase ?? null
    sessionSettings.value = frozen
    backupDownloaded.value = false; backupAcknowledged.value = false; started.value = false; progress.value = []
    sessionWallet.value = null; sessionAccount.value = null
    sessionKind.value = 'deposit'; dialog.value = 'deposit'
  })
}
function downloadNotes() {
  downloadText(`tornado-${depositSeedPhrase.value ? 'seed-and-notes' : 'notes'}-${sessionSettings.value!.chainId}-${Date.now()}.txt`, formatDepositBackup(generated.value, depositSeedPhrase.value))
  backupDownloaded.value = true
}
async function startNewDepositSession() {
  if (busy.value || pending.value || flowBusy.value || flowPending.value || !canStartNewDeposit.value) return
  dialog.value = null; walletReturn.value = null
  started.value = false; progress.value = []; generated.value = []; depositSeedPhrase.value = null
  backupDownloaded.value = false; backupAcknowledged.value = false; bundleWithSeed.value = false
  sessionSettings.value = null; sessionWallet.value = null; sessionAccount.value = null; sessionAtomic.value = false
  quote.value = null; status.value = ''; error.value = ''
  symbol.value = 'ETH'; resetSelection(); tab.value = 'deposit'; page.value = 'basic'; location.hash = '#'
  await nextTick()
  document.querySelector<HTMLElement>('#deposit-tab')?.focus()
  document.querySelector('.workspace')?.scrollIntoView({ block: 'start' })
}
async function sendDeposits() {
  await run(async () => {
    if (started.value) throw new Error('This session has already been submitted. Check its status before starting another.')
    if (!backupDownloaded.value || !backupAcknowledged.value) throw new Error('Download and confirm your note backup first.')
    const wallet = connected.value, selected = account.value
    if (!wallet || !selected) throw new Error('Connect a wallet before depositing.')
    const frozen = sessionSettings.value!
    // A changed account/network should return to checkout, before this session
    // is marked started. Keep the downloaded notes available for another wallet.
    await assertWallet(wallet.provider, selected, frozen)
    sessionAtomic.value = sendMode.value === 'auto' && await atomicBatchAvailable(wallet.provider, selected, frozen.chainId)
    sessionWallet.value = wallet; sessionAccount.value = selected
    const batches = reviewBatches.value
    progress.value = batches.flatMap((notes, i) => notes.map(note => ({ id: note.id, label: `${note.pool.denomination} ${note.pool.asset.symbol}`, status: 'ready' as const, depositBatch: i + 1 })))
    started.value = true
    status.value = 'Checking pool contracts and approvals…'
    await executeDepositSession({ notes: generated.value, provider: sessionWallet.value.provider, account: sessionAccount.value, settings: frozen,
      atomic: sessionAtomic.value, update, onBatch: (number, count, calls) => {
        const ids = new Set(batches[number - 1]!.map(note => note.id))
        const approvals: Progress[] = calls.filter(call => !ids.has(call.id)).map(call => ({ id: call.id, label: call.label, status: 'ready', depositBatch: number }))
        const position = progress.value.findIndex(row => ids.has(row.id))
        progress.value.splice(position, 0, ...approvals)
        status.value = sessionAtomic.value ? `Confirm batch ${number} of ${count} in your wallet…` : `Batch ${number} of ${count}: confirm each transaction in your wallet…`
      } })
  })
}
async function reviewWithdrawal() {
  await run(async () => {
    if (pending.value) { dialog.value = sessionKind.value; throw new Error('Check your pending session before starting another.') }
    parseNote(noteInput.value, chainId.value)
    if (!isAddress(recipient.value) || BigInt(recipient.value) === 0n) throw new Error('Enter a valid nonzero recipient address.')
    const frozen = settings(withdrawalRoute.value === 'paymaster')
    status.value = withdrawalRoute.value === 'relayer' ? 'Checking the RPC and TORN relayer route…' : 'Checking RPC and bundler connections…'
    const report = (message: string) => { status.value = message }
    quote.value = withdrawalRoute.value === 'relayer'
      ? await prepareRelayerWithdrawal(noteInput.value, recipient.value as Address, frozen, report)
      : await prepareWithdrawal(noteInput.value, recipient.value, frozen, report)
    sessionSettings.value = frozen; progress.value = []; started.value = false
    sessionKind.value = 'withdraw'; dialog.value = 'withdraw'
  })
}
async function sendWithdrawal() {
  await run(async () => {
    if (started.value) throw new Error('Check the current session before preparing another withdrawal.')
    if (!quote.value) throw new Error('Prepare a withdrawal review first.')
    const q = quote.value
    progress.value = [{ id: q.id, label: `${q.note.pool.denomination} ${q.note.pool.asset.symbol}`, status: 'ready' }]
    started.value = true; status.value = 'Submitting withdrawal…'
    if ('relayer' in q) await submitRelayerWithdrawal(q, sessionSettings.value!, update)
    else await submitWithdrawal(q, sessionSettings.value!, update)
  })
}
function switchTo4337() {
  if (busy.value || pending.value || started.value && dialog.value === 'withdraw') return
  withdrawalRoute.value = 'paymaster'; quote.value = null; dialog.value = null; error.value = ''
}
async function recheck() {
  await run(async () => {
    status.value = 'Checking submitted operations…'
    const frozen = sessionSettings.value!
    if (dialog.value === 'deposit') {
      const originalWallet = connected.value?.provider === sessionWallet.value?.provider && account.value?.toLowerCase() === sessionAccount.value?.toLowerCase()
      await reconcileDepositSession({ rows: progress.value, settings: frozen, provider: originalWallet ? sessionWallet.value!.provider : undefined,
        account: sessionAccount.value ?? undefined, update })
    } else {
      for (const row of progress.value.filter(p => (p.hash || p.relayerJobId) && p.status !== 'confirmed' && p.status !== 'failed')) {
        if (dialog.value === 'withdraw') {
          if (quote.value && 'relayer' in quote.value) {
            if (!row.relayerJobId) throw new Error('The relayer did not return a job ID. Check the original note before retrying.')
            await reconcileRelayerWithdrawal(quote.value, frozen, row.relayerJobId, update, 10_000)
          } else {
            const tx = await reconcileWithdrawal(frozen.bundlerUrl, row.hash!, 10_000)
            update(row.id, { status: 'confirmed', transactionHash: tx, message: undefined })
          }
        }
      }
    }
  })
}
function exportSession() {
  downloadText(`tornado-session-${Date.now()}.json`, JSON.stringify({ version: 1, network: sessionSettings.value?.chainId, kind: dialog.value,
    ...(dialog.value === 'deposit' && depositSeedPhrase.value ? { seedPhrase: depositSeedPhrase.value, recovery: SEED_BUNDLE_RECOVERY } : {}),
    notes: dialog.value === 'deposit' ? generated.value.map(n => ({ note: n.raw, id: n.id, ...(n.nonce !== undefined ? { nonce: n.nonce } : {}) })) : quote.value ? [{ note: quote.value.note.raw, id: quote.value.id, recipient: quote.value.recipient,
      route: quote.value.withdrawal.mode, ...('relayer' in quote.value ? { relayer: quote.value.relayer } : {}) }] : [], progress: progress.value }, null, 2))
}
async function importFile(event: Event) {
  await run(async () => {
    const file = (event.target as HTMLInputElement).files?.[0]
    if (!file) return
    try {
      if (file.size > 64_000) throw new Error('Choose a small plain-text note file (up to 64 KB).')
      noteInput.value = extractNoteStrings(await file.text()).join('\n')
      parseNote(noteInput.value, chainId.value)
    } finally { if (fileInput.value) fileInput.value.value = '' }
  })
}
async function loadStats() {
  const request = ++statsRequest
  const selected = statPool.value
  statsError.value = ''; depositCount.value = null
  if (!selected) { statsLoading.value = false; return }
  statsLoading.value = true
  try {
    const count = await publicClientFor({ chainId: chainId.value, rpcUrl: rpcUrl.value }).readContract({ address: selected.address, abi: poolAbi, functionName: 'nextIndex' })
    if (request === statsRequest) depositCount.value = count
  } catch { if (request === statsRequest) statsError.value = 'Pool activity unavailable. Try another RPC in Settings.' }
  finally { if (request === statsRequest) statsLoading.value = false }
}
function closeDialog() {
  if (busy.value) return
  dialog.value = dialog.value === 'wallets' ? walletReturn.value : null
  walletReturn.value = null; error.value = ''
}
function modalKey(event: KeyboardEvent) {
  if (event.key === 'Escape') closeDialog()
  if (event.key !== 'Tab' || !modalRoot.value) return
  const focusable = [...modalRoot.value.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], textarea:not([disabled])')]
  const first = focusable[0], last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
watch(dialog, async value => {
  if (value === 'wallets') walletDiscovery?.request()
  if (value) { lastFocus = document.activeElement as HTMLElement; await new Promise(resolve => setTimeout(resolve, 0)); modalRoot.value?.focus() }
  else lastFocus?.focus()
})
watch(chainId, () => { rpcUrl.value = NETWORKS[chainId.value].rpc; endpoint.value = ''; symbol.value = 'ETH'; resetSelection() })
watch(symbol, resetSelection)
watch(classicRelayerAvailable, available => {
  if (!available && withdrawalRoute.value === 'relayer' && !busy.value && !pending.value) withdrawalRoute.value = 'paymaster'
})
watch(overviewPools, pools => {
  if (!pools.some(pool => pool.denomination === denomination.value)) denomination.value = pools[0]?.denomination ?? ''
})
watch([statPool, rpcUrl, walletRevision], () => { void loadStats() }, { immediate: true })
function resetSelection() {
  overviewSymbol.value = symbol.value
  denomination.value = poolsFor(chainId.value, symbol.value)[0]?.denomination ?? '0.01'
  const ds = symbol.value === 'ETH' ? [...DENOMINATIONS] : poolsFor(chainId.value, symbol.value).map(p => p.denomination)
  quantities.value = Object.fromEntries(ds.map(d => [d, d === denomination.value ? 1 : 0])); error.value = ''
  recentPools.value = [denomination.value]; browsePools.value = false
}
function showCartPool(value: string) {
  overviewSymbol.value = symbol.value; denomination.value = value; browsePools.value = false
  recentPools.value = [value, ...recentPools.value.filter(d => d !== value)]
}
async function poolTabKey(event: KeyboardEvent, index: number) {
  const count = overviewCartTabs.value.length
  if (!count) return
  const next = event.key === 'ArrowRight' ? (index + 1) % count : event.key === 'ArrowLeft' ? (index + count - 1) % count
    : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null
  if (next === null) return
  event.preventDefault()
  const target = overviewCartTabs.value[next]!.pool
  showCartPool(target.denomination)
  await nextTick()
  document.getElementById(`pool-tab-${target.address}`)?.focus()
}
function changeQuantity(denomination: string, delta: -1 | 1) {
  const count = (quantities.value[denomination] ?? 0) + delta
  if (busy.value || !poolFor(chainId.value, denomination, symbol.value) || !Number.isSafeInteger(count) || count < 0) return
  quantities.value[denomination] = count
  if (delta > 0) showCartPool(denomination)
  else if (count === 0) {
    recentPools.value = recentPools.value.filter(d => d !== denomination)
    if (overviewSymbol.value === symbol.value && statPool.value?.denomination === denomination) {
      const next = recentPools.value.find(d => quantities.value[d]) ?? denominations.value.find(d => quantities.value[d])
      if (next) showCartPool(next)
    }
  }
}
function guardPendingSession(event: BeforeUnloadEvent) {
  if (pending.value || busy.value || flowBusy.value || flowPending.value) { event.preventDefault(); event.returnValue = '' }
}
onMounted(() => {
  walletConnection.startWatching()
  walletDiscovery = discoverWallets(option => {
    if (wallets.value.some(wallet => wallet.id === option.id || wallet.provider === option.provider)) return
    const wallet = { ...option, provider: markRaw(option.provider) }
    wallets.value.push(wallet)
  })
  window.addEventListener('beforeunload', guardPendingSession)
  window.addEventListener('hashchange', readPage)
  window.addEventListener('popstate', readPage)
})
onUnmounted(() => { walletDiscovery?.dispose(); walletConnection.dispose(); setWalletRpcSource(null, null); window.removeEventListener('beforeunload', guardPendingSession); window.removeEventListener('hashchange', readPage); window.removeEventListener('popstate', readPage) })
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" :href="appAssetUrl('./')" aria-label="Tornado home"><img :src="logoUrl" alt="" /><span>Tornado<small>NEW ERA</small></span></a>
      <nav aria-label="Main navigation"><a class="nav-link" :href="pageUrl('compliance')" :aria-current="page === 'compliance' ? 'page' : undefined" :aria-disabled="busy || pending || flowBusy || flowPending" @click.prevent="changePage('compliance')">Compliance</a><button class="nav-link" :disabled="busy || flowBusy" @click="dialog = 'help'">How it works <Icon name="arrow" :size="13" /></button></nav>
      <div class="header-controls">
        <label class="network-control"><span class="network-dot" :class="{ testnet: chainId === 11155111 }"></span><select v-model="chainId" :disabled="busy || pending || flowBusy || flowPending" aria-label="Network"><option :value="1">Ethereum</option><option :value="11155111">Sepolia</option></select></label>
        <button class="icon-button" aria-label="Settings" title="Settings" :disabled="busy || flowBusy || flowPending" @click="dialog = 'settings'"><Icon name="settings" /></button>
        <button class="button wallet-button" :aria-label="account ? `Connected wallet ${shorten(account)}` : 'Connect wallet'" :disabled="busy || flowBusy" @click="dialog = 'wallets'"><Icon name="wallet" /><span>{{ account ? shorten(account) : 'Connect wallet' }}</span></button>
      </div>
    </header>

    <main>
      <div v-if="page !== 'compliance'" class="intro"><div class="eyebrow"><span class="tiny-line"></span> Your privacy. You're in control.</div><h1>Classic Tornado pools<br /><span>More Options</span></h1><p>A new era of private transactions on Ethereum.</p></div>
      <div class="network-notice" v-if="chainId === 11155111"><Icon name="info" :size="16" /><span>You’re on Sepolia. Use test funds only.</span><span class="notice-tag">TESTNET</span></div>
      <div class="workspace" :class="{ 'compliance-workspace': page === 'compliance' }">
        <Compliance v-if="page === 'compliance'" :chain-id="chainId" :connection-key="`${chainId}:${rpcUrl}:${dataSourcesKey}:${walletRevision}`" :get-settings="() => settings(false)" @back="changePage('basic')" @settings="dialog = 'settings'" />
        <MultiWithdrawal v-if="multiOpened" v-show="page === 'multi'" :active="page === 'multi'" :wallet="connected && account ? { provider: connected.provider, account } : null" :chain-id="chainId" :wallet-revision="walletRevision" :connection-key="`${chainId}:${rpcUrl}:${bundler}:${endpoint}:${dataSourcesKey}`" :get-settings="() => settings(false)" @back="changePage('basic')" @manage="changePage('account')" @connect="dialog = 'wallets'" @settings="dialog = 'settings'" @reject-controller="rejectController" @activity="(active, unresolved) => { multiBusy = active; multiPending = unresolved }" />
        <ManageSmartAccount v-if="accountOpened" v-show="page === 'account'" :active="page === 'account'" :wallet="connected && account ? { provider: connected.provider, account } : null" :chain-id="chainId" :wallet-revision="walletRevision" :connection-key="`${chainId}:${rpcUrl}`" :get-settings="managementSettings" @back="changePage('multi')" @connect="dialog = 'wallets'" @settings="dialog = 'settings'" @reject-controller="rejectController" @activity="(active, unresolved) => { accountBusy = active; accountPending = unresolved }" />
        <section v-show="page === 'basic'" class="transaction-panel" aria-label="Transaction form">
          <div class="tabs" role="tablist" aria-label="Operation"><button id="deposit-tab" role="tab" :aria-selected="tab === 'deposit'" aria-controls="deposit-panel" :class="{ selected: tab === 'deposit' }" :disabled="busy" @click="tab = 'deposit'; error = ''"><Icon name="lock" />Deposit</button><button id="withdraw-tab" role="tab" :aria-selected="tab === 'withdraw'" aria-controls="withdraw-panel" :class="{ selected: tab === 'withdraw' }" :disabled="busy" @click="tab = 'withdraw'; error = ''"><Icon name="arrow" />Withdraw</button></div>
          <div v-if="tab === 'deposit'" id="deposit-panel" class="panel-body" role="tabpanel" aria-labelledby="deposit-tab">
            <div class="field-heading"><label for="token">Token</label><span class="subtle">{{ NETWORKS[chainId].name }} network</span></div>
            <div class="token-input"><span class="token-symbol" :class="{ ethereum: symbol === 'ETH' }">{{ symbol === 'ETH' ? 'Ξ' : symbol.slice(0, 1) }}</span><select id="token" v-model="symbol" :disabled="busy"><option v-for="a in assets" :key="a.symbol" :value="a.symbol">{{ a.symbol }}</option></select><span class="token-name">{{ symbol === 'ETH' ? 'Ether' : symbol }}</span><Icon name="down" :size="16" /></div>
            <div class="field-heading amount-heading"><span>Choose notes</span></div>
            <div class="note-cart">
              <div v-for="d in denominations" :key="d" class="cart-row" :class="{ 'in-cart': quantities[d], unavailable: !poolFor(chainId, d, symbol) }">
                <button class="cart-denomination" :disabled="!poolFor(chainId, d, symbol) || busy" :aria-label="`Show ${d} ${symbol} pool`" @click="showCartPool(d)"><span>{{ d }} <small>{{ symbol }}</small></span><small>{{ poolFor(chainId, d, symbol) ? 'per note' : 'Unavailable on Sepolia' }}</small></button>
                <div class="quantity-stepper" role="group" :aria-label="`${d} ${symbol} note quantity`">
                  <button type="button" :aria-label="`Remove one ${d} ${symbol} note`" :disabled="!poolFor(chainId, d, symbol) || busy || !quantities[d]" @click="changeQuantity(d, -1)">−</button>
                  <output :aria-label="`${d} ${symbol} notes selected`">{{ quantities[d] ?? 0 }}</output>
                  <button type="button" :aria-label="`Add one ${d} ${symbol} note`" :disabled="!poolFor(chainId, d, symbol) || busy" @click="changeQuantity(d, 1)">+</button>
                </div>
              </div>
            </div>
            <table class="deposit-cart-summary" aria-label="Deposit cart">
              <thead><tr><th scope="col">Your notes</th><th scope="col">Amount</th></tr></thead>
              <tbody><tr v-for="row in cart" :key="row.pool.address"><td>{{ row.count }} × {{ row.pool.denomination }} {{ symbol }}</td><td>{{ units(row.total, asset) }} {{ symbol }}</td></tr><tr v-if="!quantity"><td colspan="2" class="empty-cart">Add notes to your cart above.</td></tr></tbody>
              <tfoot><tr><th scope="row">Total deposit</th><td aria-live="polite">{{ units(total, asset) }} {{ symbol }}</td></tr></tfoot>
            </table>
            <p class="cart-batch-summary">{{ quantity }} note{{ quantity === 1 ? '' : 's' }}<template v-if="quantity"> · {{ batchCount }} batch{{ batchCount === 1 ? '' : 'es' }}</template><span>Up to {{ depositBatchLimit(asset) }} notes per batch. No session limit. Batches confirm one at a time.</span></p>
            <div class="inline-notice"><Icon name="file" :size="17" /><span>{{ bundleWithSeed ? 'One withdrawal note per deposit, backed up by one new seed phrase.' : quantity > 1 ? 'One independent note per deposit.' : 'Your note is your key to withdraw.' }} Download your backup before depositing.</span></div>
            <button class="button primary full" :disabled="busy || !quantity" @click="reviewDeposit"><span>{{ busy ? 'Preparing…' : 'Review deposit' }}</span><Icon name="arrow" /></button>
            <div class="seed-bundle-option"><div class="seed-bundle-toggle"><span id="seed-bundle-label">Bundle notes under a single seed phrase?</span><div class="seed-bundle-answers" role="radiogroup" aria-labelledby="seed-bundle-label" :aria-describedby="bundleWithSeed ? 'seed-bundle-description' : undefined"><label :class="{ selected: bundleWithSeed }"><input v-model="bundleWithSeed" type="radio" name="seed-bundle" :value="true" :disabled="busy || pending" />YES</label><label :class="{ selected: !bundleWithSeed }"><input v-model="bundleWithSeed" type="radio" name="seed-bundle" :value="false" :disabled="busy || pending" />NO</label></div></div><p v-if="bundleWithSeed" id="seed-bundle-description" class="input-hint">Generate a new 24-word seed phrase for this deposit session. All batches share the same phrase. Compatible wallets and services using the Kohaku SDK can use it to discover the notes. Your backup includes the phrase and every withdrawal note. Anyone with the phrase can spend the entire session. Withdraw here using individual notes.</p></div>
          </div>

          <div v-else id="withdraw-panel" class="panel-body" role="tabpanel" aria-labelledby="withdraw-tab">
            <button class="multi-withdraw-banner" :disabled="busy || pending" @click="changePage('multi')"><span>withdraw multiple notes at once? <span class="feature-label feature-label-new">NEW!</span></span><Icon name="arrow" :size="16" /></button>
            <div class="field-heading"><label for="note">Withdrawal note</label><button class="text-button" :disabled="busy" @click="fileInput?.click()"><Icon name="file" :size="14" /> Import .txt</button></div>
            <input ref="fileInput" type="file" accept=".txt,text/plain" hidden @change="importFile" />
            <textarea id="note" v-model="noteInput" :disabled="busy" rows="4" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="tornado-eth-0.1-1-0x…&#10;&#10;Paste one note to withdraw." />
            <p v-if="parsed.error" class="field-error" role="alert">{{ parsed.error }}</p><p v-else class="input-hint">{{ parsed.note ? `One valid note · one ${withdrawalRoute === 'relayer' ? 'transaction' : 'UserOperation'}` : 'Paste or import a single note. Keep your original backup.' }}</p>
            <div class="field-heading recipient-heading"><label for="recipient">Recipient address</label><span class="subtle">No wallet connection needed</span></div>
            <input id="recipient" v-model.trim="recipient" :disabled="busy" class="text-input address-input" placeholder="0x…" spellcheck="false" autocomplete="off" />
            <div class="field-heading recipient-heading"><span>Withdrawal route</span></div>
            <div class="withdrawal-routes" role="radiogroup" aria-label="Withdrawal route">
              <label :class="{ selected: withdrawalRoute === 'paymaster' }"><input v-model="withdrawalRoute" type="radio" value="paymaster" :disabled="busy || pending" /><span>4337 + paymaster</span></label>
              <label :class="{ selected: withdrawalRoute === 'relayer', unavailable: !classicRelayerAvailable }"><input v-model="withdrawalRoute" type="radio" value="relayer" :disabled="busy || pending || !classicRelayerAvailable" /><span>Classic TORN relayer<small>Original pools only. TORN surcharge.</small></span></label>
            </div>
            <p v-if="parsed.note && !classicRelayerAvailable" class="input-hint">Classic TORN relayers do not support this pool. Use 4337 for this denomination.</p>
            <template v-if="withdrawalRoute === 'paymaster'">
              <div class="field-heading recipient-heading"><label for="bundler">Bundler</label><span class="pill">ERC-4337</span></div>
              <div class="select-wrap"><select id="bundler" v-model="bundler" :disabled="busy" @change="endpoint = ''"><option value="pimlico">Pimlico</option><option value="custom">Custom endpoint</option></select><Icon name="down" :size="15" /><button class="text-button" :disabled="busy" @click="dialog = 'settings'">Configure</button></div>
              <p class="input-hint">Gas is paid from your note through the Tornado paymaster.</p>
            </template>
            <div v-else class="relayer-surcharge"><b>TORN relayer service surcharge</b><p>This route adds a service charge on top of the network fee, paid from your note. The exact percentage and amount are shown before confirmation. Availability depends on the network and pool.</p><div><button class="text-button" :disabled="busy || pending" @click="switchTo4337">Switch to 4337? <Icon name="arrow" :size="13" /></button><button class="text-button" :disabled="busy" @click="dialog = 'settings'">Configure RPC</button></div></div>
            <div v-if="parsed.note" class="withdraw-summary"><span>Note value</span><b>{{ parsed.note.pool.denomination }} {{ parsed.note.pool.asset.symbol }}</b><small>{{ withdrawalRoute === 'relayer' ? 'Relayer network fee and service surcharge will be quoted before you confirm.' : 'Paymaster fees will be quoted before you confirm.' }}</small></div>
            <div class="inline-notice"><Icon name="info" :size="17" /><span>{{ withdrawalRoute === 'relayer' ? 'Withdraw one full note at a time, less the network fee and relayer service surcharge. The relayer sends one transaction to your recipient.' : 'Withdraw one full note at a time, less the paymaster fee. Each withdrawal uses one UserOperation.' }}</span></div>
            <RecipientPrivacy :address="recipient" :active="page === 'basic' && tab === 'withdraw'" :disabled="busy" :settings="{ chainId, rpcUrl }" @loading="recipientPrivacyLoading = $event" />
            <button class="button primary full" :disabled="busy || recipientPrivacyLoading || !parsed.note || Boolean(parsed.error) || !isAddress(recipient) || BigInt(recipient) === 0n" @click="reviewWithdrawal"><span>{{ busy ? 'Preparing proof…' : 'Review withdrawal' }}</span><Icon name="arrow" /></button>
            <div v-if="inlineWithdrawalFeedback && status" class="status-banner" role="status"><span class="spinner"></span>{{ status }}</div>
            <div v-if="inlineWithdrawalFeedback && error" class="error-banner" role="alert"><Icon name="info" />{{ error }}<button class="icon-button" aria-label="Dismiss error" @click="error = ''"><Icon name="close" /></button></div>
            <p class="form-footnote"><Icon name="lock" :size="13" /> Proofs are generated locally in your browser.</p>
          </div>
        </section>

        <aside v-show="page !== 'compliance'" class="sidebar">
          <section class="pool-panel" aria-label="Pools overview">
            <div class="aside-heading"><span>Pools overview</span></div>
            <div v-if="overviewCartTabs.length" class="pool-tabs" role="tablist" aria-label="Pools in your deposit cart">
              <button v-for="(row, index) in overviewCartTabs" :id="`pool-tab-${row.pool.address}`" :key="row.pool.address" type="button" role="tab" aria-controls="pool-overview-details" :aria-selected="overviewTabId === `pool-tab-${row.pool.address}`" :tabindex="overviewTabId === `pool-tab-${row.pool.address}` || !overviewTabId && index === 0 ? 0 : -1" :class="{ selected: overviewTabId === `pool-tab-${row.pool.address}` }" @click="showCartPool(row.pool.denomination)" @keydown="poolTabKey($event, index)"><span>{{ row.pool.denomination }} {{ row.pool.asset.symbol }}</span><small v-if="row.count > 1" :aria-label="`${row.count} notes`">×{{ row.count }}</small></button>
            </div>
            <button v-if="overviewCartTabs.length" class="text-button pool-browse-toggle" :aria-expanded="browsePools" aria-controls="pool-browser" @click="browsePools = !browsePools">{{ browsePools ? 'Hide pool browser' : 'Browse all pools' }}<Icon name="down" :size="12" /></button>
            <div v-if="!overviewCartTabs.length || browsePools" id="pool-browser" class="pool-selectors">
              <label>Asset<div class="select-wrap"><select v-model="overviewSymbol" aria-label="Overview asset"><option v-for="a in assets" :key="a.symbol" :value="a.symbol">{{ a.symbol }}</option></select><Icon name="down" :size="13" /></div></label>
              <label>Denomination<div class="select-wrap"><select v-model="denomination" aria-label="Overview denomination"><option v-for="pool in overviewPools" :key="pool.address" :value="pool.denomination">{{ pool.denomination }} {{ pool.asset.symbol }}</option></select><Icon name="down" :size="13" /></div></label>
            </div>
            <p v-if="overviewCartTabs.length && !overviewTabId" class="input-hint">Viewing a pool outside your cart.</p>
            <div id="pool-overview-details" :role="overviewTabId ? 'tabpanel' : 'region'" :aria-labelledby="overviewTabId" :aria-label="overviewTabId ? undefined : `${denomination} ${overviewSymbol} pool`">
            <div class="pool-title"><span class="large-token">{{ overviewSymbol === 'ETH' ? 'Ξ' : overviewSymbol.slice(0, 1) }}</span><div><h2>{{ denomination }} {{ overviewSymbol }}</h2><span>{{ NETWORKS[chainId].name }} pool</span></div><a v-if="statPool" :href="`${NETWORKS[chainId].explorer}/address/${statPool.address}`" target="_blank" rel="noreferrer" aria-label="View pool contract"><Icon name="arrow" /></a></div>
            <div class="pool-metric" aria-live="polite" :aria-busy="statsLoading"><span>Total deposits <Icon name="info" :size="13" /></span><strong>{{ depositCount === null ? '—' : depositCount.toLocaleString() }}</strong><small>{{ statsLoading ? 'Reading current pool activity…' : depositCount === null ? 'Fetch the current pool activity.' : 'Lifetime deposits, not unique users.' }}</small></div>
            <p v-if="statsError" class="field-error">{{ statsError }}</p>
            <button class="button subtle-button full" :disabled="statsLoading || !statPool" @click="loadStats"><Icon name="refresh" :size="15" />{{ statsLoading ? 'Reading pool…' : 'Refresh pool activity' }}</button>
            </div>
          </section>
          <section class="explanation"><div class="section-kicker"><span>CLASSIC AT HEART</span><Icon name="shield" :size="18" /></div><h2>Same privacy.<br />More possibilities.</h2><div class="feature-line"><span>01</span><p>More denominations.<small>From 0.01 to 100 ETH on mainnet.</small></p></div><div class="feature-line"><span>02</span><p>Batch deposits &amp; withdrawals.<small>Deposit together. Withdraw up to 12 notes of one asset at once.</small></p></div><div class="feature-line"><span>03</span><p>A new withdrawal path.<small>Use a new 4337 + paymaster withdrawal relay path</small></p></div></section>
          <p class="privacy-note"><Icon name="info" :size="15" /><span>Timing, amounts, and reused recipients can link activity. HTTP services can see your IP address. Consider Tor Browser or a VPN for network privacy.</span></p>
          <DepositBalances v-if="page === 'basic' && tab === 'deposit'" :account="account" :wallet-revision="walletRevision" :asset="asset" :total="total" :settings="{ chainId, rpcUrl }" :active="!dialog" :disabled="busy || pending" @connect="chooseDepositWallet" />
        </aside>
      </div>
      <div v-if="started && progress.length && !dialog" class="session-banner"><Icon name="file"/><span>{{ allConfirmed ? 'Your last session is confirmed.' : 'You have a transaction session to review.' }}</span><button class="text-button" @click="dialog = sessionKind">Open session <Icon name="arrow" :size="13"/></button><button v-if="canStartNewDeposit" class="text-button" :disabled="busy || flowBusy || flowPending" @click="startNewDepositSession">Start a new deposit session?</button></div>
      <div v-if="status && !inlineWithdrawalFeedback" class="status-banner" role="status"><span class="spinner"></span>{{ status }}</div>
      <div v-if="error && !dialog && !inlineWithdrawalFeedback" class="error-banner" role="alert"><Icon name="info" />{{ error }}<button class="icon-button" aria-label="Dismiss error" @click="error = ''"><Icon name="close" /></button></div>
      <footer><span><img :src="logoUrl" alt="" />Privacy is a right.</span><div><span class="footer-version">NEW ERA / V0.1</span><button class="text-button" @click="dialog = 'help'">About this interface <Icon name="arrow" :size="13" /></button></div></footer>
    </main>

    <div v-if="dialog" class="modal-backdrop" @mousedown.self="closeDialog">
      <section ref="modalRoot" class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1" @keydown="modalKey">
        <header class="modal-header"><div><span class="eyebrow">TORNADO / NEW ERA</span><h2 id="modal-title">{{ dialog === 'settings' ? 'Connection settings' : dialog === 'wallets' ? 'Connect a wallet' : dialog === 'help' ? 'Classic, with a new path.' : started ? allConfirmed ? 'All confirmed' : 'Session progress' : dialog === 'deposit' ? 'Deposit checkout' : 'Review withdrawal' }}</h2></div><button class="icon-button" :disabled="busy" aria-label="Close dialog" @click="closeDialog"><Icon name="close" /></button></header>
        <template v-if="dialog === 'settings'">
          <p class="modal-description">Connection details stay in memory. All endpoints are contacted directly from your browser.</p>
          <label class="stack-label">{{ NETWORKS[chainId].name }} RPC<input :disabled="busy" v-model="rpcUrl" class="text-input" spellcheck="false" placeholder="https://…" aria-describedby="rpc-usage" /><small id="rpc-usage" class="rpc-usage">Reads prefer your connected wallet on this network. This RPC is the fallback, and is used when no matching wallet is connected. Wallet transactions use your wallet’s provider.</small></label>
          <label class="stack-label">Withdrawal bundler<select :disabled="busy" v-model="bundler" class="text-input" @change="endpoint = ''"><option value="pimlico">Pimlico</option><option value="custom">Custom</option></select></label>
          <label class="stack-label">Bundler endpoint <span class="subtle">{{ bundler === 'pimlico' ? '(optional)' : '(required)' }}</span><input :disabled="busy" v-model="endpoint" type="password" class="text-input" autocomplete="off" :placeholder="bundler === 'pimlico' ? 'Default: public.pimlico.io' : 'https://…'" /></label>
          <p class="input-hint">Use a browser-compatible endpoint for the selected network. RPCs, bundlers, relayers, and history/artifact hosts can see your IP address and requests. Consider Tor Browser or a VPN for network privacy. Wallet apps and extensions may need separate routing. Bundler keys are visible to this browser.</p>
          <label class="stack-label settings-deposit-execution">Deposit execution<select :disabled="busy" v-model="sendMode" class="text-input"><option value="auto">Wallet-native batch when available</option><option value="sequential">Sequential transactions</option></select></label>
          <details class="advanced-sources">
            <summary>Advanced: history &amp; artifact sources</summary>
            <p class="input-hint">Optional helpers for faster sync and backup downloads. Bundled history and proving files are always tried first. Turn both helpers off to use bundled files and RPC. Changes stay in this browser session.</p>
            <label class="source-toggle"><input id="use-saga-source" v-model="useSaga" type="checkbox" :disabled="busy" />Use Saga history</label>
            <label class="stack-label">{{ NETWORKS[chainId].name }} Saga URL<input id="saga-source-url" v-model="sagaUrls[chainId]" :disabled="busy || !useSaga" class="text-input" type="url" spellcheck="false" autocomplete="off" /><small class="rpc-usage">Base directory containing index.json. Sepolia normally uses /sepolia/. The endpoint must allow browser requests.</small></label>
            <label class="source-toggle"><input id="use-artifact-backups" v-model="useRemoteArtifacts" type="checkbox" :disabled="busy" />Use remote artifact backups</label>
            <label class="stack-label">Artifacts base URL<input id="artifacts-source-url" v-model="artifactsUrl" :disabled="busy || !useRemoteArtifacts" class="text-input" type="url" spellcheck="false" autocomplete="off" /><small class="rpc-usage">Mirror root containing tornado-history/v1/, sync-cache/v2/saga/ and, for a custom mirror, proving/. Pinned checksums remain enforced.</small></label>
            <button class="text-button" :disabled="busy" @click="resetDataSources">Reset sources to defaults</button>
          </details>
          <button class="button primary full" :disabled="busy" @click="run(async () => { await validateConnections(settings()); status = 'Connections verified'; dialog = null })">Verify &amp; save for this session</button>
        </template>
        <template v-else-if="dialog === 'wallets'">
          <button v-if="walletReturn === 'deposit'" class="text-button deposit-wallet-back" :disabled="busy" @click="closeDialog"><Icon name="back" :size="15" />Back to deposit</button>
          <p class="modal-description">{{ walletReturn === 'deposit' ? 'Choose a paying wallet, or switch accounts in your wallet app. Your generated notes and saved backup stay the same.' : page === 'basic' ? 'Connect a wallet to deposit. Single-note withdrawals do not require a connected wallet.' : 'Connect an EOA controller that can sign typed data. Contract-wallet controllers are not supported.' }}</p><div v-if="!wallets.length" class="empty-state"><Icon name="wallet" :size="28" /><h3>No browser wallet detected</h3><p>Open this app in a wallet browser or enable an injected wallet extension. Standalone WalletConnect and Safe Apps are not integrated yet.</p></div><button v-for="wallet in wallets" :key="wallet.id" class="wallet-option" :disabled="busy" @click="connect(wallet)"><Icon name="wallet" /><span>{{ wallet.name }}</span><Icon name="arrow" /></button><button v-if="account" class="button full" :disabled="busy" @click="disconnectWallet">Disconnect this interface</button>
        </template>
        <template v-else-if="dialog === 'help'">
          <p class="modal-description">A new interface for existing Tornado pools, built with the Kohaku SDK.</p>
          <div class="help-item"><Icon name="layers" /><div><h3>New denominations.</h3><p>Classic denominations use the existing pools with large anonymity sets. New ETH denominations (0.01, 0.03, 0.3, 3, 30) sit alongside them, with younger anonymity sets and easier note-packing.</p></div></div>
          <div class="help-item"><Icon name="layers" /><div><h3>Batch deposits &amp; withdrawals.</h3><p>Compatible wallets can deposit atomically. Otherwise, confirm deposits one transaction at a time. Withdraw one note without a connected wallet, or connect a wallet to withdraw up to 12 notes of the same asset at once.</p></div></div>
          <div class="help-item"><Icon name="shield" /><div><h3>You choose the bundler.</h3><p>Choose 4337 with Pimlico or a custom bundler, or a Classic TORN relayer for single notes. Fees come from the withdrawn asset. Classic relayers add a service surcharge, shown before confirmation.</p></div></div>
          <div class="help-item"><Icon name="file" /><div><h3>Your notes are your backup.</h3><p>Optionally bundle deposit notes under one seed phrase. Compatible wallets and services using the Kohaku SDK can use it to find your notes.</p></div></div>
        </template>
        <template v-else-if="!started && dialog === 'deposit'">
          <div class="review-total"><span>{{ generated.length }} {{ depositSeedPhrase ? 'seed-backed' : 'independent' }} note{{ generated.length === 1 ? '' : 's' }}</span><strong>{{ units(generated.reduce((s, n) => s + n.pool.amount, 0n), generated[0]!.pool.asset) }} {{ generated[0]!.pool.asset.symbol }}</strong><small>{{ NETWORKS[sessionSettings!.chainId].name }} · gas paid by your wallet</small></div>
          <div class="note-breakdown"><div v-for="(n, i) in generated" :key="n.id"><span>Note {{ String(i + 1).padStart(2, '0') }}</span><b>{{ n.pool.denomination }} {{ n.pool.asset.symbol }}</b></div></div>
          <div class="checkout-step-heading"><span class="checkout-step-number" aria-hidden="true">1</span><h3>Save your backup</h3><small v-if="backupDownloaded && backupAcknowledged"><Icon name="check" :size="13" />Saved</small></div>
          <p v-if="depositSeedPhrase" class="input-hint">Download one backup file containing the seed phrase and all individual notes. Anyone with the phrase can spend all of these notes; anyone with a note string can spend that note. To withdraw here, copy one note line.</p>
          <button class="button full backup-button" @click="downloadNotes"><Icon :name="backupDownloaded ? 'check' : 'download'" />{{ backupDownloaded ? 'Download backup again' : depositSeedPhrase ? 'Download seed phrase & notes (.txt)' : 'Download withdrawal notes (.txt)' }}</button>
          <label class="acknowledge"><input v-model="backupAcknowledged" type="checkbox" :disabled="!backupDownloaded" /><span>{{ depositSeedPhrase ? 'I saved the seed phrase and withdrawal notes in a safe place.' : 'I saved every note in a safe place. Losing a note means losing access to its deposit.' }}</span></label>
          <DepositBalances :account="account" :wallet-revision="walletRevision" :asset="generated[0]!.pool.asset" :total="generated.reduce((sum, note) => sum + note.pool.amount, 0n)" :settings="sessionSettings!" :active="true" :disabled="busy" review @connect="chooseDepositWallet" />
          <p class="input-hint">{{ sendMode === 'auto' && canBatch ? `${reviewBatches.length} wallet batch${reviewBatches.length === 1 ? '' : 'es'}, with up to ${depositBatchLimit(generated[0]!.pool.asset)} notes each. Each batch confirms before the next starts.` : 'Sequential mode: one wallet transaction per deposit, plus any token approvals.' }} Token approvals use exact amounts for each batch.{{ depositSeedPhrase ? ' Every batch shares the seed phrase in your backup.' : '' }}</p>
          <button class="button primary full" :disabled="busy || !backupDownloaded || !backupAcknowledged || !account" @click="sendDeposits">Confirm deposit <Icon name="arrow" /></button>
        </template>
        <template v-else-if="!started && dialog === 'withdraw' && quote">
          <p class="modal-description">1 note · 1 {{ relayerQuote ? 'relayer transaction' : 'UserOperation' }} · {{ NETWORKS[sessionSettings!.chainId].name }}</p><div class="recipient-review"><span>Recipient</span><code>{{ quote.recipient }}</code></div>
          <div v-if="relayerQuote" class="recipient-review"><span>TORN relayer</span><code>{{ relayerQuote.relayer.ensName }}</code><p class="input-hint">{{ relayerQuote.relayer.url }}</p></div>
          <div class="quote-card"><div><span>Note value</span><b>{{ quote.note.pool.denomination }} {{ quote.note.pool.asset.symbol }}</b></div>
            <template v-if="relayerQuote"><div><span>Network fee</span><span>−{{ units(relayerQuote.networkFee, quote.note.pool.asset) }} {{ quote.note.pool.asset.symbol }}</span></div><div class="surcharge-row"><span>Relayer service surcharge ({{ relayerQuote.relayer.serviceFeeBps / 100 }}%)</span><span>−{{ units(relayerQuote.serviceFee, quote.note.pool.asset) }} {{ quote.note.pool.asset.symbol }}</span></div><div><span>Total fee</span><b>−{{ units(quote.fee, quote.note.pool.asset) }} {{ quote.note.pool.asset.symbol }}</b></div></template>
            <div v-else><span>Maximum paymaster fee</span><span>−{{ units(quote.fee, quote.note.pool.asset) }} {{ quote.note.pool.asset.symbol }}</span></div><div class="net-row"><span>{{ relayerQuote ? 'Recipient receives' : 'Recipient receives at least' }}</span><b>{{ units(quote.net, quote.note.pool.asset) }} {{ quote.note.pool.asset.symbol }}</b></div></div>
          <div v-if="relayerQuote" class="relayer-surcharge"><p>The relayer service surcharge applies only to this route. You can avoid it with 4337; network fees differ between routes.</p><button class="text-button" :disabled="busy" @click="switchTo4337">Switch to 4337? <Icon name="arrow" :size="13" /></button></div>
          <p v-else class="input-hint">Your recipient receives the withdrawal directly. Any unused-gas refund is sent to the same address.</p><p v-if="fallbackGas" class="input-hint">Bundler estimation was unavailable. This quote uses the SDK’s fallback gas limits; unused gas is refunded to your recipient.</p><button class="button primary full" :disabled="busy" @click="sendWithdrawal">Confirm withdrawal <Icon name="arrow" /></button>
        </template>
        <template v-else>
          <p class="modal-description">{{ progress.filter(p => p.status === 'confirmed').length }} / {{ progress.length }} {{ dialog === 'withdraw' ? relayerQuote ? 'relayer transaction confirmed.' : 'UserOperation confirmed.' : 'calls confirmed.' }} {{ pending ? 'Keep your original notes and check pending submissions before retrying.' : 'Your session records are available to download.' }}</p>
          <div class="progress-list"><div v-for="p in progress" :key="p.id" class="progress-item"><div><b>{{ p.label }}<small v-if="p.depositBatch" class="progress-batch">Batch {{ p.depositBatch }}</small></b><span class="progress-state" :class="p.status">{{ p.status.replace('-', ' ') }}</span></div>
            <a v-if="p.transactionHash" class="transaction-link" :href="`${NETWORKS[sessionSettings!.chainId].explorer}/tx/${p.transactionHash}`" target="_blank" rel="noopener noreferrer" :title="`View transaction ${p.transactionHash} on Etherscan`"><code>{{ shorten(p.transactionHash) }}</code><Icon name="arrow" :size="12" /></a>
            <code v-else-if="p.hash">{{ shorten(p.hash) }}</code><code v-if="p.batchId">Batch {{ shorten(p.batchId) }}</code><code v-if="p.relayerJobId">Relayer job {{ p.relayerJobId }}</code><p v-if="p.message">{{ p.message }}</p></div></div>
          <button class="button full" :disabled="busy" @click="exportSession"><Icon name="download" />{{ dialog === 'withdraw' ? 'Download session & note' : 'Download session & notes' }}</button><button v-if="pending" class="button full" :disabled="busy" @click="recheck"><Icon name="refresh" />{{ dialog === 'withdraw' ? relayerQuote ? 'Check relayer job' : 'Check UserOperation' : 'Check submitted operations' }}</button>
          <button v-if="dialog === 'deposit' && canStartNewDeposit" class="button primary full" :disabled="busy" @click="startNewDepositSession">Start a new deposit session? <Icon name="arrow" /></button>
          <p v-if="progress.some(p => p.status === 'ready') && !busy" class="input-hint">{{ dialog === 'withdraw' ? 'This withdrawal was not submitted. Prepare a new review before trying again.' : 'Unsubmitted calls were stopped. Start a new session for the remaining deposits after checking submitted operations.' }}</p>
        </template>
        <div v-if="error" class="error-banner modal-error" role="alert"><Icon name="info" />{{ error }}</div><div v-if="busy" class="modal-status" role="status"><span class="spinner"></span>{{ status || 'Working…' }}</div>
      </section>
    </div>
  </div>
</template>
