import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import {
  accounts,
  activityLog,
  appSettings,
  crmOutboxEvents,
  jobs,
  type Database,
  type Job,
} from '@avito/db';
import { JOB_POLL_INTERVAL_MS } from '@avito/shared';
import { DB_TOKEN } from '../db/db.module';
import { JobDispatcherService } from './job-dispatcher.service';
import {
  attemptDelivery,
  readCrmSettings,
} from '../notifications/crm';
import type { AnyCrmEnvelope } from '../notifications/crm-dto';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── responses polling tick (B6 + FS1..FS5) ──────────────────────────
//
// Period of the scheduling tick loop. Independent from the main job
// dispatcher loop. A decision tick every 30s is fine-grained enough for
// the per-account intervals we care about (60s+) while not flooding
// the DB with trivial SELECTs.
const RESPONSES_TICK_MS = 30_000;

// Global default when an account doesn't set its own override AND the
// `app_settings.responses_poll_default_sec` row is absent. Tunable via
// env at worker startup; lower clamp 30s avoids accidental 0 from a bad
// env value.
const DEFAULT_RESPONSES_INTERVAL_SEC = Math.max(
  30,
  Number(process.env.RESPONSES_POLL_INTERVAL_SEC) || 600,
);

// FS1 — jitter added to scheduled nextDueAt as ±JITTER_PERCENT of the
// effective interval. 0.15 = ±15%. Prevents 40 accounts with identical
// intervals from enqueueing on the exact same tick after a warm-up.
const JITTER_PERCENT = 0.15;

// FS3 — fleet-wide cap on simultaneous collect_responses jobs. Applies
// to pending+processing combined. With the worker processing jobs
// sequentially, this primarily limits queue depth and protects from
// bursts when many accounts become due close together.
const MAX_PARALLEL_COLLECT_JOBS = Math.max(
  1,
  Number(process.env.RESPONSES_MAX_PARALLEL) || 3,
);

// FS4 — multiplier applied to the normal interval once a run has been
// classified as failure (pageKind in {ip_blocked, login_required,
// unknown} OR job status=failed). In-memory, per-account; cleared on
// the next successful run.
const FAILURE_COOLDOWN_MULT = 2;

// FS5 — threshold for extended backoff. After N CONSECUTIVE failures
// the scheduler switches to a longer delay (see below) until the next
// success.
const FAILURE_COOLDOWN_THRESHOLD = 3;

// FS5 — extended backoff duration after the threshold is reached. The
// larger of a hard floor (15 min) and 4× the interval.
const EXTENDED_COOLDOWN_MIN_SEC = 15 * 60;
const EXTENDED_COOLDOWN_MULT = 4;

// OPS1 — global safety ceiling on collect_responses enqueues per
// rolling minute. Purely defensive: at normal operating cadence (40
// accounts × 6 scans/hour = 4 jobs/min) we're far below this, but a
// misconfigured interval (e.g. operator accidentally sets 1 min for
// every account), a queue-replay bug, or a time-jump glitch could
// cause a burst. The cap ensures we never flood Avito with hundreds
// of requests a minute even in pathological cases. In-memory sliding
// window, no persistent counter.
const MAX_JOBS_PER_MINUTE = Math.max(
  1,
  Number(process.env.MAX_JOBS_PER_MINUTE) || 60,
);
const RATE_WINDOW_MS = 60_000;

// CRM outbox sweeper — sibling tick to responsesTick. Same in-process
// poller, no new infrastructure. Runs every 30s, picks up to N failed
// or pending events whose next_retry_at is now/past, and re-attempts
// delivery via attemptDelivery (3s timeout per event, see crm.ts).
//
// Cap per tick prevents a large backlog from stalling the worker on
// any single sweep — backlog clears naturally over multiple ticks.
const CRM_OUTBOX_TICK_MS = 30_000;
const CRM_OUTBOX_MAX_PER_TICK = Math.max(
  1,
  Number(process.env.CRM_OUTBOX_MAX_PER_TICK) || 50,
);

// Per-account scheduling state. Held in-memory ONLY — by design (FS2):
// on worker restart every account gets a fresh random initial delay,
// so 40 accounts never re-start on the same tick. Lost state is benign
// because the worst case is one "extra" scan after restart.
type AccountSched = {
  // When the next tick should consider enqueueing this account. After
  // enqueue, pushed to far future until job outcome is observed.
  nextDueAt: Date;
  // Running count of consecutive FS4-classified failures. Reset to 0
  // on the next success.
  failureCount: number;
  // Label for the most recent scheduling decision — used by the log
  // line in FS6 and to distinguish normal / cooldown / extended.
  cooldownKind: 'normal' | 'cooldown' | 'extended_cooldown';
  // Highest jobs.id whose OUTCOME we've already folded into this
  // schedule. Jobs with a lower or equal id are ignored.
  lastObservedJobId: number;
  // Snapshot of effective interval at last update. Kept fresh each
  // tick so per-account / global interval edits propagate without a
  // worker restart.
  intervalSec: number;
};

@Injectable()
export class JobPollerService {
  private readonly logger = new Logger(JobPollerService.name);
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private responsesLoopPromise: Promise<void> | null = null;
  private crmOutboxLoopPromise: Promise<void> | null = null;

  // FS2 — per-account scheduling state, strictly in-memory. Ephemeral
  // on restart by design so the fleet doesn't re-start in sync.
  private accountSched = new Map<number, AccountSched>();

  // OBS2 — in-memory dedupe set for "skip auto-paused account" log
  // lines. Without this, every tick would log the same paused account
  // every 30s (spam). On first observation of pause: log. On operator
  // unpause: remove from set so next pause re-logs. Lost on restart
  // (and logged again on first tick post-restart), which is actually
  // useful for noticing still-paused accounts after a restart.
  private loggedAutoPaused = new Set<number>();

  // OPS1 — rolling-window timestamps of recently enqueued
  // collect_responses jobs. Each entry is a ms-since-epoch of the
  // enqueue. Pruned at the start of each tick to drop entries older
  // than RATE_WINDOW_MS. `length` then gives the current rate.
  // Ephemeral — restarted workers start with an empty window, which
  // means the first minute after restart is not rate-limited by
  // pre-restart history. Acceptable because restart + 60 simultaneous
  // enqueues is already bounded by FS3's MAX_PARALLEL_COLLECT_JOBS.
  private recentEnqueues: number[] = [];

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    @Inject(JobDispatcherService) private readonly dispatcher: JobDispatcherService,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
    this.responsesLoopPromise = this.responsesLoop();
    this.crmOutboxLoopPromise = this.crmOutboxLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) await this.loopPromise;
    if (this.responsesLoopPromise) await this.responsesLoopPromise;
    if (this.crmOutboxLoopPromise) await this.crmOutboxLoopPromise;
  }

  private async loop(): Promise<void> {
    this.logger.log('poller loop started');
    while (this.running) {
      try {
        const processed = await this.tick();
        if (!processed) await sleep(JOB_POLL_INTERVAL_MS);
      } catch (err) {
        this.logger.error(`tick failed: ${String(err)}`);
        await sleep(JOB_POLL_INTERVAL_MS);
      }
    }
    this.logger.log('poller loop stopped');
  }

  private async tick(): Promise<boolean> {
    const now = new Date();
    const [job] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, 'pending'), lte(jobs.runAt, now)))
      .orderBy(jobs.runAt)
      .limit(1);
    if (!job) return false;

    const claimed = await this.db
      .update(jobs)
      .set({
        status: 'processing',
        attempt: job.attempt + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, 'pending')))
      .returning();
    if (claimed.length === 0) return false;
    const claimedJob: Job = claimed[0]!;

    this.logger.log(`processing job ${claimedJob.id} type=${claimedJob.type}`);
    try {
      await this.dispatcher.dispatch(claimedJob);
      await this.db
        .update(jobs)
        .set({ status: 'done', lastError: null, updatedAt: new Date() })
        .where(eq(jobs.id, claimedJob.id));
      this.logger.log(`job ${claimedJob.id} done`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.db
        .update(jobs)
        .set({ status: 'failed', lastError: msg, updatedAt: new Date() })
        .where(eq(jobs.id, claimedJob.id));
      this.logger.error(`job ${claimedJob.id} failed: ${msg}`);
    }
    return true;
  }

  // Responses polling loop — runs every RESPONSES_TICK_MS and
  // enqueues collect_responses jobs for accounts that are due.
  // Scheduling is fleet-safe: jittered, staggered on startup, capped
  // by concurrency, and adapts via cooldown / extended backoff on
  // failures (FS1..FS5). Handler (CollectResponsesHandler) is
  // UNCHANGED — only enqueue decisions live here.
  private async responsesLoop(): Promise<void> {
    this.logger.log(
      `responses tick loop started (period=${RESPONSES_TICK_MS}ms ` +
        `defaultIntervalSec=${DEFAULT_RESPONSES_INTERVAL_SEC} ` +
        `jitter=±${Math.round(JITTER_PERCENT * 100)}% ` +
        `maxParallel=${MAX_PARALLEL_COLLECT_JOBS} ` +
        `maxPerMinute=${MAX_JOBS_PER_MINUTE})`,
    );
    while (this.running) {
      try {
        await this.responsesTick();
      } catch (err) {
        this.logger.error(
          `responses tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await sleep(RESPONSES_TICK_MS);
    }
    this.logger.log('responses tick loop stopped');
  }

  private async responsesTick(): Promise<void> {
    const now = new Date();
    const globalDefaultSec = await this.readGlobalDefaultSec();

    // Pull non-(operator-)paused accounts. Auto-paused (OBS2) is a
    // separate flag — we fetch it here and filter in JS so we can
    // log-and-skip each auto-paused account explicitly.
    const rawCandidates = await this.db
      .select({
        id: accounts.id,
        intervalSec: accounts.responsesPollIntervalSec,
        autoPausedAt: accounts.autoPausedAt,
        autoPauseReason: accounts.autoPauseReason,
      })
      .from(accounts)
      .where(ne(accounts.status, 'paused'));

    // OBS2 — partition into auto-paused (skip + log) and candidates.
    // Auto-paused accounts don't participate in scheduling at all;
    // their sched state is also removed so that a future manual
    // unpause triggers a fresh FS2 initial delay.
    const candidates: typeof rawCandidates = [];
    const stillPaused = new Set<number>();
    for (const a of rawCandidates) {
      if (a.autoPausedAt) {
        stillPaused.add(a.id);
        this.accountSched.delete(a.id);
        if (!this.loggedAutoPaused.has(a.id)) {
          this.logger.log(
            `skip auto-paused account: accountId=${a.id} ` +
              `reason=${a.autoPauseReason ?? 'unknown'} ` +
              `pausedAt=${a.autoPausedAt.toISOString()}`,
          );
          this.loggedAutoPaused.add(a.id);
        }
        continue;
      }
      candidates.push(a);
    }
    // Forget dedupe state for accounts that are no longer paused
    // (operator unpaused them) so a future re-pause logs again.
    for (const id of Array.from(this.loggedAutoPaused)) {
      if (!stillPaused.has(id)) this.loggedAutoPaused.delete(id);
    }

    // Prune in-memory state for accounts that were removed or paused
    // since last tick. Keeps the map from growing indefinitely.
    const activeIds = new Set(candidates.map((c) => c.id));
    for (const id of Array.from(this.accountSched.keys())) {
      if (!activeIds.has(id)) this.accountSched.delete(id);
    }

    // FS1 + FS4 + FS5 — initialize state for brand-new accounts and
    // fold in the outcome of the most recent finished job for each
    // account we already track. This is where success clears the
    // cooldown and failure kicks it in.
    for (const a of candidates) {
      const intervalSec = a.intervalSec ?? globalDefaultSec;
      await this.refreshAccountSched(a.id, intervalSec, now);
    }

    // FS3 — fleet-wide concurrency cap. Counts pending + processing
    // collect_responses jobs across ALL accounts. If at the cap, we
    // don't enqueue anything this cycle and retry next tick. Due
    // accounts simply wait — their nextDueAt is in the past, they'll
    // be chosen as soon as a slot frees up.
    const [activeRow] = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, 'collect_responses'),
          inArray(jobs.status, ['pending', 'processing']),
        ),
      );
    const activeCount = Number(activeRow?.c ?? 0);

    if (activeCount >= MAX_PARALLEL_COLLECT_JOBS) {
      this.logger.log(
        `responses tick: active=${activeCount} cap=${MAX_PARALLEL_COLLECT_JOBS} → no enqueue this cycle`,
      );
      return;
    }

    // OPS1 — prune rolling window. Anything older than RATE_WINDOW_MS
    // no longer counts toward the per-minute cap. Done once per tick
    // (not per candidate) — good enough since a tick enqueues at most
    // MAX_PARALLEL_COLLECT_JOBS jobs.
    const windowStart = now.getTime() - RATE_WINDOW_MS;
    this.recentEnqueues = this.recentEnqueues.filter((t) => t > windowStart);

    // Order candidates by nextDueAt ascending so the most overdue
    // account is picked first. Stable tie-break by the original row
    // order (which is id-ordered in PostgreSQL for small tables).
    const sorted = [...candidates].sort((x, y) => {
      const sx = this.accountSched.get(x.id);
      const sy = this.accountSched.get(y.id);
      if (!sx || !sy) return 0;
      return sx.nextDueAt.getTime() - sy.nextDueAt.getTime();
    });

    let slots = MAX_PARALLEL_COLLECT_JOBS - activeCount;

    // OPS1 — dedupe WARN so we don't spam the log once per tick when
    // the cap is held for a while. Reset when the cap is no longer
    // hit (next tick where we're below the limit again).
    let rateWarnLoggedThisTick = false;

    for (const a of sorted) {
      if (slots <= 0) break;
      const sched = this.accountSched.get(a.id);
      if (!sched) continue;
      if (sched.nextDueAt > now) continue;

      // OPS1 — fleet-wide per-minute cap. Checked before the per-account
      // duplicate guard so an over-capacity fleet doesn't even query
      // the jobs table. On hit: log WARN once, stop enqueuing this
      // tick, leave nextDueAt alone so the account is re-considered
      // on the next tick (natural back-pressure — the oldest due will
      // just keep waiting).
      if (this.recentEnqueues.length >= MAX_JOBS_PER_MINUTE) {
        if (!rateWarnLoggedThisTick) {
          this.logger.warn(
            `responses tick: fleet rate cap hit — ` +
              `recentEnqueues=${this.recentEnqueues.length} ` +
              `cap=${MAX_JOBS_PER_MINUTE}/min → skipping remaining enqueues this cycle`,
          );
          rateWarnLoggedThisTick = true;
        }
        break;
      }

      // Per-account duplicate guard — a second safety net on top of
      // the fleet cap. Prevents a second job for the same account
      // even in rare cases (multiple workers, race, manual inserts).
      const existing = await this.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, 'collect_responses'),
            inArray(jobs.status, ['pending', 'processing']),
            sql`${jobs.payloadJson}->>'accountId' = ${String(a.id)}`,
          ),
        )
        .limit(1);
      if (existing.length > 0) continue;

      try {
        const [inserted] = await this.db
          .insert(jobs)
          .values({
            type: 'collect_responses',
            payloadJson: { accountId: a.id },
          })
          .returning({ id: jobs.id });
        // OPS1 — record this enqueue in the rolling window.
        this.recentEnqueues.push(now.getTime());
        // FS6 — one INFO line per enqueue, machine-parseable.
        this.logger.log(
          `responses scheduling decision: account=${a.id} ` +
            `intervalSec=${sched.intervalSec} ` +
            `jitterRangeSec=±${Math.round(sched.intervalSec * JITTER_PERCENT)} ` +
            `nextDueAt(preEnqueue)=${sched.nextDueAt.toISOString()} ` +
            `reason=${sched.cooldownKind} → enqueued jobId=${inserted?.id}`,
        );
        // Push nextDueAt far into the future as a sentinel. Next tick
        // observes the job outcome via refreshAccountSched and then
        // computes the real nextDueAt based on success/failure.
        sched.nextDueAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        slots--;
      } catch (err) {
        this.logger.warn(
          `responses tick enqueue failed account=${a.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private async readGlobalDefaultSec(): Promise<number> {
    try {
      const [row] = await this.db
        .select({ value: appSettings.value })
        .from(appSettings)
        .where(eq(appSettings.key, 'responses_poll_default_sec'))
        .limit(1);
      if (row && /^\d+$/.test(row.value)) {
        const n = Number(row.value);
        if (Number.isFinite(n) && n >= 30) return n;
      }
    } catch {
      /* stay with env default */
    }
    return DEFAULT_RESPONSES_INTERVAL_SEC;
  }

  // Lazily initialize per-account schedule (FS2 random initial delay
  // for never-seen accounts) and fold in outcome of the latest finished
  // job for already-tracked accounts.
  private async refreshAccountSched(
    accountId: number,
    intervalSec: number,
    now: Date,
  ): Promise<void> {
    let sched = this.accountSched.get(accountId);

    if (!sched) {
      // FS2 initial spread — uniform random in [0, intervalSec). Stops
      // 40 accounts from starting in sync after a worker restart.
      const initialDelaySec = Math.random() * intervalSec;
      sched = {
        nextDueAt: new Date(now.getTime() + initialDelaySec * 1000),
        failureCount: 0,
        cooldownKind: 'normal',
        lastObservedJobId: 0,
        intervalSec,
      };
      this.accountSched.set(accountId, sched);
      this.logger.log(
        `responses scheduling init: account=${accountId} ` +
          `intervalSec=${intervalSec} ` +
          `initialDelaySec=${Math.round(initialDelaySec)} ` +
          `nextDueAt=${sched.nextDueAt.toISOString()} reason=normal`,
      );
      return;
    }

    // Interval may have changed (per-account override edited, or
    // global default changed). Refresh for next scheduling decision.
    sched.intervalSec = intervalSec;

    // Peek the newest collect_responses job for this account.
    const [latestJob] = await this.db
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, 'collect_responses'),
          sql`${jobs.payloadJson}->>'accountId' = ${String(accountId)}`,
        ),
      )
      .orderBy(desc(jobs.id))
      .limit(1);

    if (!latestJob) return;
    if (latestJob.id <= sched.lastObservedJobId) return;
    if (latestJob.status === 'pending' || latestJob.status === 'processing') {
      // Job still in flight — don't fold outcome until it finishes.
      return;
    }

    // Job has a terminal status. Classify outcome:
    //   status=failed            → failure (handler threw, nav error)
    //   status=done + profile_ok → success
    //   status=done + other kind → failure (ip_blocked / login_required / unknown)
    let isSuccess = latestJob.status === 'done';
    if (isSuccess) {
      const [doneEvt] = await this.db
        .select({ details: activityLog.detailsJson })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.entityType, 'account'),
            eq(activityLog.entityId, String(accountId)),
            eq(activityLog.action, 'collect_responses_done'),
          ),
        )
        .orderBy(desc(activityLog.id))
        .limit(1);
      const pageKind = (doneEvt?.details as { pageKind?: string } | null)
        ?.pageKind;
      if (pageKind && pageKind !== 'profile_ok') isSuccess = false;
    }

    sched.lastObservedJobId = latestJob.id;
    this.applyOutcome(accountId, sched, isSuccess, now);
  }

  private applyOutcome(
    accountId: number,
    sched: AccountSched,
    success: boolean,
    now: Date,
  ): void {
    const jitter = (base: number): number =>
      (Math.random() * 2 - 1) * base * JITTER_PERCENT;

    if (success) {
      sched.failureCount = 0;
      sched.cooldownKind = 'normal';
      const j = jitter(sched.intervalSec);
      const deltaSec = sched.intervalSec + j;
      sched.nextDueAt = new Date(now.getTime() + deltaSec * 1000);
      this.logger.log(
        `responses scheduling after-success: account=${accountId} ` +
          `intervalSec=${sched.intervalSec} jitterSec=${Math.round(j)} ` +
          `nextDueAt=${sched.nextDueAt.toISOString()} reason=normal`,
      );
      return;
    }

    sched.failureCount += 1;
    if (sched.failureCount >= FAILURE_COOLDOWN_THRESHOLD) {
      // FS5 — extended backoff past the threshold.
      const extSec = Math.max(
        EXTENDED_COOLDOWN_MIN_SEC,
        sched.intervalSec * EXTENDED_COOLDOWN_MULT,
      );
      const j = jitter(extSec);
      sched.nextDueAt = new Date(now.getTime() + (extSec + j) * 1000);
      sched.cooldownKind = 'extended_cooldown';
      this.logger.log(
        `responses scheduling extended-cooldown: account=${accountId} ` +
          `failures=${sched.failureCount} extendedSec=${extSec} ` +
          `jitterSec=${Math.round(j)} nextDueAt=${sched.nextDueAt.toISOString()} ` +
          `reason=extended_cooldown`,
      );
    } else {
      // FS4 — short cooldown on the first couple of failures.
      const cdSec = sched.intervalSec * FAILURE_COOLDOWN_MULT;
      const j = jitter(cdSec);
      sched.nextDueAt = new Date(now.getTime() + (cdSec + j) * 1000);
      sched.cooldownKind = 'cooldown';
      this.logger.log(
        `responses scheduling cooldown: account=${accountId} ` +
          `failures=${sched.failureCount} cooldownSec=${cdSec} ` +
          `jitterSec=${Math.round(j)} nextDueAt=${sched.nextDueAt.toISOString()} ` +
          `reason=cooldown`,
      );
    }
  }

  // ─── CRM outbox sweep tick ──────────────────────────────────────────
  //
  // Sibling to responsesLoop. Picks up failed/pending CRM events whose
  // next_retry_at has elapsed and re-attempts delivery. Permanent
  // failures (retry_count >= 3) are NOT picked up — they stay in the
  // table for audit / manual reprocessing.
  //
  // This loop NEVER blocks the responsesLoop or the main poller — it
  // runs in its own async context. attemptDelivery has its own 3s
  // fetch timeout per event, so even a fully unresponsive CRM caps
  // total tick time at ~150s for 50 events (worst case).
  private async crmOutboxLoop(): Promise<void> {
    this.logger.log(
      `crm outbox tick loop started (period=${CRM_OUTBOX_TICK_MS}ms ` +
        `maxPerTick=${CRM_OUTBOX_MAX_PER_TICK})`,
    );
    while (this.running) {
      try {
        await this.crmOutboxTick();
      } catch (err) {
        this.logger.error(
          `crm outbox tick failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      await sleep(CRM_OUTBOX_TICK_MS);
    }
    this.logger.log('crm outbox tick loop stopped');
  }

  private async crmOutboxTick(): Promise<void> {
    // Read CRM settings once — webhook url & token may have been
    // changed by the operator between ticks. If still unconfigured,
    // skip (rows accumulate but won't be retried until configured).
    const crm = await readCrmSettings(this.db);
    if (!crm.webhookUrl || !crm.token) return;

    const now = new Date();
    // Pick a bounded batch: failed rows whose next_retry_at <= now,
    // OR pending rows with no next_retry_at (initial-attempt failures
    // where we never set the schedule). FIFO by created_at to keep
    // event order roughly preserved per type.
    const batch = await this.db
      .select()
      .from(crmOutboxEvents)
      .where(
        and(
          inArray(crmOutboxEvents.sentStatus, ['pending', 'failed']),
          or(
            lte(crmOutboxEvents.nextRetryAt, now),
            isNull(crmOutboxEvents.nextRetryAt),
          ),
        ),
      )
      .orderBy(asc(crmOutboxEvents.createdAt))
      .limit(CRM_OUTBOX_MAX_PER_TICK);

    if (batch.length === 0) return;

    this.logger.log(
      `crm outbox sweep: picked=${batch.length} ` +
        `cap=${CRM_OUTBOX_MAX_PER_TICK}`,
    );

    for (const row of batch) {
      if (!this.running) break;
      const envelope = row.payload as unknown as AnyCrmEnvelope;
      try {
        await attemptDelivery(this.db, this.logger, row.id, crm, envelope);
      } catch (err) {
        // attemptDelivery is supposed to never throw, but we belt-and-
        // suspenders to keep the tick alive.
        this.logger.warn(
          `crm outbox attempt threw event_id=${row.eventId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
