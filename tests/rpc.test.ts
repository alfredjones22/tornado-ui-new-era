import { afterEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { checkedUrl, jsonRpc, safeError, sdkNetwork, validateConnections } from '../src/core/rpc'
import { TornadoPaymasterConfigs } from '@kohaku-eth/tornado-cash'
afterEach(() => vi.unstubAllGlobals())
describe('connection configuration', () => {
  it('allows HTTPS and local development HTTP only', () => {
    expect(checkedUrl('https://example.com/rpc')).toBe('https://example.com/rpc')
    expect(checkedUrl('http://127.0.0.1:8545')).toBe('http://127.0.0.1:8545/')
    for (const value of ['http://example.com', 'javascript:alert(1)', 'https://user:pass@example.com']) expect(() => checkedUrl(value)).toThrow()
  })
  it('checks chain ID and the configured EntryPoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_, init: RequestInit) => {
      const { method } = JSON.parse(init.body as string)
      return Response.json({ result: method === 'eth_supportedEntryPoints' ? [TornadoPaymasterConfigs[1].entryPointAddress] : '0x1' })
    }))
    const settings = { chainId: 1 as const, rpcUrl: 'https://example.com', bundler: 'pimlico' as const, bundlerUrl: 'https://example.com' }
    await expect(validateConnections(settings)).resolves.toBeUndefined()
    await expect(validateConnections({ ...settings, chainId: 11155111 })).rejects.toThrow('different network')
  })
  it('rejects bundlers without EntryPoint v0.8', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_, init: RequestInit) => Response.json({ result: JSON.parse(init.body as string).method === 'eth_supportedEntryPoints' ? [] : '0x1' })))
    await expect(validateConnections({ chainId: 1, rpcUrl: 'https://example.com', bundler: 'custom', bundlerUrl: 'https://example.com' })).rejects.toThrow('EntryPoint v0.8')
  })
  it('redacts private notes and credential-bearing URLs from errors', () => {
    const message = safeError(new Error(`Error tornado-eth-1-1-0x${'aa'.repeat(62)} https://example.com/secret-key`))
    expect(message).not.toContain('secret-key'); expect(message).not.toContain('tornado-eth'); expect(message).toContain('[private note]')
  })
  it('redacts private key material from SDK error messages', () => {
    const key = '01'.repeat(32)
    expect(safeError(new Error(`Invalid key 0x${key}`))).not.toContain(key)
    expect(safeError(new Error(`Invalid key ${key}`))).not.toContain(key)
  })
  it('preserves errors serialized by the SDK worker and errors from other realms', () => {
    const serialized = { name: 'Error', message: 'Tornado paymaster gas estimation failed: AA31 paymaster deposit too low.', stack: 'private stack' }
    expect(safeError(structuredClone(serialized))).toBe(serialized.message)
    const foreign = runInNewContext('new Error("Proof generation failed")')
    expect(foreign).not.toBeInstanceOf(Error)
    expect(safeError(foreign)).toBe('Proof generation failed')
    expect(safeError('Circuit download failed')).toBe('Circuit download failed')
    expect(safeError({ message: 'Invalid UserOperation', code: -32500 })).toBe('Invalid UserOperation (code -32500)')
  })
  it('uses concise RPC details without serializing request data or stacks', () => {
    const privateNote = `tornado-eth-1-1-0x${'ab'.repeat(62)}`
    const longProof = 'f1'.repeat(256)
    const message = safeError({ shortMessage: 'Gas estimation failed.', details: `AA33 reverted 0x${longProof} at https://rpc.example/secret`,
      message: 'verbose body', data: { note: privateNote }, stack: privateNote })
    expect(message).toContain('AA33 reverted [redacted hex data]')
    expect(message).not.toContain(longProof.slice(-10))
    expect(message).not.toContain('secret'); expect(message).not.toContain(privateNote); expect(message).not.toContain('verbose body')
    expect(safeError({ message: 'An RPC error occurred.\nRequest body: {"privateRequestMarker":true}\nDetails: AA31 paymaster deposit too low' })).toBe('An RPC error occurred.\n[request data omitted]\nDetails: AA31 paymaster deposit too low')
  })
  it('bounds errors and handles unknown or cyclic causes', () => {
    const error = { cause: {} }; error.cause = error
    expect(safeError(error)).toBe('The operation failed. Please try again.')
    expect(safeError({ cause: { message: 'Worker failed' } })).toBe('Worker failed')
    expect(safeError({ message: 'x'.repeat(1000) })).toHaveLength(450)
    expect(safeError({ data: 'private payload' })).not.toContain('private payload')
  })
  it('keeps the endpoint rejection reason for validation and final submission', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: -32500, message: 'AA31 paymaster deposit too low' } })))
    await expect(jsonRpc('https://example.com', 'eth_sendUserOperation')).rejects.toThrow('AA31 paymaster deposit too low (code -32500)')
  })
  it('logs sanitized bundler estimation failures while preserving the original response', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const payload = { error: { code: -32500, message: `AA33 reverted at https://rpc.example/secret 0x${'ef'.repeat(256)}` } }
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)))
      const network = sdkNetwork({ chainId: 11155111, bundler: 'pimlico', rpcUrl: 'https://rpc.example', bundlerUrl: 'https://bundler.example/secret' })
      const response = await network.fetch('https://bundler.example/secret', { method: 'POST', body: JSON.stringify({ method: 'eth_estimateUserOperationGas', params: [{ privateRequestMarker: true }] }) })
      expect(await response.json()).toEqual(payload)
      expect(warning).toHaveBeenCalledOnce()
      const message = warning.mock.calls[0]![0] as string
      expect(message).toContain('eth_estimateUserOperationGas: AA33 reverted')
      expect(message).toContain('code -32500')
      expect(message).not.toContain('secret'); expect(message).not.toContain('efefef'); expect(message).not.toContain('privateRequestMarker')
    } finally { warning.mockRestore() }
  })
})
