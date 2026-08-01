/**
 * The queue notifications are delivered on.
 *
 * The name is the one `NotificationsModule` has always registered. The queue
 * existed and nothing injected it, processed it, or added to it — delivery went
 * to trigger.dev instead, which is optional and absent from the compose stack,
 * so every notification since has been an unhandled connection error and the
 * `Notification` table has never held a row. See ENG-89.
 */
export const NOTIFICATIONS_QUEUE = 'notifications';

/** Deliver one notification event: the in-app row, and the email. */
export const DELIVER_NOTIFICATION_JOB = 'deliverNotification';

/**
 * How many times a delivery is retried before Bull gives up.
 *
 * Notification delivery reads the issue graph and talks to SMTP, so the
 * failures worth retrying are transient ones. Backed off so a mail host that is
 * briefly refusing connections is waited out rather than hammered.
 */
export const DELIVERY_ATTEMPTS = 3;
export const DELIVERY_BACKOFF_MS = 5_000;
