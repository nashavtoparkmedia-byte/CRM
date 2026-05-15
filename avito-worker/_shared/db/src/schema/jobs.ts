import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { JOB_STATUSES, JOB_TYPES } from '@avito/shared';

export const jobTypeEnum = pgEnum('job_type', JOB_TYPES);
export const jobStatusEnum = pgEnum('job_status', JOB_STATUSES);

export const jobs = pgTable('avito_jobs',
  {
    id: serial('id').primaryKey(),
    type: jobTypeEnum('type').notNull(),
    payloadJson: jsonb('payload_json').notNull().default({}),
    status: jobStatusEnum('status').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxStatusRunAt: index('idx_jobs_status_run_at').on(t.status, t.runAt),
  }),
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
