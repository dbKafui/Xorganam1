import { useEffect, useMemo, useState } from 'react'
import { reportsApi } from '../api/reports'
import { tenantsApi } from '../api/tenants'
import { merchantsApi } from '../api/merchants'

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

  if ('totalActiveTenants' in report) {
    sections[0].rows.unshift(['Pending tenants', report.totalPendingTenants])
    sections[0].rows.unshift(['Active tenants', report.totalActiveTenants])
  }
  if (report.topTenantsByVolume?.length) {
    sections.push({
      title: 'Top tenants by volume',
      rows: [['Tenant', 'Volume', 'Transactions'], ...report.topTenantsByVolume.map((t) => [t.companyName, money(t.totalVolume), t.transactionCount])]
    })
  }
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

export default function Reports() {
  const [scope, setScope] = useState('system')
  const [tenantId, setTenantId] = useState('')
  const [merchantId, setMerchantId] = useState('')
  const [tenants, setTenants] = useState([])
  const [merchants, setMerchants] = useState([])
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    tenantsApi.list().then(setTenants).catch(() => {})
    merchantsApi.all().then(setMerchants).catch(() => {})
  }, [])

  const filteredMerchants = useMemo(
    () => merchants.filter((merchant) => !tenantId || merchant.tenantId === tenantId),
    [merchants, tenantId]
  )

  async function generateReport(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (scope === 'system') {
        setReport(await reportsApi.system())
      } else if (scope === 'tenant') {
        if (!tenantId) throw new Error('Select a tenant.')
        setReport(await reportsApi.tenant(tenantId))
      } else {
        if (!merchantId) throw new Error('Select a merchant.')
        setReport(await reportsApi.merchant(merchantId))
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const title = scope === 'system' ? 'All reports' : scope === 'tenant' ? 'Tenant report' : 'Merchant report'

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Reports</h1>
          <p>Generate platform, tenant, or merchant summaries.</p>
        </div>
        {report && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => exportExcel(`${scope}-report.xls`, report, title)}>Export Excel</button>
            <button className="btn btn-secondary" onClick={() => exportCsv(`${scope}-report.csv`, report, title)}>Export CSV</button>
            <button className="btn btn-secondary" onClick={() => exportPdf(report, title)}>Export PDF</button>
          </div>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <form className="panel" onSubmit={generateReport}>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="field">
            <label>Scope</label>
            <select value={scope} onChange={(e) => { setScope(e.target.value); setReport(null) }}>
              <option value="system">All reports</option>
              <option value="tenant">Specific tenant</option>
              <option value="merchant">Specific merchant</option>
            </select>
          </div>
          <div className="field">
            <label>Tenant</label>
            <select value={tenantId} onChange={(e) => { setTenantId(e.target.value); setMerchantId(''); setReport(null) }} disabled={scope === 'system'}>
              <option value="">Select tenant</option>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>{tenant.companyName}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Merchant</label>
            <select value={merchantId} onChange={(e) => { setMerchantId(e.target.value); setReport(null) }} disabled={scope !== 'merchant'}>
              <option value="">Select merchant</option>
              {filteredMerchants.map((merchant) => (
                <option key={merchant.id} value={merchant.id}>
                  {merchant.displayName} {merchant.tenantCompanyName ? `(${merchant.tenantCompanyName})` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="form-actions">
          <button className="btn btn-primary" disabled={loading}>{loading ? 'Generating...' : 'Generate report'}</button>
        </div>
      </form>

      {report && (
        <>
          <div className="grid-3">
            {'totalActiveTenants' in report && (
              <div className="metric-card"><div className="label">Active tenants</div><div className="value">{report.totalActiveTenants}</div></div>
            )}
            <div className="metric-card"><div className="label">Total collected</div><div className="value">GHS {money(report.totalCollected)}</div></div>
            <div className="metric-card"><div className="label">Total paid out</div><div className="value">GHS {money(report.totalPaidOut)}</div></div>
            <div className="metric-card"><div className="label">Pending</div><div className="value">{report.pendingCount}</div></div>
          </div>

          <div className="panel" style={{ marginTop: 20 }}>
            <h2>{title}</h2>
            <div className="form-grid single">
              <div><strong>Collections:</strong> <span className="mono">{report.collectionCount}</span></div>
              <div><strong>Successful:</strong> <span className="mono">{report.successfulCount}</span></div>
              <div><strong>Failed:</strong> <span className="mono">{report.failedCount}</span></div>
              <div><strong>Fees:</strong> <span className="mono">GHS {money(report.totalFees)}</span></div>
              <div><strong>Net revenue:</strong> <span className="mono">GHS {money(report.netRevenue)}</span></div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
