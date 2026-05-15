import { index, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const accountSnapshot = pgTable('avito_account_snapshot',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    capturedAt: timestamp('captured_at').notNull(),
    pageKind: text('page_kind').notNull(),
    heading: text('heading').notNull(),
    nextAction: text('next_action').notNull(),
    itemsCount: integer('items_count'),
    accountName: text('account_name').notNull().default(''),
    profileType: text('profile_type').notNull().default('unknown'),
  },
  (t) => ({
    idxAccountCaptured: index('idx_account_snapshot_account_captured').on(
      t.accountId,
      t.capturedAt,
    ),
  }),
);

export type AccountSnapshot = typeof accountSnapshot.$inferSelect;
export type NewAccountSnapshot = typeof accountSnapshot.$inferInsert;
