import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { RESPONSE_STATUSES } from '@avito/shared';
import { accounts } from './accounts';

export const responseStatusEnum = pgEnum('response_status', RESPONSE_STATUSES);

export const responses = pgTable('avito_responses',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    externalIdSource: text('external_id_source').notNull(),
    chatHref: text('chat_href'),
    chatUrl: text('chat_url'),
    candidateName: text('candidate_name'),
    vacancyTitle: text('vacancy_title'),
    phone: text('phone'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    isUnreadDetected: boolean('is_unread_detected').notNull().default(false),
    status: responseStatusEnum('status').notNull().default('new'),
    rawDataJson: jsonb('raw_data_json'),
    // STEP B1 operator surface additions.
    preview: text('preview'),
    phoneRevealedAt: timestamp('phone_revealed_at', { withTimezone: true }),
    phoneRevealFailureReason: text('phone_reveal_failure_reason'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processedBy: text('processed_by'),
    // Auto-reply outcome tracking. Idempotent: once autoReplySentAt is
    // set, the handler never retries.
    autoReplySentAt: timestamp('auto_reply_sent_at', { withTimezone: true }),
    autoReplyStatus: text('auto_reply_status'), // 'sent' | 'failed' | null
    autoReplyError: text('auto_reply_error'),
    // Telegram notification message id for this lead. Populated by the
    // worker when the "🆕 Новый лид" message is sent. Used by the API
    // mark-processed endpoint to editMessageText the original TG card
    // in-place (✅ Лид обработан) instead of posting a follow-up.
    // null = TG was disabled/unconfigured or the send failed.
    telegramMessageId: integer('telegram_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqAccountExternalId: uniqueIndex('uq_responses_account_external').on(
      t.accountId,
      t.externalId,
    ),
  }),
);

export type Response = typeof responses.$inferSelect;
export type NewResponse = typeof responses.$inferInsert;
