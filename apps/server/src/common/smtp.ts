import type SMTPTransport from 'nodemailer/lib/smtp-transport';

/**
 * How the server reaches its SMTP server, for every mail it sends.
 *
 * Sign-in mail and notification mail used to be configured apart, and the two
 * disagreed. The notification copy forced implicit TLS, so against the usual
 * STARTTLS server on port 587 every notification failed with "wrong version
 * number" while sign-in mail went out. It also switched certificate checks off
 * and ignored SMTP_DEFAULT_FROM.
 *
 * SMTP_USE_SLS=true asks for implicit TLS, as on port 465. Otherwise the
 * connection starts in the clear and upgrades when the server offers STARTTLS.
 * Certificates are always checked.
 */
export function smtpTransportOptions(): SMTPTransport.Options {
  const user = process.env.SMTP_USER;

  return {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || undefined,
    secure: process.env.SMTP_USE_SLS === 'true',
    auth: user ? { user, pass: process.env.SMTP_PASSWORD } : undefined,
  };
}

/** Whether an SMTP server is set up at all. Without one, mail is not sent. */
export function smtpConfigured(): boolean {
  return !!process.env.SMTP_HOST;
}

/** The sender every mail names. */
export function smtpFrom(): string {
  return process.env.SMTP_DEFAULT_FROM || 'Vantik <noreply@localhost>';
}
