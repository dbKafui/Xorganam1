export function resolveMerchantNotificationPreferences(settings) {
  return {
    notifySms: settings?.notify_sms !== false,
    notifyEmail: settings?.notify_email === true,
    contactEmail: typeof settings?.contact_email === 'string' ? settings.contact_email.trim() : ''
  }
}