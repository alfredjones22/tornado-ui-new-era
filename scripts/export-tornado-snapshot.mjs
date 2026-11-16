import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

const usage = `Export public Tornado history from an existing kohaku-cli wallet (Node 22+).

node scripts/export-tornado-snapshot.mjs --wallet-dir <directory> --chain-id <1|11155111> --out-dir <directory>

Prompts for the wallet password without echoing it. Reads tc-storage.json only;
never changes the wallet or connects to the network. Outputs JSON and JSON.gz.
Refresh Tornado in the CLI first if you want a recent snapshot.`

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Tornado state object.')
  return value
}

function parseJson(value, label) {
  try { return JSON.parse(value) } catch { throw new Error(`Invalid JSON in ${label}.`) }
}

// Copy only known public fields, including inside individual event records.
// Never copy an entire SDK slice: stored legacySecrets contains spendable notes.
function fields(value, names) {
  const input = record(value), result = {}
  for (const name of names) {
    const item = input[name]
    if (item === undefined) continue
    if (!['string', 'number', 'boolean'].includes(typeof item)) throw new Error('Invalid public Tornado field.')
    result[name] = item
  }
  return result
}

function tuples(value, mapper) {
  if (!Array.isArray(value)) throw new Error('Missing Tornado event or metadata collection. Refresh the CLI wallet first.')
  return value.map(pair => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') throw new Error('Invalid Tornado tuple.')
    return [pair[0], mapper(pair[1])]
  })
}

function unsigned(value) {
  if (typeof value !== 'string' || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) throw new Error('Invalid Tornado numeric field.')
  return BigInt(value)
}

export function decryptCliStore(envelope, password) {
  const data = record(envelope)
  if (data.v !== 1 || !['salt', 'iv', 'tag', 'ciphertext'].every(k => typeof data[k] === 'string')) {
    throw new Error('Expected an encrypted kohaku-cli v1 tc-storage.json file.')
  }
  if (!password) throw new Error('The wallet password cannot be empty.')
  let plaintext
  try {
    const key = pbkdf2Sync(password, Buffer.from(data.salt, 'base64'), 310_000, 32, 'sha256')
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(data.tag, 'base64'))
      plaintext = Buffer.concat([decipher.update(Buffer.from(data.ciphertext, 'base64')), decipher.final()]).toString('utf8')
    } finally { key.fill(0) }
  } catch { throw new Error('Could not decrypt tc-storage.json: wrong password or damaged file.') }
  return record(parseJson(plaintext, 'decrypted CLI storage'))
}

export function extractPublicSnapshot(store, chainId) {
  if (![1, 11155111].includes(chainId)) throw new Error('Use chain ID 1 or 11155111.')
  const entries = Object.entries(record(store)).filter(([key]) => new RegExp(`^(?:sig:)?tornado-cash-state-${chainId}-[0-9]+$`).test(key))
  // Both derivation copies contain public history. Prefer the normal SDK key;
  // do not combine separate copies and accidentally duplicate event records.
  const keys = [...new Set(entries.map(([key]) => key.replace(/^sig:/, '')))]
  if (keys.length !== 1) throw new Error('Expected one Tornado registry for this network. Run balances --include tornado --refresh for the matching wallet first.')
  const key = keys[0]
  let stored = store[key] ?? store[`sig:${key}`]
  if (typeof stored !== 'string') {
    if (record(stored).codec !== 'kohaku-gzip-v1' || typeof stored.data !== 'string') throw new Error('Unknown CLI storage compression format.')
    try { stored = gunzipSync(Buffer.from(stored.data, 'base64')).toString('utf8') }
    catch { throw new Error('Could not decompress Tornado state.') }
  }
  const state = record(parseJson(stored, 'Tornado state'))
  const info = record(state.instanceRegistryInfo)
  if (unsigned(info.chainId) !== BigInt(chainId) || unsigned(record(info.instanceRegistry).address) !== BigInt(key.split('-').at(-1))) {
    throw new Error('Tornado chain or registry metadata does not match the requested network.')
  }
  const pools = tuples(record(state.pools).poolsTuples, pool => fields(pool, [
    'address', 'asset', 'isERC20', 'protocolFeePercentage', 'denomination', 'registeredBlock',
    'state', 'rootHistorySize', 'extended', 'lastSyncedBlock',
  ]))
  if (!pools.length || pools.some(([address, pool]) => unsigned(address) !== unsigned(pool.address) ||
    pool.lastSyncedBlock === undefined || unsigned(pool.lastSyncedBlock) < unsigned(pool.registeredBlock))) {
    throw new Error('A pool has no valid sync checkpoint. Refresh Tornado using the current CLI before exporting.')
  }
  const deposits = tuples(record(state.deposits).depositsTuples, events => tuples(events, event => fields(event, [
    'blockNumber', 'transactionHash', 'pool', 'commitment', 'leafIndex', 'timestamp',
  ])))
  const withdrawals = tuples(record(state.withdrawals).withdrawalsTuples, event => fields(event, [
    'blockNumber', 'transactionHash', 'pool', 'to', 'nullifierHash', 'relayer', 'fee',
  ]))
  const assets = tuples(record(state.assets).assetsTuples, asset => fields(asset, ['name', 'decimals', 'address', 'symbol']))
  const snapshot = { [key]: {
    deposits: { depositsTuples: deposits }, withdrawals: { withdrawalsTuples: withdrawals },
    assets: { assetsTuples: assets }, pools: { poolsTuples: pools },
    relayers: { relayersTuples: [], feeConfig: { minFee: 0.01, maxFee: 0.3 } },
    instanceRegistryInfo: {
      ...fields(info, ['chainId', 'ensSubdomainKey', 'useExtendedEthPools']),
      instanceRegistry: fields(info.instanceRegistry, ['address', 'deploymentBlock', 'lastDeployedOnBlock']),
      relayerRegistry: fields(info.relayerRegistry, ['address', 'deploymentBlock']),
      aggregator: fields(info.aggregator, ['address']),
    },
    sync: fields(state.sync, ['lastSyncedBlock', 'relayerRegistrySyncedBlock']),
  } }
  const cursors = pools.map(([, pool]) => unsigned(pool.lastSyncedBlock))
  const summary = {
    chainId, pools: pools.length,
    deposits: deposits.reduce((count, [, events]) => count + events.length, 0), withdrawals: withdrawals.length,
    oldestPoolCheckpoint: cursors.reduce((a, b) => a < b ? a : b).toString(),
    newestPoolCheckpoint: cursors.reduce((a, b) => a > b ? a : b).toString(),
  }
  return { snapshot, summary }
}

function promptPassword() {
  if (!process.stdin.isTTY) throw new Error('Run this interactively to enter the wallet password; it is not accepted in arguments or environment variables.')
  process.stderr.write('Wallet password: ')
  const output = new Writable({ write(_chunk, _encoding, done) { done() } })
  const prompt = createInterface({ input: process.stdin, output, terminal: true })
  return new Promise((resolvePassword, reject) => {
    prompt.once('SIGINT', () => { prompt.close(); reject(new Error('Export cancelled.')) })
    prompt.question('', answer => { prompt.close(); process.stderr.write('\n'); resolvePassword(answer) })
  })
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) { console.log(usage); return }
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!['--wallet-dir', '--chain-id', '--out-dir'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) {
      throw new Error(usage)
    }
    options[args[i]] = args[i + 1]
  }
  if (!['--wallet-dir', '--chain-id', '--out-dir'].every(key => options[key])) throw new Error(usage)
  const chainId = Number(options['--chain-id'])
  if (![1, 11155111].includes(chainId)) throw new Error('Use chain ID 1 or 11155111.')
  const inputPath = resolve(options['--wallet-dir'], 'tc-storage.json')
  const directory = resolve(options['--out-dir'])
  const outputPath = resolve(directory, `tornado-${chainId === 1 ? 'mainnet' : 'sepolia'}.json`)
  if (existsSync(outputPath) || existsSync(`${outputPath}.gz`)) throw new Error('Output already exists; choose a new output directory.')
  const envelope = parseJson(readFileSync(inputPath, 'utf8'), 'encrypted tc-storage.json')
  const password = await promptPassword()
  const { snapshot, summary } = extractPublicSnapshot(decryptCliStore(envelope, password), chainId)
  const json = `${JSON.stringify(snapshot)}\n`
  const gzip = gzipSync(json, { level: 9 })
  mkdirSync(directory, { recursive: true })
  writeFileSync(outputPath, json, { flag: 'wx', mode: 0o600 })
  writeFileSync(`${outputPath}.gz`, gzip, { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ ...summary, jsonBytes: Buffer.byteLength(json), gzipBytes: gzip.length,
    sha256: createHash('sha256').update(json).digest('hex'), output: outputPath, compressedOutput: `${outputPath}.gz`,
  }, null, 2))
  console.log('Exported public history only. Check pool coverage before treating this as a complete network snapshot.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
