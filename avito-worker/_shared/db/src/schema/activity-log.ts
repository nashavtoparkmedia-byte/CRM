import { index, jsonb, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const activityLog = pgTable('avito_activity_log',
  {
    id: serial('id').primaryKey(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    action: text('action').notNull(),
    detailsJson: jsonb('details_json'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxEntity: index('idx_activity_entity').on(t.entityType, t.entityId),
    idxCreatedAt: index('idx_activity_created_at').on(t.createdAt),
  }),
);

export type ActivityLogEntry = typeof activityLog.$inferSelect;
export type NewActivityLogEntry = typeof activityLog.$inferInsert;
