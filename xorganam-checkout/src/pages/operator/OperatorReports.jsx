import { useEffect, useState } from 'react'
import { useOperatorAuth } from '../../context/OperatorAuthContext'
import { operatorApi } from '../../api/client'

function money(n) {
  return Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function reportSections(report, title) {
  const sections = [
    {
      title,
      rows: [
        ['Total collected', money(report.totalCollected)],
        ['Total paid out', money(report.totalPaidOut)],
        ['Total fees', money(report.totalFees)],
        ['Net revenue', money(report.netRevenue)],
        ['Collections', report.collectionCount],
        ['Successful', report.successfulCount],
        ['Pending', report.pendingCount],
        ['Failed', report.failedCount]
      ]
    }
  ]
  if (report.merchants?.length) {
    sections.push({
      title: 'Merchants',
      rows: [['Merchant', 'Total collected', 'Transactions'], ...report.merchants.map((m) => [m.displayName, money(m.totalCollected), m.transactionCount])]
    })
  }
  if (report.recentTransactions?.length) {
    sections.push({
      title: 'Recent transactions',
      rows: [
        ['Reference', 'Type', 'Status', 'Gateway', 'Amount', 'Date'],
        ...report.recentTransactions.map((t) => [t.internalReference, t.type, t.status, t.paymentGatewayStatus || '', money(t.amount), new Date(t.createdAt).toLocaleString()])
      ]
    })
  }
  return sections
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`
}

function htmlCell(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function downloadBlob(filename, type, content) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function exportCsv(filename, report, title) {
  const lines = []
  reportSections(report, title).forEach((section) => {
    lines.push(csvCell(section.title))
    section.rows.forEach((row) => lines.push(row.map(csvCell).join(',')))
    lines.push('')
  })
  downloadBlob(filename, 'text/csv;charset=utf-8', `\uFEFF${lines.join('\n')}`)
}

function exportExcel(filename, report, title) {
  const tables = reportSections(report, title).map((section) => `
    <h2>${htmlCell(section.title)}</h2>
    <table border="1">${section.rows.map((row) => `<tr>${row.map((cell) => `<td>${htmlCell(cell)}</td>`).join('')}</tr>`).join('')}</table>
  `).join('')
  downloadBlob(filename, 'application/vnd.ms-excel', `<html><body>${tables}</body></html>`)
}

function exportPdf(report, title) {
  const tables = reportSections(report, title).map((section) => `
    <h2>${htmlCell(section.title)}</h2>
    <table>${section.rows.map((row) => `<tr>${row.map((cell) => `<td>${htmlCell(cell)}</td>`).join('')}</tr>`).join('')}</table>
  `).join('')
  const win = window.open('', '_blank')
  if (!win) return
  win.document.write(`
    <html>
      <head>
        <title>${htmlCell(title)}</title>
        <style>
          body { font-family: Arial, sans-serif; color: #111; }
          h1 { font-size: 20px; }
          h2 { font-size: 14px; margin-top: 22px; }
          table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
          td { border: 1px solid #ccc; padding: 6px 8px; font-size: 12px; }
        </style>
      </head>
      <body><h1>${htmlCell(title)}</h1>${tables}</body>
    </html>
  `)
  win.document.close()
  win.print()
}

export default function OperatorReports() {
  const { user } = useOperatorAuth()
  const [scope, setScope] = useState('tenant')
  const [merchantId, setMerchantId] = useState('')
  const [merchants, setMerchants] = useState([])
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!user?.tenantId) return
    operatorApi.listMerchants(user.tenantId).then(setMerchants).catch(() => {})
  }, [user])

  async function generateReport(e) {
    e.preventDefault()
    if (!user?.tenantId) return
    setError('')
    setLoading(true)
    try {
      if (scope === 'merchant') {
        if (!merchantId) throw new Error('Select a merchant.')
        setReport(await operatorApi.merchantReport(merchantId))
      } else {
        setReport(await operatorApi.tenantReport(user.tenantId))
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const title = scope === 'merchant' ? 'Merchant report' : 'All merchant report'

  return (
    <div>
      <div className="portal-header">
        <div>
          <h1>Reports</h1>
          <p>Generate reports across all merchants or for one merchant.</p>
        </div>
        {report && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => exportExcel(`${scope}-report.xls`, report, title)}>Export Excel</button>
            <button className="btn btn-secondary" onClick={() => exportCsv(`${scope}-report.csv`, report, title)}>Export CSV</button>
            <button className="btn btn-secondary" onClick={() => exportPdf(report, title)}>Export PDF</button>
          </div>
        )}
      </div>

      {error && <div className="status-banner error"><span className="status-icon">!</span><span>{error}</span></div>}

      <form className="card" onSubmit={generateReport}>
        <div className="two-col">
          <div className="field">
            <label>Scope</label>
            <select value={scope} onChange={(e) => { setScope(e.target.value); setReport(null) }}>
              <option value="tenant">All reports</option>
              <option value="merchant">Specific merchant</option>
            </select>
          </div>
          <div className="field">
            <label>Merchant</label>
            <select value={merchantId} onChange={(e) => { setMerchantId(e.target.value); setReport(null) }} disabled={scope !== 'merchant'}>
              <option value="">Select merchant</option>
              {merchants.map((merchant) => (
                <option key={merchant.id} value={merchant.id}>{merchant.displayName}</option>
              ))}
            </select>
          </div>
        </div>
        <button className="btn btn-primary" disabled={loading}>{loading ? 'Generating...' : 'Generate report'}</button>
      </form>

      {report && (
        <>
          <div className="metrics-row">
            <div className="metric"><div className="label">Total collected</div><div className="value">GHS {money(report.totalCollected)}</div></div>
            <div className="metric"><div className="label">Total paid out</div><div className="value">GHS {money(report.totalPaidOut)}</div></div>
            <div className="metric"><div className="label">Net revenue</div><div className="value">GHS {money(report.netRevenue)}</div></div>
          </div>

          <div className="card">
            <h2>Report summary</h2>
            <div className="kv-row"><span>Collections</span><span className="mono">{report.collectionCount}</span></div>
            <div className="kv-row"><span>Successful</span><span className="mono">{report.successfulCount}</span></div>
            <div className="kv-row"><span>Pending</span><span className="mono">{report.pendingCount}</span></div>
            <div className="kv-row"><span>Failed</span><span className="mono">{report.failedCount}</span></div>
            <div className="kv-row"><span>Fees</span><span className="mono">GHS {money(report.totalFees)}</span></div>
          </div>
        </>
      )}
    </div>
  )
}
