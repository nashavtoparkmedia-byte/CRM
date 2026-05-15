/**
 * app_settings — single-row table holding operator-editable global
 * configuration that used to live in env vars only. Each row is a
 * key/value pair; values are TEXT and parsed at read-site.
 *
 * Canonical keys:
 *   - responses_poll_default_sec: integer seconds, default for
 *     accounts without a per-account override.
 *
 * Kept deliberately generic (no per-key schema) so adding new
 * settings doesn't require another migration.
 */
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const appSettings = pgTable('avito_app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AppSetting = typeof appSettings.$inferSelect;
export type NewAppSetting = typeof appSettings.$inferInsert;
