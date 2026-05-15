/**
 * auth_sessions — server-side session store for AUTH_MODE=builtin.
 *
 * Each row corresponds to one active browser session (one cookie).
 * Created on POST /auth/login, deleted on POST /auth/logout, evaluated
 * lazily — a SELECT-by-id is cheap and we don't need a sweeper.
 *
 * Not used in AUTH_MODE=upstream (Box 2). There authentication comes
 * from a signed header set by the upstream nginx, so no server-side
 * state is needed.
 */
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const authSessions = pgTable('avito_auth_sessions',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => ({
    expiresAtIdx: index('auth_sessions_expires_at_idx').on(t.expiresAt),
  }),
);

export type AuthSession = typeof authSessions.$inferSelect;
export type NewAuthSession = typeof authSessions.$inferInsert;
