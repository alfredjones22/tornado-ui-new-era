import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { readOfflineAssets } from './scripts/offline-assets.mjs'

// Ship the SDK's self-contained browser workers verbatim. Their sibling worker
// URLs must remain relative; running them through the app bundler breaks those.
const sdkDist = resolve(dirname(createRequire(import.meta.url).resolve('@kohaku-eth/tornado-cash/package.json')), 'dist')
const workers = ['state-manager.worker.js', 'merkle-tree-worker.browser.js', 'msm-worker.browser.js']

export default defineConfig({
  // The CID/gateway prefix is unknown at build time. Vite rebases HTML, CSS
  // (including public fonts) and imported assets relative to each output file.
  base: './',
  plugins: [vue(), {
    name: 'kohaku-browser-workers',
    configureServer(server) {
      const offline = new Map(readOfflineAssets().map(file => [`/${file.fileName}`, file.bytes]))
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/offline/')) {
          const asset = offline.get(req.url)
          if (!asset) return next()
          res.setHeader('Content-Type', 'application/gzip')
          res.end(asset)
          return
        }
        const file = req.url?.replace(/^\/sdk\//, '')
        if (!req.url?.startsWith('/sdk/') || !file || !workers.includes(file)) return next()
        res.setHeader('Content-Type', 'text/javascript')
        res.end(readFileSync(resolve(sdkDist, file)))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'LICENSE.classic', source: readFileSync(resolve('LICENSE.classic')) })
      for (const file of workers) this.emitFile({ type: 'asset', fileName: `sdk/${file}`, source: readFileSync(resolve(sdkDist, file)) })
      for (const file of readOfflineAssets()) this.emitFile({ type: 'asset', fileName: file.fileName, source: file.bytes })
    },
  }],
  build: { target: 'es2022', rolldownOptions: { input: { app: resolve('index.html'), compliance: resolve('compliance/index.html'), withdraw: resolve('withdraw-frame.html') } } },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@kohaku-eth/tornado-cash'] },
})
