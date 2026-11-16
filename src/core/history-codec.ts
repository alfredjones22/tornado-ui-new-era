export async function readHistoryBytes(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) throw new Error('History response has no body.')
  const reader = stream.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > limit) throw new Error('History response exceeds its size limit.')
      chunks.push(value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

export async function decompressHistory(bytes: Uint8Array, limit: number) {
  // Some hosts apply Content-Encoding to .gz assets, which fetch already decodes.
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    if (bytes.length > limit) throw new Error('History exceeds its size limit.')
    return new Uint8Array(bytes)
  }
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'))
  return readHistoryBytes(stream, limit)
}

export async function historyDigest(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), b => b.toString(16).padStart(2, '0')).join('')
}
