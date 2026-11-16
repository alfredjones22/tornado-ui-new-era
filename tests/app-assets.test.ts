import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appAssetUrl } from '../src/core/app-assets'

beforeEach(() => vi.stubEnv('BASE_URL', './'))
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('portable application asset paths', () => {
  it.each([
    ['https://gateway.example/ipfs/bafy-test/', 'https://gateway.example/ipfs/bafy-test/'],
    ['https://gateway.example/ipfs/bafy-test/index.html#multi-withdraw', 'https://gateway.example/ipfs/bafy-test/'],
    ['https://gateway.example/ipfs/bafy-test/withdraw-frame.html?test=1', 'https://gateway.example/ipfs/bafy-test/'],
    ['https://gateway.example/ipns/example.eth/#smart-account', 'https://gateway.example/ipns/example.eth/'],
    ['https://bafy-test.ipfs.gateway.example/#multi-withdraw', 'https://bafy-test.ipfs.gateway.example/'],
    ['https://example.eth.link/', 'https://example.eth.link/'],
    ['http://localhost:4174/', 'http://localhost:4174/'],
    ['https://gateway.example/ipfs/bafy-test/compliance/', 'https://gateway.example/ipfs/bafy-test/'],
    ['https://gateway.example/ipns/example.eth/compliance/index.html', 'https://gateway.example/ipns/example.eth/'],
    ['https://example.eth.limo/compliance', 'https://example.eth.limo/'],
  ])('keeps iframe, logo and workers inside the app directory at %s', (page, directory) => {
    vi.stubGlobal('location', new URL(page))
    for (const file of ['logo.svg', 'withdraw-frame.html', 'sdk/state-manager.worker.js', 'offline/history/1/pool.json.gz', 'compliance/']) expect(appAssetUrl(file)).toBe(directory + file)
  })
  it('also respects an explicitly configured absolute base path', () => {
    vi.stubGlobal('location', new URL('https://example.com/current/withdraw-frame.html'))
    vi.stubEnv('BASE_URL', '/configured/')
    expect(appAssetUrl('sdk/state-manager.worker.js')).toBe('https://example.com/configured/sdk/state-manager.worker.js')
  })
})
