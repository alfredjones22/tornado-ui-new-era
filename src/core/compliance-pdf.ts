import { jsPDF } from 'jspdf'
import { NETWORKS, units } from './catalog'
import { reportDate, type ComplianceReport } from './compliance'

export const COMPLIANCE_DISCLOSURE = 'This report contains the full Tornado note and permanently links its deposit and withdrawal. Share it only with an intended recipient. It is an informational record, not a legal certification or proof of ownership of either address. Verify the note hashes and pool events independently against the stated chain.'
export const COMPLIANCE_ROUTING = 'Transaction sender means the outer transaction sender; it may be a bundler or router. Pool recipient means the address in the pool Withdrawal event; it may be a smart account or an intermediate address. Pool payout excludes the proof-bound pool fee and does not include later gas refunds or subsequent transfers and contract calls.'

/** Text-only, local PDF generation. No HTML, remote fonts, images or services.
 * Like Classic, the report includes the note so a reviewer can rederive its
 * commitment/nullifier. Never export an unspent note as a shareable report.
 */
export function compliancePdf(report: ComplianceReport): jsPDF {
  const withdrawal = report.withdrawal
  if (!withdrawal) throw new Error('A PDF report is available only after the note has been spent and both events have been verified.')
  const { note } = report, network = NETWORKS[note.pool.chainId], asset = note.pool.asset
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true, putOnlyUsedFonts: true })
  doc.setProperties({ title: 'Tornado compliance report', subject: 'Deposit and withdrawal disclosure', creator: 'Tornado interface' })
  doc.setFont('courier', 'bold').setFontSize(19).setTextColor(23, 63, 42).text('Tornado', 15, 21)
  doc.setFont('courier', 'normal').setFontSize(12).setTextColor(30).text('Compliance report', 15, 30)
  doc.setFontSize(8).text(`${network.name} (chain ${note.pool.chainId}) | ${note.pool.denomination} ${asset.symbol} pool`, 15, 41)
  doc.text(`Pool: ${note.pool.address}`, 15, 47)
  doc.text(`Checked at block ${report.checkedBlock} | ${reportDate(report.checkedAt)}`, 15, 53)
  doc.setDrawColor(185, 205, 192).line(15, 59, 195, 59)
  const width = 85
  function field(label: string, value: string, x: number, y: number, url?: string) {
    doc.setFont('courier', 'normal').setFontSize(7).setTextColor(85).text(label, x, y)
    const lines = doc.setFontSize(8).splitTextToSize(value, width) as string[]
    doc.setTextColor(20)
    lines.forEach((line, i) => {
      if (url) doc.textWithLink(line, x, y + 5 + i * 4, { url })
      else doc.text(line, x, y + 5 + i * 4)
    })
    return y + 11 + (lines.length - 1) * 4
  }
  doc.setFont('courier', 'bold').setFontSize(12).text('Deposit', 15, 70).text('Withdrawal', 110, 70)
  doc.setFontSize(10).text(`${note.pool.denomination} ${asset.symbol}`, 15, 78)
  doc.text(`${units(withdrawal.poolPayout, asset)} ${asset.symbol}`, 110, 78)
  let y = 89
  y = Math.max(field('Date (UTC)', reportDate(report.deposit.timestamp), 15, y), field('Date (UTC)', reportDate(withdrawal.timestamp), 110, y))
  y = Math.max(field('Transaction', report.deposit.transactionHash, 15, y, `${network.explorer}/tx/${report.deposit.transactionHash}`),
    field('Transaction', withdrawal.transactionHash, 110, y, `${network.explorer}/tx/${withdrawal.transactionHash}`))
  y = Math.max(field('Transaction sender (not necessarily depositor)', report.deposit.transactionSender, 15, y, `${network.explorer}/address/${report.deposit.transactionSender}`),
    field('Pool recipient (before any subsequent actions)', withdrawal.recipient, 110, y, `${network.explorer}/address/${withdrawal.recipient}`))
  y = Math.max(field('Commitment', report.commitment, 15, y), field('Nullifier hash', report.nullifierHash, 110, y))
  y = Math.max(field('Block / log index / leaf index', `${report.deposit.blockNumber} / ${report.deposit.logIndex} / ${report.deposit.leafIndex}`, 15, y),
    field('Block / log index', `${withdrawal.blockNumber} / ${withdrawal.logIndex}`, 110, y))
  field('Pool fee (before any gas refund)', `${units(withdrawal.fee, asset)} ${asset.symbol}`, 15, y)
  y = field('Relayer / paymaster (zero if none)', withdrawal.relayer, 110, y, `${network.explorer}/address/${withdrawal.relayer}`) + 5
  doc.setDrawColor(185, 205, 192).line(15, y, 195, y)
  y += 8
  doc.setFont('courier', 'bold').setFontSize(9).text('PRIVATE DISCLOSURE - FULL NOTE', 15, y)
  y += 6
  doc.setFont('courier', 'normal').setFontSize(8)
  const noteLines = doc.splitTextToSize(note.raw, 180) as string[]
  doc.text(noteLines, 15, y); y += noteLines.length * 4 + 5
  for (const paragraph of [COMPLIANCE_DISCLOSURE, COMPLIANCE_ROUTING]) {
    const lines = doc.setFontSize(7).splitTextToSize(paragraph, 180) as string[]
    if (y + lines.length * 3.5 > 281) { doc.addPage(); y = 20 }
    doc.text(lines, 15, y); y += lines.length * 3.5 + 5
  }
  return doc
}

export function downloadCompliancePdf(report: ComplianceReport) {
  compliancePdf(report).save(`tornado-compliance-${report.note.pool.chainId}-${report.note.pool.asset.symbol.toLowerCase()}-${report.note.pool.denomination}.pdf`)
}
