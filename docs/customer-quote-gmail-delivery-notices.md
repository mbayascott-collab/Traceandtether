# Gmail quote bounce notices

## Supported Gmail behavior

Gmail's API does not emit a per-message delivery webhook. Its push-notification feature reports mailbox changes through Google Cloud Pub/Sub, not whether a sent message was delivered. This integration therefore polls the connected Gmail inbox for delivery-status reports and forwards matching permanent bounces to `/api/webhooks/customer-quote-email`.

The poller runs every two minutes while the application server is running. It searches recent messages from `mailer-daemon` and `postmaster`, then accepts only permanent DSN failures that include the quote number and exact send-attempt timestamp. Those headers are added to each quote email so an old bounce cannot change the result of a later retry. The event is authenticated to the existing quote webhook with the workspace secret; no secret is placed in the email or provider request.

## Required settings

- Keep the Gmail integration connected in Replit with Gmail read and send access.
- Add `CUSTOMER_QUOTE_EMAIL_WEBHOOK_SECRET` as a shared workspace secret, using at least 32 random characters. The Gmail scanner uses it only when forwarding normalized bounce events to the app's quote webhook.
- Keep the app server running to scan the Gmail inbox. The scanner searches the last seven days, so notices older than that are not discovered automatically after a long outage.

## Event mapping and limits

| Gmail result | Quote status |
| --- | --- |
| Gmail accepts the send request | `sent` (acceptance is not proof of delivery) |
| Permanent DSN failure (`Action: failed`, `Status: 5.x.x`) for the current attempt | `bounced` |
| Gmail rejects the send request immediately | `failed` |
| Temporary DSN delay (`Status: 4.x.x`) | No status change |
| Successful delivery confirmation | Not available from Gmail |

Gmail's mailbox-change Pub/Sub notifications are not delivery receipts. This implementation does not claim a quote was delivered just because Gmail accepted the send.
