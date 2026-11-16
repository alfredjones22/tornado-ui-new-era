import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { offlineFiles, verifyOfflineBytes } from './offline-assets.mjs'

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
const base = new URL('https://gateway.example/ipfs/build-check/')
const checked = new Set()
function resource(reference, owner) {
  if (reference.startsWith('data:')) return
  assert(!reference.startsWith('/'), `${owner}: root-relative resource ${reference}`)
  const url = new URL(reference, new URL(owner, base))
  assert(url.href.startsWith(base.href), `${owner}: resource escapes the CID directory`)
  const file = decodeURIComponent(url.pathname.slice(base.pathname.length))
  assert(statSync(resolve(directory, file)).isFile(), `${owner}: missing resource ${file}`)
  checked.add(file)
}
function files(path = directory) {
  return readdirSync(path).flatMap(name => {
    const file = resolve(path, name)
    return statSync(file).isDirectory() ? files(file) : [file]
  })
}
for (const file of ['index.html', 'compliance/index.html', 'withdraw-frame.html']) {
  const html = readFileSync(resolve(directory, file), 'utf8')
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) resource(match[1], file)
}
for (const file of files()) {
  const owner = relative(directory, file).replaceAll('\\', '/')
  if (file.endsWith('.css')) {
    for (const match of readFileSync(file, 'utf8').matchAll(/url\(["']?([^"')]+)["']?\)/g)) resource(match[1], owner)
  }
  if (file.endsWith('.js')) {
    const js = readFileSync(file, 'utf8')
    assert(!/["'`]\/(?:assets\/|fonts\/|sdk\/|logo\.svg)/.test(js), `${owner}: root-relative application asset`)
    for (const match of js.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g)) resource(match[1], owner)
  }
}
for (const file of ['logo.svg', 'fonts/PTMono-Regular.woff2', 'fonts/PTMono-Bold.woff2',
  'sdk/state-manager.worker.js', 'sdk/merkle-tree-worker.browser.js', 'sdk/msm-worker.browser.js']) resource(`./${file}`, 'index.html')
for (const descriptor of offlineFiles()) {
  resource(`./offline/${descriptor.target}`, 'index.html')
  verifyOfflineBytes(readFileSync(resolve(directory, 'offline', descriptor.target)), descriptor)
}
const all = files(), bytes = all.reduce((total, file) => total + statSync(file).size, 0)
console.log(`IPFS build checked: ${all.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MiB; ${checked.size} local resource paths stay inside the CID directory.`)
