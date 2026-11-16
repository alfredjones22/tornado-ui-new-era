import { describe, expect, it } from 'vitest'
import { checkedSourceUrl } from '../src/core/rpc'
import { sourceUrl } from '../src/core/data-sources'

describe('data source base URLs', () => {
  it('keeps directory paths including IPFS CIDs when appending resource names', () => {
    expect(sourceUrl('index.json', checkedSourceUrl('https://gateway.example/ipfs/artifact-cid/sepolia')))
      .toBe('https://gateway.example/ipfs/artifact-cid/sepolia/index.json')
    expect(checkedSourceUrl('http://127.0.0.1:9000/history')).toBe('http://127.0.0.1:9000/history/')
  })
  it.each(['http://remote.example', 'https://user:secret@example.com', 'https://example.com/?source=other',
    'https://example.com/#index', 'javascript:alert(1)', 'not a URL'])('refuses unsafe or ambiguous source base %s', value => {
    expect(() => checkedSourceUrl(value)).toThrow()
  })
})
