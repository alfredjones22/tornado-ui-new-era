import { describe, expect, it } from 'vitest'
import { compliancePdf } from '../src/core/compliance-pdf'
import { complianceFixture } from './fixtures/compliance'

describe('local compliance PDF', () => {
  it('creates a portable PDF without remote resources', () => {
    const pdf = compliancePdf(complianceFixture())
    expect(pdf.getNumberOfPages()).toBeLessThanOrEqual(2)
    expect(pdf.output()).toMatch(/^%PDF-/)
    expect(pdf.output()).not.toContain('/JavaScript')
  })
  it('refuses to turn an unspent note into a shareable report', () => {
    expect(() => compliancePdf({ ...complianceFixture(), withdrawal: null })).toThrow('only after the note has been spent')
  })
})
