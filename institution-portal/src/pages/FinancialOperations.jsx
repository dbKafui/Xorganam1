import { useCallback, useEffect, useState } from 'react'
import { institutionApi } from '../api/client.js'
import { useInstitutionAuth } from '../context/InstitutionAuthContext.jsx'
import PageHeader from '../components/PageHeader.jsx'
import { ErrorMessage, LoadingState, SuccessMessage } from '../components/Feedback.jsx'

const blankCustomer = { customerNumber: '', firstName: '', lastName: '', phoneNumber: '', email: '', kycReference: '', notificationConsent: false }
const blankProduct = { institutionPackageId: '', productType: 'LOAN', name: '', description: '', minAmount: '', maxAmount: '', annualRate: '0', interestModel: 'FLAT', repaymentFrequency: 'MONTHLY', minTerm: '30', maxTerm: '365', tenorOptionsMonths: '3,6,12', lateFee: '0', graceDays: '0', minContributionHistory: '0', minBalance: '0', withdrawalsPerMonth: '', savingsLockInMonths: '0', earlyWithdrawalPenalty: '0', contributionFrequency: 'PER_TRANSACTION' }
const blankAccount = { customerId: '', productId: '', vendorLinkId: '', amount: '', termMonths: '', termDays: '' }
const blankVendorLink = { merchantId: '', memberId: '' }
const blankEganow = { apiUsername: '', apiPassword: '', xAuth: '', eganowBaseUrl: 'https://developer.sandbox.egacoreapi.com', callbackUrl: '', collectionAccountId: '', payoutAccountId: '', networkProvider: '', isEnabled: false }
const feeOperations = ['LOAN_REPAYMENT', 'SAVINGS_CONTRIBUTION', 'SAVINGS_WITHDRAWAL']
const feeLabels = { LOAN_REPAYMENT: 'Loan repayment', SAVINGS_CONTRIBUTION: 'Savings contribution', SAVINGS_WITHDRAWAL: 'Savings withdrawal' }
function amount(cents) { return `GHS ${(Number(cents || 0) / 100).toFixed(2)}` }

export default function FinancialOperations() {
  const { staff } = useInstitutionAuth()
  const isAdmin = staff?.role === 'INSTITUTION_ADMIN'
  const canReview = ['SUPERVISOR', 'INSTITUTION_ADMIN'].includes(staff?.role)
  const [customers, setCustomers] = useState([])
  const [linkedTenants, setLinkedTenants] = useState([])
  const [availableVendors, setAvailableVendors] = useState([])
  const [vendorLinks, setVendorLinks] = useState([])
  const [tenantSelections, setTenantSelections] = useState({})
  const [products, setProducts] = useState([])
  const [accounts, setAccounts] = useState([])
  const [transactions, setTransactions] = useState([])
  const [fees, setFees] = useState([])
  const [customer, setCustomer] = useState(blankCustomer)
  const [product, setProduct] = useState(blankProduct)
  const [editingProductId, setEditingProductId] = useState('')
  const [account, setAccount] = useState(blankAccount)
  const [vendorLinkForm, setVendorLinkForm] = useState(blankVendorLink)
  const [transactionForm, setTransactionForm] = useState({ accountId: '', transactionType: 'DEPOSIT', amount: '', externalReference: '', phoneNumber: '', note: '' })
  const [feeForms, setFeeForms] = useState(Object.fromEntries(feeOperations.map((operation) => [operation, { feeType: 'NONE', feeValue: '0' }])))
  const [eganow, setEganow] = useState(blankEganow)
  const [eganowPresence, setEganowPresence] = useState({})
  const [approvalLimit, setApprovalLimit] = useState('0')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    const [customerRows, tenantRows, availableVendorRows, vendorLinkRows, productRows, accountRows, transactionRows, feeRows, eganowConfig, approvalPolicy] = await Promise.all([
      institutionApi.listFinanceCustomers(), institutionApi.listFinanceLinkedTenants(), institutionApi.listFinanceAvailableVendors(),
      institutionApi.listFinanceVendorLinks(), institutionApi.listFinanceProducts(),
      institutionApi.listFinanceAccounts(), institutionApi.listFinanceTransactions(), institutionApi.listFinanceFees(), institutionApi.getEganowProvisioning(), institutionApi.getApprovalPolicy()
    ])
    setCustomers(customerRows); setLinkedTenants(tenantRows); setAvailableVendors(availableVendorRows); setVendorLinks(vendorLinkRows); setProducts(productRows); setAccounts(accountRows); setTransactions(transactionRows)
    setFees(feeRows)
    setEganow({ ...blankEganow, eganowBaseUrl: eganowConfig.eganow_base_url || blankEganow.eganowBaseUrl,
      callbackUrl: eganowConfig.callback_url || '', collectionAccountId: eganowConfig.eganow_collection_account_id || '',
      payoutAccountId: eganowConfig.eganow_payout_account_id || '', networkProvider: eganowConfig.eganow_network_provider || '',
      isEnabled: Boolean(eganowConfig.is_enabled) })
    setEganowPresence(eganowConfig)
    setApprovalLimit(String(Number(approvalPolicy.supervisorApprovalLimitCents || 0) / 100))
    setFeeForms(Object.fromEntries(feeOperations.map((operation) => {
      const found = feeRows.find((row) => row.operation === operation)
      return [operation, { feeType: found?.fee_type || 'NONE', feeValue: String(found?.fee_value ?? 0) }]
    })))
  }, [])
  useEffect(() => { load().catch((e) => setError(e.message)).finally(() => setLoading(false)) }, [load])

  async function submit(action, success) {
    setSaving(true); setError(''); setNotice('')
    try { await action(); setNotice(success); await load() }
    catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }
  function createCustomer(event) {
    event.preventDefault()
    return submit(async () => { await institutionApi.createFinanceCustomer(customer); setCustomer(blankCustomer) }, 'Customer onboarded and queued for KYC verification.')
  }
  function createVendorLink(event) {
    event.preventDefault()
    const vendor = availableVendors.find((row) => row.merchant_id === vendorLinkForm.merchantId)
    if (!vendor) return
    return submit(async () => {
      await institutionApi.createFinanceVendorLink({ tenantId: vendor.tenant_id, merchantId: vendor.merchant_id, memberId: vendorLinkForm.memberId.trim() })
      setVendorLinkForm(blankVendorLink)
    }, 'Vendor linked to this institution. Products remain optional until the vendor opens an account.')
  }
  function createProduct(event) {
    event.preventDefault()
    return submit(async () => {
      const payload = { institutionPackageId: product.institutionPackageId, productType: product.productType, name: product.name, description: product.description,
        minAmountCents: Math.round(Number(product.minAmount) * 100), maxAmountCents: Math.round(Number(product.maxAmount) * 100),
        annualRateBasisPoints: Math.round(Number(product.annualRate) * 100), minBalanceCents: Math.round(Number(product.minBalance) * 100),
        interestModel: product.productType === 'LOAN' ? product.interestModel : undefined,
        repaymentFrequency: product.productType === 'LOAN' ? product.repaymentFrequency : undefined,
        minTermDays: product.productType === 'LOAN' ? Number(product.minTerm) : undefined,
        maxTermDays: product.productType === 'LOAN' ? Number(product.maxTerm) : undefined,
        tenorOptionsMonths: product.productType === 'LOAN' ? product.tenorOptionsMonths.split(',').map((value) => Number(value.trim())) : undefined,
        lateFeeBasisPoints: product.productType === 'LOAN' ? Math.round(Number(product.lateFee) * 100) : undefined,
        gracePeriodDays: product.productType === 'LOAN' ? Number(product.graceDays) : undefined,
        minContributionHistoryCents: product.productType === 'LOAN' ? Math.round(Number(product.minContributionHistory) * 100) : undefined,
        withdrawalsPerMonth: product.productType !== 'LOAN' && product.withdrawalsPerMonth ? Number(product.withdrawalsPerMonth) : undefined,
        contributionFrequency: product.productType !== 'LOAN' ? product.contributionFrequency : undefined,
        savingsLockInMonths: product.productType !== 'LOAN' ? Number(product.savingsLockInMonths) : undefined,
        earlyWithdrawalPenaltyBasisPoints: product.productType !== 'LOAN' ? Math.round(Number(product.earlyWithdrawalPenalty) * 100) : undefined }
      if (editingProductId) await institutionApi.updateFinanceProductPolicy(editingProductId, payload)
      else await institutionApi.createFinanceProduct(payload)
      setProduct(blankProduct); setEditingProductId('')
    }, editingProductId ? 'Financial product policy updated.' : 'Financial product created as a draft.')
  }
  function editProduct(row) {
    setEditingProductId(row.id)
    setProduct({ ...blankProduct, institutionPackageId: row.institution_package_id || '', productType: row.product_type, name: row.name, description: row.description || '',
      minAmount: (Number(row.min_amount_cents) / 100).toFixed(2), maxAmount: (Number(row.max_amount_cents) / 100).toFixed(2),
      annualRate: (Number(row.annual_rate_basis_points) / 100).toFixed(2), interestModel: row.loan_interest_model || 'FLAT',
      repaymentFrequency: row.repayment_frequency || 'MONTHLY', minTerm: String(row.min_term_days || 30), maxTerm: String(row.max_term_days || 365),
      tenorOptionsMonths: (row.tenor_options_months || []).join(','), lateFee: (Number(row.late_fee_basis_points || 0) / 100).toFixed(2),
      graceDays: String(row.grace_period_days || 0), minContributionHistory: (Number(row.min_contribution_history_cents || 0) / 100).toFixed(2),
      minBalance: (Number(row.min_balance_cents || 0) / 100).toFixed(2), withdrawalsPerMonth: String(row.withdrawals_per_month || ''),
      savingsLockInMonths: String(row.savings_lock_in_months || 0), earlyWithdrawalPenalty: (Number(row.early_withdrawal_penalty_basis_points || 0) / 100).toFixed(2),
      contributionFrequency: row.contribution_frequency || 'PER_TRANSACTION' })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function createAccount(event) {
    event.preventDefault()
    return submit(async () => {
      await institutionApi.createFinanceAccount({ customerId: account.customerId, productId: account.productId, vendorLinkId: account.vendorLinkId,
        requestedAmountCents: Math.round(Number(account.amount) * 100), termMonths: account.termMonths ? Number(account.termMonths) : undefined,
        termDays: account.termDays ? Number(account.termDays) : undefined })
      setAccount(blankAccount)
    }, 'Account request submitted for approval.')
  }
  function createTransaction(event) {
    event.preventDefault()
    return submit(async () => {
      await institutionApi.createFinanceTransaction({ ...transactionForm, amountCents: Math.round(Number(transactionForm.amount) * 100) })
      setTransactionForm({ accountId: '', transactionType: 'DEPOSIT', amount: '', externalReference: '', phoneNumber: '', note: '' })
    }, 'Financial transaction recorded for approval; Eganow will be initiated when an authorized reviewer approves it.')
  }
  function saveEganow(event) {
    event.preventDefault()
    return submit(async () => { await institutionApi.saveEganowProvisioning(eganow); setEganow((current) => ({ ...current, apiUsername: '', apiPassword: '', xAuth: '' })) }, 'Eganow provisioning saved. Secrets are encrypted and not returned to the portal.')
  }
  function testEganow() {
    return submit(async () => {
      const result = await institutionApi.testEganowProvisioning()
      if (!result.connected) throw new Error(result.message || 'Eganow connection failed.')
    }, 'Eganow authentication succeeded.')
  }

  if (loading) return <><PageHeader eyebrow="INSTITUTION / FINANCE" title="Loans & savings" description="Manage members, financial products, accounts, fees, and ledger approvals." /><LoadingState /></>
  return <>
    <PageHeader eyebrow="INSTITUTION / FINANCE" title="Loans & savings" description="Institution staff manage customer onboarding, product boundaries, account approvals, and financial activity." />
    <ErrorMessage>{error}</ErrorMessage><SuccessMessage>{notice}</SuccessMessage>

    {isAdmin && <section className="surface">
      <div className="section-head"><div><div className="eyebrow">APPROVAL POLICY</div><h2>Supervisor authority</h2></div></div>
      <form className="form-grid" onSubmit={(event) => { event.preventDefault(); submit(() => institutionApi.saveApprovalPolicy(Math.round(Number(approvalLimit) * 100)), 'Supervisor approval limit saved.') }}>
        <label className="form-field"><span>Maximum approval amount (GHS)</span><input required type="number" min="0" step="0.01" value={approvalLimit} onChange={(e) => setApprovalLimit(e.target.value)} /></label>
        <div className="form-span form-actions"><button className="button button-primary" disabled={saving}>Save approval limit</button></div>
      </form>
      <p className="footnote">Supervisors can approve accounts and transactions up to this limit. Larger amounts require an institution admin.</p>
    </section>}

    {isAdmin && <section className="surface">
      <div className="section-head"><div><div className="eyebrow">PAYMENT PROVIDER</div><h2>Institution Eganow provisioning</h2></div><span className="count-pill">{eganow.isEnabled ? 'ENABLED' : 'DISABLED'}</span></div>
      <p className="footnote">Enter credentials issued to this institution by Eganow. They are encrypted with the institution key context. The API username, password, and x-Auth are write-only and will never be shown again.</p>
      <form className="form-grid" onSubmit={saveEganow}>
        <label className="form-field"><span>Secret username {eganowPresence.has_api_username ? '(configured; leave blank to keep)' : '(required)'}</span><input type="password" autoComplete="new-password" value={eganow.apiUsername} onChange={(e) => setEganow({ ...eganow, apiUsername: e.target.value })} /></label>
        <label className="form-field"><span>Secret password {eganowPresence.has_api_password ? '(configured; leave blank to keep)' : '(required)'}</span><input type="password" autoComplete="new-password" value={eganow.apiPassword} onChange={(e) => setEganow({ ...eganow, apiPassword: e.target.value })} /></label>
        <label className="form-field"><span>x-Auth {eganowPresence.has_x_auth ? '(configured; leave blank to keep)' : '(required)'}</span><input type="password" autoComplete="new-password" value={eganow.xAuth} onChange={(e) => setEganow({ ...eganow, xAuth: e.target.value })} /></label>
        <label className="form-field"><span>Eganow API base URL</span><input required type="url" value={eganow.eganowBaseUrl} onChange={(e) => setEganow({ ...eganow, eganowBaseUrl: e.target.value })} placeholder="https://developer.sandbox.egacoreapi.com" /></label>
        <label className="form-field"><span>Public HTTPS callback URL</span><input required type="url" value={eganow.callbackUrl} onChange={(e) => setEganow({ ...eganow, callbackUrl: e.target.value })} placeholder="https://api.example.com/api/v1/webhooks/eganow-institution/…" /><small>Set this exact URL in Eganow. It must reach this API from the public internet.</small></label>
        <label className="form-field"><span>Collection wallet/account ID</span><input required maxLength="150" value={eganow.collectionAccountId} onChange={(e) => setEganow({ ...eganow, collectionAccountId: e.target.value })} /></label>
        <label className="form-field"><span>Payout wallet/account ID</span><input required maxLength="150" value={eganow.payoutAccountId} onChange={(e) => setEganow({ ...eganow, payoutAccountId: e.target.value })} /></label>
        <label className="form-field"><span>Default mobile network (fallback)</span><select value={eganow.networkProvider} onChange={(e) => setEganow({ ...eganow, networkProvider: e.target.value })}><option value="">Infer from phone number</option><option value="MTNGH">MTN Ghana</option><option value="TCELGH">Telecel Ghana</option><option value="ATGH">AT Ghana</option></select></label>
        <label className="checkbox-field"><input type="checkbox" checked={eganow.isEnabled} onChange={(e) => setEganow({ ...eganow, isEnabled: e.target.checked })} /><span>Enable institution Eganow payments</span></label>
        <div className="form-span form-actions"><button className="button button-primary" disabled={saving}>Save Eganow setup</button><button type="button" className="button button-secondary" disabled={saving || !eganow.isEnabled} onClick={testEganow}>Test Eganow authentication</button></div>
      </form>
      <p className="footnote">Eganow issues merchant API credentials (`secret username`, `secret password`, and `x-Auth`) from its business dashboard. Configure separate credentials and wallets for each institution. Callbacks are reconciled against Eganow’s authenticated status API before the ledger is updated.</p>
    </section>}

    <section className="surface">
      <div className="section-head"><div><div className="eyebrow">CUSTOMER OPERATIONS</div><h2>Member customers</h2></div><span className="count-pill">{customers.length}</span></div>
      <form className="form-grid" onSubmit={createCustomer}>
        <label className="form-field"><span>Customer number</span><input required maxLength="64" value={customer.customerNumber} onChange={(e) => setCustomer({ ...customer, customerNumber: e.target.value })} /></label>
        <label className="form-field"><span>First name</span><input required maxLength="100" value={customer.firstName} onChange={(e) => setCustomer({ ...customer, firstName: e.target.value })} /></label>
        <label className="form-field"><span>Last name</span><input required maxLength="100" value={customer.lastName} onChange={(e) => setCustomer({ ...customer, lastName: e.target.value })} /></label>
        <label className="form-field"><span>Phone (233XXXXXXXXX)</span><input required pattern="233[0-9]{9}" value={customer.phoneNumber} onChange={(e) => setCustomer({ ...customer, phoneNumber: e.target.value })} /></label>
        <label className="form-field"><span>Email (optional)</span><input type="email" value={customer.email} onChange={(e) => setCustomer({ ...customer, email: e.target.value })} /></label>
        <label className="form-field"><span>KYC reference</span><input required maxLength="160" value={customer.kycReference} onChange={(e) => setCustomer({ ...customer, kycReference: e.target.value })} /></label>
        <label className="checkbox-field"><input type="checkbox" checked={customer.notificationConsent} onChange={(e) => setCustomer({ ...customer, notificationConsent: e.target.checked })} /><span>Customer consented to SMS notifications</span></label>
        <div className="form-span form-actions"><button className="button button-primary" disabled={saving}>Onboard customer</button></div>
      </form>
      <div className="table-wrap"><table><thead><tr><th>Customer</th><th>Customer number</th><th>Phone</th><th>KYC</th><th>SMS consent</th><th>Tenant access</th>{canReview && <th>Review</th>}</tr></thead><tbody>
        {customers.map((row) => <tr key={row.id}><td>{row.first_name} {row.last_name}</td><td>{row.customer_number}</td><td>{row.phone_number}</td><td>{row.kyc_status}{row.duplicate_phone && <small>Duplicate mobile · supervisor review</small>}</td><td><button className="button button-secondary button-small" disabled={saving} onClick={() => submit(() => institutionApi.updateCustomerNotificationConsent(row.id, !row.notification_consent), `SMS consent ${row.notification_consent ? 'revoked' : 'recorded'}.`)}>{row.notification_consent ? 'Opted in · revoke' : 'Not opted in · record'}</button></td><td>{row.tenant_id ? 'Linked to tenant' : 'Institution only'}</td>{canReview && <td>{row.kyc_status === 'PENDING' ? <><select aria-label={`Tenant association for ${row.first_name} ${row.last_name}`} value={tenantSelections[row.id] || ''} onChange={(e) => setTenantSelections({ ...tenantSelections, [row.id]: e.target.value })}><option value="">Institution customer only</option>{linkedTenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.company_name}</option>)}</select> <button className="button button-secondary button-small" disabled={saving} onClick={() => submit(() => institutionApi.decideCustomerKyc(row.id, { decision: 'VERIFIED', tenantId: tenantSelections[row.id] || undefined }), 'Customer KYC verified.')}>Verify</button> <button className="button button-secondary button-small" disabled={saving} onClick={() => submit(() => institutionApi.decideCustomerKyc(row.id, { decision: 'REJECTED' }), 'Customer KYC rejected.')}>Reject</button></> : row.kyc_status === 'VERIFIED' && !row.tenant_id && <><select aria-label={`Tenant association for ${row.first_name} ${row.last_name}`} value={tenantSelections[row.id] || ''} onChange={(e) => setTenantSelections({ ...tenantSelections, [row.id]: e.target.value })}><option value="">Choose approved tenant link</option>{linkedTenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.company_name}</option>)}</select><button className="button button-secondary button-small" disabled={saving || !tenantSelections[row.id]} onClick={() => submit(() => institutionApi.decideCustomerKyc(row.id, { decision: 'VERIFIED', tenantId: tenantSelections[row.id] }), 'Verified member associated with tenant.')}>Link member</button></>}</td>}</tr>)}
      </tbody></table></div>
    </section>

    {canReview && <section className="surface">
      <div className="section-head"><div><div className="eyebrow">OPTIONAL VENDOR LINK</div><h2>Link a vendor to this institution</h2></div><span className="count-pill">{vendorLinks.length}</span></div>
      <p className="footnote">A link makes this institution’s products available to that vendor. Linking alone does not split or deduct funds. Savings and ordinary loan allocations run only on a vendor payout; institution-managed recovery of a defaulted loan may initiate its own payout leg from that vendor’s payout wallet.</p>
      <form className="form-grid" onSubmit={createVendorLink}>
        <label className="form-field"><span>Vendor under an approved institution link</span><select required value={vendorLinkForm.merchantId} onChange={(e) => setVendorLinkForm({ ...vendorLinkForm, merchantId: e.target.value })}><option value="">Select vendor</option>{availableVendors.map((row) => <option key={row.merchant_id} value={row.merchant_id}>{row.vendor_name} · {row.tenant_name}</option>)}</select></label>
        <label className="form-field"><span>Institution member ID</span><input required maxLength="160" value={vendorLinkForm.memberId} onChange={(e) => setVendorLinkForm({ ...vendorLinkForm, memberId: e.target.value })} /></label>
        <div className="form-actions"><button className="button button-primary" disabled={saving || !availableVendors.length}>Link vendor</button></div>
      </form>
      <div className="table-wrap"><table><thead><tr><th>Vendor</th><th>Institution member ID</th><th>Member status</th></tr></thead><tbody>{vendorLinks.map((row) => <tr key={row.id}><td>{row.vendor_name}</td><td>{row.member_id}</td><td>Linked</td></tr>)}</tbody></table></div>
    </section>}

    {isAdmin && <section className="surface">
      <div className="section-head"><div><div className="eyebrow">PRODUCT CONFIGURATION</div><h2>Institution financial products</h2></div></div>
      <form className="form-grid" onSubmit={createProduct}>
        <label className="form-field"><span>Product type</span><select disabled={Boolean(editingProductId)} value={product.productType} onChange={(e) => setProduct({ ...product, productType: e.target.value })}><option value="LOAN">Loan</option><option value="SAVINGS">Savings</option><option value="INVESTMENT">Investment</option></select></label>
        <label className="form-field"><span>Institution package ID</span><input required={!editingProductId} maxLength="160" readOnly={Boolean(editingProductId)} value={product.institutionPackageId} onChange={(e) => setProduct({ ...product, institutionPackageId: e.target.value })} /><small>Your system owns this ID. Suggested format: ABC-PRODUCT-UNIQUE_ID-YYYYMMDD-HHMMSS.</small></label>
        <label className="form-field"><span>Product name</span><input required maxLength="120" value={product.name} onChange={(e) => setProduct({ ...product, name: e.target.value })} /></label>
        <label className="form-field"><span>Minimum amount (GHS)</span><input required type="number" min="0.01" step="0.01" value={product.minAmount} onChange={(e) => setProduct({ ...product, minAmount: e.target.value })} /></label>
        <label className="form-field"><span>Maximum amount (GHS)</span><input required type="number" min="0.01" step="0.01" value={product.maxAmount} onChange={(e) => setProduct({ ...product, maxAmount: e.target.value })} /></label>
        <label className="form-field"><span>Annual rate (%)</span><input required type="number" min="0" step="0.01" value={product.annualRate} onChange={(e) => setProduct({ ...product, annualRate: e.target.value })} /></label>
        {product.productType === 'LOAN' ? <><label className="form-field"><span>Interest model</span><select required value={product.interestModel} onChange={(e) => setProduct({ ...product, interestModel: e.target.value })}><option value="FLAT">Flat simple interest</option><option value="REDUCING_BALANCE">Reducing balance (amortized)</option></select></label><label className="form-field"><span>Repayment frequency</span><select required value={product.repaymentFrequency} onChange={(e) => setProduct({ ...product, repaymentFrequency: e.target.value })}><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></select></label><label className="form-field"><span>Minimum term (days)</span><input required type="number" min="1" value={product.minTerm} onChange={(e) => setProduct({ ...product, minTerm: e.target.value })} /></label><label className="form-field"><span>Maximum term (days)</span><input required type="number" min="1" value={product.maxTerm} onChange={(e) => setProduct({ ...product, maxTerm: e.target.value })} /></label><label className="form-field"><span>Tenor options (months, comma separated)</span><input required value={product.tenorOptionsMonths} onChange={(e) => setProduct({ ...product, tenorOptionsMonths: e.target.value })} placeholder="3,6,12" /></label><label className="form-field"><span>Late fee (%)</span><input type="number" min="0" max="100" step="0.01" value={product.lateFee} onChange={(e) => setProduct({ ...product, lateFee: e.target.value })} /></label><label className="form-field"><span>Grace period (days)</span><input type="number" min="0" max="365" value={product.graceDays} onChange={(e) => setProduct({ ...product, graceDays: e.target.value })} /></label><label className="form-field"><span>Minimum prior contributions (GHS)</span><input type="number" min="0" step="0.01" value={product.minContributionHistory} onChange={(e) => setProduct({ ...product, minContributionHistory: e.target.value })} /></label></> : <><label className="form-field"><span>Minimum account balance (GHS)</span><input type="number" min="0" step="0.01" value={product.minBalance} onChange={(e) => setProduct({ ...product, minBalance: e.target.value })} /></label><label className="form-field"><span>Withdrawals per month (optional)</span><input type="number" min="1" value={product.withdrawalsPerMonth} onChange={(e) => setProduct({ ...product, withdrawalsPerMonth: e.target.value })} /></label><label className="form-field"><span>Lock-in period (months)</span><input type="number" min="0" value={product.savingsLockInMonths} onChange={(e) => setProduct({ ...product, savingsLockInMonths: e.target.value })} /></label><label className="form-field"><span>Contribution frequency</span><select value={product.contributionFrequency} onChange={(e) => setProduct({ ...product, contributionFrequency: e.target.value })}><option value="PER_TRANSACTION">Per transaction</option><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></select></label><label className="form-field"><span>Early withdrawal penalty (%)</span><input type="number" min="0" max="100" step="0.01" value={product.earlyWithdrawalPenalty} onChange={(e) => setProduct({ ...product, earlyWithdrawalPenalty: e.target.value })} /></label></>}
        <label className="form-field form-span"><span>Description</span><textarea maxLength="2000" value={product.description} onChange={(e) => setProduct({ ...product, description: e.target.value })} /></label>
        <div className="form-span form-actions"><button className="button button-primary" disabled={saving}>{editingProductId ? 'Save product policy' : 'Create draft product'}</button>{editingProductId && <button type="button" className="button button-secondary" onClick={() => { setEditingProductId(''); setProduct(blankProduct) }}>Cancel edit</button>}</div>
      </form>
      <div className="table-wrap"><table><thead><tr><th>Product</th><th>Type</th><th>Amount bounds</th><th>Rate</th><th>Terms / limit</th><th>Status</th><th>Action</th></tr></thead><tbody>
        {products.map((row) => <tr key={row.id}><td><strong>{row.name}</strong><small>{row.institution_package_id || 'Legacy package without institution ID'}</small><small>{row.description}</small></td><td>{row.product_type}</td><td>{amount(row.min_amount_cents)}–{amount(row.max_amount_cents)}</td><td>{(Number(row.annual_rate_basis_points) / 100).toFixed(2)}%</td><td>{row.product_type === 'LOAN' ? `${row.tenor_options_months?.join(', ') || `${row.min_term_days}–${row.max_term_days} days`} · ${row.loan_interest_model || 'model unset'} · ${row.repayment_frequency || 'frequency unset'} · late fee ${(Number(row.late_fee_basis_points || 0) / 100).toFixed(2)}%` : `Min balance ${amount(row.min_balance_cents)} · ${row.savings_lock_in_months} month lock-in · ${row.contribution_frequency || 'per transaction'}`}</td><td>{row.status}</td><td><button className="button button-secondary button-small" disabled={saving} onClick={() => editProduct(row)}>Edit</button> <select aria-label={`Status for ${row.name}`} value={row.status} disabled={saving} onChange={(e) => submit(() => institutionApi.updateFinanceProduct(row.id, e.target.value), `Product status changed to ${e.target.value}.`)}>{['DRAFT', 'ACTIVE', 'PAUSED', 'RETIRED'].map((status) => <option key={status}>{status}</option>)}</select></td></tr>)}
      </tbody></table></div>
    </section>}

    <section className="surface">
      <div className="section-head"><div><div className="eyebrow">ACCOUNT SERVICING</div><h2>Account requests and balances</h2></div></div>
      <form className="form-grid" onSubmit={createAccount}>
        <label className="form-field"><span>Verified customer</span><select required value={account.customerId} onChange={(e) => setAccount({ ...account, customerId: e.target.value })}><option value="">Select customer</option>{customers.filter((row) => row.kyc_status === 'VERIFIED').map((row) => <option key={row.id} value={row.id}>{row.first_name} {row.last_name} · {row.customer_number}</option>)}</select></label>
        <label className="form-field"><span>Linked vendor receiving this package</span><select required value={account.vendorLinkId} onChange={(e) => setAccount({ ...account, vendorLinkId: e.target.value })}><option value="">Select vendor</option>{vendorLinks.map((row) => <option key={row.id} value={row.id}>{row.vendor_name} · member {row.member_id}</option>)}</select></label>
        <label className="form-field"><span>Active product</span><select required value={account.productId} onChange={(e) => setAccount({ ...account, productId: e.target.value, termMonths: '', termDays: '' })}><option value="">Select product</option>{products.filter((row) => row.status === 'ACTIVE').map((row) => <option key={row.id} value={row.id}>{row.name} · {row.product_type}</option>)}</select></label>
        <label className="form-field"><span>Amount (GHS)</span><input required type="number" min="0.01" step="0.01" value={account.amount} onChange={(e) => setAccount({ ...account, amount: e.target.value })} /></label>
        {products.find((row) => row.id === account.productId)?.product_type === 'LOAN' && (products.find((row) => row.id === account.productId)?.tenor_options_months?.length ? <label className="form-field"><span>Loan tenor (months)</span><select required value={account.termMonths} onChange={(e) => setAccount({ ...account, termMonths: e.target.value })}><option value="">Select tenor</option>{products.find((row) => row.id === account.productId).tenor_options_months.map((months) => <option key={months} value={months}>{months} months</option>)}</select></label> : <label className="form-field"><span>Term (days)</span><input required type="number" min="1" value={account.termDays} onChange={(e) => setAccount({ ...account, termDays: e.target.value })} /></label>)}
        <div className="form-span form-actions"><button className="button button-primary" disabled={saving}>Submit account request</button></div>
      </form>
      <div className="table-wrap"><table><thead><tr><th>Account</th><th>Customer</th><th>Product</th><th>Requested</th><th>Outstanding / balance</th><th>Status</th>{canReview && <th>Approval</th>}</tr></thead><tbody>
        {accounts.map((row) => { const next = row.installments?.find((installment) => installment.status !== 'PAID'); const split = row.split_allocations?.[0]; return <tr key={row.id}><td>{row.account_number}{next && <small>Next installment {next.dueDate} · {amount(Number(next.amountDueCents) - Number(next.amountPaidCents))} · {next.status}</small>}{split && <small>Latest split {split.type.replaceAll('_', ' ').toLowerCase()} · {amount(split.amountCents)}</small>}</td><td>{row.first_name} {row.last_name}</td><td>{row.product_name}</td><td>{amount(row.requested_amount_cents)}</td><td>{row.product_type === 'LOAN' ? amount(row.outstanding_cents) : amount(row.balance_cents)}</td><td>{row.status}</td>{canReview && <td>{row.status === 'PENDING_APPROVAL' && <><button className="button button-secondary button-small" disabled={saving} onClick={() => submit(() => institutionApi.decideFinanceAccount(row.id, 'APPROVED'), 'Account request approved.')}>Approve</button> <button className="button button-secondary button-small" disabled={saving} onClick={() => submit(() => institutionApi.decideFinanceAccount(row.id, 'REJECTED'), 'Account request rejected.')}>Reject</button></>}</td>}</tr>})}
      </tbody></table></div>
    </section>

    {isAdmin && <section className="surface">
      <div className="section-head"><div><div className="eyebrow">INSTITUTION FEE POLICY</div><h2>Transaction fee configuration</h2></div></div>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); submit(() => institutionApi.saveFinanceFees(feeOperations.map((operation) => ({ operation, ...feeForms[operation], feeValue: Number(feeForms[operation].feeValue) }))), 'Fee rules saved.') }}>
        {feeOperations.map((operation) => <div className="form-field" key={operation}><span>{feeLabels[operation]}</span><div className="inline-fields"><select value={feeForms[operation].feeType} onChange={(e) => setFeeForms({ ...feeForms, [operation]: { ...feeForms[operation], feeType: e.target.value } })}><option value="NONE">No fee</option><option value="FIXED">Fixed GHS</option><option value="PERCENTAGE">Percentage</option></select><input aria-label={`${feeLabels[operation]} fee`} type="number" min="0" step="0.01" max={feeForms[operation].feeType === 'PERCENTAGE' ? '100' : undefined} disabled={feeForms[operation].feeType === 'NONE'} value={feeForms[operation].feeValue} onChange={(e) => setFeeForms({ ...feeForms, [operation]: { ...feeForms[operation], feeValue: e.target.value } })} /></div></div>)}
        <div className="form-span form-actions"><button className="button button-primary" disabled={saving}>Save fee rules</button></div>
      </form><p className="footnote">Fees apply when institution Eganow payments are initiated: collection fees are added to the amount collected; withdrawal fees and configured early-withdrawal penalties reduce the payout.</p>
    </section>}

    <section className="surface">
      <div className="section-head"><div><div className="eyebrow">LEDGER OPERATIONS</div><h2>Record and review transactions</h2></div></div>
      <form className="form-grid" onSubmit={createTransaction}>
        <label className="form-field"><span>Account</span><select required value={transactionForm.accountId} onChange={(e) => setTransactionForm({ ...transactionForm, accountId: e.target.value })}><option value="">Select active account</option>{accounts.filter((row) => ['APPROVED', 'ACTIVE', 'OVERDUE'].includes(row.status)).map((row) => <option key={row.id} value={row.id}>{row.account_number} · {row.first_name} {row.last_name}{row.status === 'OVERDUE' ? ' · OVERDUE' : ''}</option>)}</select></label>
        <label className="form-field"><span>Operation</span><select value={transactionForm.transactionType} onChange={(e) => setTransactionForm({ ...transactionForm, transactionType: e.target.value })}>{['DEPOSIT', 'WITHDRAWAL', 'LOAN_DISBURSEMENT'].map((type) => <option key={type}>{type}</option>)}</select></label>
        <label className="form-field"><span>Amount (GHS)</span><input required type="number" min="0.01" step="0.01" value={transactionForm.amount} onChange={(e) => setTransactionForm({ ...transactionForm, amount: e.target.value })} /></label>
        <label className="form-field"><span>Institution transaction reference</span><input required minLength="3" maxLength="160" value={transactionForm.externalReference} onChange={(e) => setTransactionForm({ ...transactionForm, externalReference: e.target.value })} /><small>Suggested format: ABC-PRODUCT-UNIQUE_ID-YYYYMMDD-HHMMSS. Your institution owns and generates this ID.</small></label>
        <label className="form-field"><span>Customer mobile (233XXXXXXXXX)</span><input required pattern="233[0-9]{9}" value={transactionForm.phoneNumber} onChange={(e) => setTransactionForm({ ...transactionForm, phoneNumber: e.target.value })} /></label>
        <label className="form-field form-span"><span>Note</span><input maxLength="1000" value={transactionForm.note} onChange={(e) => setTransactionForm({ ...transactionForm, note: e.target.value })} /></label>
        <div className="form-span form-actions"><button className="button button-primary" disabled={saving}>Record pending transaction</button></div>
      </form>
      <p className="footnote">This is an institution ledger entry awaiting approval. It does not collect or disburse funds through Eganow.</p>
      <div className="table-wrap"><table><thead><tr><th>Reference</th><th>Customer</th><th>Operation</th><th>Amount</th><th>Status</th>{canReview && <th>Review</th>}</tr></thead><tbody>
        {transactions.map((row) => <tr key={row.id}><td>{row.external_reference}<small>{row.gateway_reference || row.payment_gateway_status || ''}</small></td><td>{row.first_name} {row.last_name}</td><td>{row.transaction_type}</td><td>{amount(row.amount_cents)}<small>Fee {amount(row.fee_cents)}</small></td><td>{row.status}</td>{canReview && <td>{row.status === 'PENDING_APPROVAL' ? <><button className="button button-secondary button-small" disabled={saving} onClick={() => submit(() => institutionApi.decideFinanceTransaction(row.id, { decision: 'POSTED' }), 'Eganow transaction initiated.')}>Approve & initiate</button> <button className="button button-secondary button-small" disabled={saving} onClick={() => submit(() => institutionApi.decideFinanceTransaction(row.id, { decision: 'REJECTED' }), 'Transaction rejected.')}>Reject</button></> : row.status === 'PENDING_GATEWAY' && <button className="button button-secondary button-small" disabled={saving} onClick={() => submit(() => institutionApi.reconcileFinanceTransaction(row.id), 'Eganow status refreshed.')}>Check Eganow status</button>}</td>}</tr>)}
      </tbody></table></div>
    </section>
  </>
}
