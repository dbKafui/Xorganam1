import { SmtpSender } from './senders/SmtpSender.js'
import { SendGridSender } from './senders/SendGridSender.js'
import { SesSender } from './senders/SesSender.js'
import { MailgunSender } from './senders/MailgunSender.js'

export const mailSenderRegistry = new Map([
  ['smtp', (config, policy) => new SmtpSender(config, policy)],
  ['sendgrid', (config, policy) => new SendGridSender(config, policy)],
  ['ses', (config, policy) => new SesSender(config, policy)],
  ['mailgun', (config, policy) => new MailgunSender(config, policy)]
])

export function getRegisteredMailSender(providerType, config, policy) {
  const createSender = mailSenderRegistry.get(providerType)
  if (!createSender) throw new Error('The configured email provider is not registered.')
  return createSender(config, policy)
}