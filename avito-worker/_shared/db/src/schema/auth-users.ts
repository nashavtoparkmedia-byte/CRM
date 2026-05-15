/**
 * auth_users — multi-user table for builtin-mode authentication.
 *
 * Эволюция singleton'а auth_credentials. Каждый ряд — отдельный
 * пользователь, может логиниться в standalone Avito с username +
 * password. В upstream-mode (Box 2) этой таблицей не пользуемся —
 * там auth наследуется от CRM cookie.
 *
 * disabled_at != null = пользователь отключен (нельзя залогиниться,
 * но запись сохранена для аудита). UNIQUE по LOWER(username) — двух
 * разных регистрах одного логина быть не может.
 */
import { index, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const authUsers = pgTable('avito_auth_users',
  {
    id: serial('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text('updated_by'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (t) => ({
    // Уникальность кейс-инсенситивного юзернейма поднимается через
    // raw SQL в миграции — drizzle-orm не выражает LOWER() index.
    // Дублируем индекс декларативно для select-планировщика.
    usernameIdx: index('auth_users_username_lookup').on(t.username),
  }),
);

export type AuthUser = typeof authUsers.$inferSelect;
export type NewAuthUser = typeof authUsers.$inferInsert;
