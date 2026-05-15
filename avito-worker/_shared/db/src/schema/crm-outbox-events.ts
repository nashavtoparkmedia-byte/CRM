/**
 * crm_outbox_events — durable queue of CRM-bound events.
 *
 * Decouples "lead saved" / "account state changed" from "webhook
 * delivered". Collect-handler (and the API mark-processed endpoint)
 * write one row per event, then attempt fire-and-forget delivery.
 * Failed rows stay here until crmOutboxTick (sibling tick inside the
 * existing JobPollerService) sweeps them and retries with backoff.
 *
 * sent_status:
 *   - 'pending'          — row written, no delivery attempted yet
 *   - 'ok'               — CRM responded 2xx
 *   - 'failed'           — last attempt failed, scheduled for retry
 *   - 'permanent_failed' — exceeded retry cap (3 attempts), gave up
 *
 * payload is JSONB on purpose — adding new event types or fields
 * does not require a migration.
 */
import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const crmOutboxEvents = pgTable('avito_crm_outbox_events',
  {
    id: serial('id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    sentStatus: text('sent_status').notNull().default('pending'),
    retryCount: integer('retry_count').notNull().default(0),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    eventIdUnique: uniqueIndex('crm_outbox_events_event_id_unique').on(
      t.eventId,
    ),
    statusNextRetryIdx: index(
      'crm_outbox_events_sent_status_next_retry_at_idx',
    ).on(t.sentStatus, t.nextRetryAt),
    createdAtIdx: index('crm_outbox_events_created_at_idx').on(t.createdAt),
  }),
);

export type CrmOutboxEvent = typeof crmOutboxEvents.$inferSelect;
export type NewCrmOutboxEvent = typeof crmOutboxEvents.$inferInsert;

export type CrmOutboxStatus =
  | 'pending'
  | 'ok'
  | 'failed'
  | 'permanent_failed';

export const CRM_OUTBOX_MAX_RETRIES = 3;
