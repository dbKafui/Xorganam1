import { classifyPaymentStatus } from '../lib/statusOutcome.js'

export default function PaymentStatusDetails({ status, failureReason, supportEmail = 'support@xorganam.example', supportPhone = '+233 00 000 0000' }) {
  const outcome = classifyPaymentStatus({ status, failureReason })

  return (
    <section className="payment-status-details" aria-live="polite" aria-labelledby="payment-status-title">
      <h2 id="payment-status-title">{outcome.title}</h2>
      <p>{outcome.message}</p>
      {(outcome.state === 'manual-reconciliation' || outcome.state === 'blocked' || outcome.state === 'failed') && (
        <ul>
          <li>Do not submit the same payment again until this status is resolved.</li>
          <li>Keep your payment reference and amount available for support.</li>
          <li>Contact <a href={`mailto:${supportEmail}`}>{supportEmail}</a> or <a href={`tel:${supportPhone}`}>{supportPhone}</a> for assistance.</li>
        </ul>
      )}
      {outcome.state === 'pending' && (
        <p>Check this page again in a few minutes. If status remains unclear after verification, contact support.</p>
      )}
      {outcome.state === 'partial' && (
        <p>Review the completed and outstanding settlement legs before retrying. The payment may already have been credited to part of the order.</p>
      )}
    </section>
  )
}
