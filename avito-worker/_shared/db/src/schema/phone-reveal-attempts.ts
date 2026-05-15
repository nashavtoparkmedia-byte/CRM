import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { PHONE_REVEAL_ATTEMPT_STATUSES } from '@avito/shared';
import { responses } from './responses';

export const phoneRevealAttemptStatusEnum = pgEnum(
  'phone_reveal_attempt_status',
  PHONE_REVEAL_ATTEMPT_STATUSES,
);

export const phoneRevealAttempts = pgTable('avito_phone_reveal_attempts',
  {
    id: serial('id').primaryKey(),
    responseId: integer('response_id')
      .notNull()
      .references(() => responses.id, { onDelete: 'cascade' }),
    attemptNo: integer('attempt_no').notNull(),
    status: phoneRevealAttemptStatusEnum('status').notNull(),
    clickedReveal: boolean('clicked_reveal').notNull().default(false),
    errorMessage: text('error_message'),
    screenshotPath: text('screenshot_path'),
    htmlSnapshotPath: text('html_snapshot_path'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqAttempt: uniqueIndex('uq_phone_reveal_response_attempt').on(
      t.responseId,
      t.attemptNo,
    ),
  }),
);

export type PhoneRevealAttempt = typeof phoneRevealAttempts.$inferSelect;
export type NewPhoneRevealAttempt = typeof phoneRevealAttempts.$inferInsert;
