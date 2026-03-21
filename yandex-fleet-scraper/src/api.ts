import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Queue } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import client from 'prom-client';

const prisma = new PrismaClient();
const fastify = Fastify({ logger: true });

// Setup Redis connection for BullMQ
const redisConnection = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379')
};

const checksQueue = new Queue('check-history', { connection: redisConnection });

// Metrics Setup
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const checksTotal = new client.Counter({
    name: 'scraper_checks_total',
    help: 'Total number of check requests received'
});
const activeAccountsGauge = new client.Gauge({
    name: 'scraper_active_accounts',
    help: 'Number of active accounts in the pool'
});
const accountStateGauge = new client.Gauge({
    name: 'scraper_account_state_total',
    help: 'Count of accounts by state',
    labelNames: ['state']
});
const queueJobsGauge = new client.Gauge({
    name: 'scraper_queue_jobs_total',
    help: 'Count of jobs in the queue by status',
    labelNames: ['status']
});
const checksFailedTotal = new client.Gauge({
    name: 'scraper_checks_failed_total',
    help: 'Total number of failed checks by error code',
    labelNames: ['errorCode']
});

register.registerMetric(checksTotal);
register.registerMetric(activeAccountsGauge);
register.registerMetric(accountStateGauge);
register.registerMetric(queueJobsGauge);
register.registerMetric(checksFailedTotal);

async function updateMetrics() {
    // 1. Account States
    const stateGroups = await prisma.account.groupBy({
        by: ['state'],
        _count: { id: true }
    });

    const states = ['ACTIVE', 'NEED_REAUTH', 'CAPTCHA', 'LOCKED', 'DISABLED'];
    for (const s of states) accountStateGauge.set({ state: s }, 0);

    let activeCount = 0;
    for (const g of stateGroups) {
        accountStateGauge.set({ state: g.state }, g._count.id);
        if (g.state === 'ACTIVE') activeCount = g._count.id;
    }
    activeAccountsGauge.set(activeCount);

    // 2. Queue Stats
    const counts = await checksQueue.getJobCounts('wait', 'active', 'completed', 'failed', 'delayed');
    queueJobsGauge.set({ status: 'wait' }, counts.wait || 0);
    queueJobsGauge.set({ status: 'active' }, counts.active || 0);
    queueJobsGauge.set({ status: 'completed' }, counts.completed || 0);
    queueJobsGauge.set({ status: 'failed' }, counts.failed || 0);
    queueJobsGauge.set({ status: 'delayed' }, counts.delayed || 0);

    // 3. Failed Checks by error code
    const failedGroups = await prisma.check.groupBy({
        by: ['errorCode'],
        where: { status: 'FAILED' },
        _count: { id: true }
    });
    for (const g of failedGroups) {
        checksFailedTotal.set({ errorCode: g.errorCode || 'UNKNOWN' }, g._count.id);
    }
}

// Helper to generate idempotency key
function generateIdempotencyKey(accountId: string, license: string): string {
    const today = new Date().toISOString().split('T')[0];
    const hash = crypto.createHash('sha256').update(`${accountId}:${license}:${today}`).digest('hex');
    return hash;
}

// POST /api/checks
fastify.post('/api/checks', async (request, reply) => {
    const { license, priority = 'NORMAL', idempotencyKey: providedKey, metadata, crmDriverId } = request.body as any;
    // Merge crmDriverId into metadata so it flows through to webhook
    const effectiveMetadata = JSON.stringify({ ...(metadata || {}), crmDriverId: crmDriverId || null });

    if (!license) {
        return reply.status(400).send({ error: 'Missing license' });
    }

    checksTotal.inc();

    // Account Dispatcher logic: Find an ACTIVE account, ordered by least failureStreak and highest healthScore
    const activeAccounts = await prisma.account.findMany({
        where: { state: 'ACTIVE' },
        orderBy: [
            { healthScore: 'desc' },
            { failureStreak: 'asc' },
            { lastSuccessAt: 'desc' }
        ]
    });

    if (activeAccounts.length === 0) {
        return reply.status(503).send({ error: 'SERVICE_UNAVAILABLE: No active accounts available to process the request' });
    }

    // Simple Round-Robin or Pick Best (currently picks best based on query sorting)
    const selectedAccount = activeAccounts[0] as { id: string };
    const accountId = selectedAccount.id;

    const idempotencyKey = providedKey || generateIdempotencyKey(accountId, license);

    // Check if check already exists (by idempotency key for same license+account+day)
    let check = await prisma.check.findUnique({
        where: { idempotencyKey }
    });

    if (check) {
        if (check.status === 'QUEUED' || check.status === 'RUNNING') {
            // Already in progress — return existing (idempotent)
            return { checkId: check.id, status: check.status, assignedAccountId: accountId };
        }

        if (check.status === 'FAILED') {
            // Failed previously — reset and re-queue
            check = await prisma.check.update({
                where: { id: check.id },
                data: {
                    status: 'QUEUED',
                    errorCode: null,
                    errorMessage: null,
                    startedAt: null,
                    finishedAt: null,
                    metadata: effectiveMetadata,
                },
            });

            // Remove old BullMQ job (it may be in 'failed' state)
            const oldJob = await checksQueue.getJob(idempotencyKey);
            if (oldJob) await oldJob.remove().catch(() => { });

            const priorityNumber = priority === 'HIGH' ? 1 : priority === 'LOW' ? 10 : 5;
            await checksQueue.add('process-check', { checkId: check.id, crmDriverId: crmDriverId || null }, {
                jobId: idempotencyKey,
                priority: priorityNumber,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 }
            });

            return { checkId: check.id, status: 'QUEUED', assignedAccountId: accountId, retried: true };
        }

        // COMPLETED / SUCCESS — return existing result
        return { checkId: check.id, status: check.status, assignedAccountId: accountId };
    }

    // Create brand new check
    check = await prisma.check.create({
        data: {
            accountId,
            license,
            idempotencyKey,
            priority,
            metadata: effectiveMetadata
        }
    });

    const priorityNumber = priority === 'HIGH' ? 1 : priority === 'LOW' ? 10 : 5;
    await checksQueue.add('process-check', { checkId: check.id, crmDriverId: crmDriverId || null }, {
        jobId: idempotencyKey,
        priority: priorityNumber,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 }
    });

    return { checkId: check.id, status: check.status, assignedAccountId: accountId };
});

// GET /api/checks/:id
fastify.get('/api/checks/:id', async (request, reply) => {
    const { id } = request.params as any;

    const check = await prisma.check.findUnique({
        where: { id },
        include: { result: true }
    });

    if (!check) {
        return reply.status(404).send({ error: 'Check not found' });
    }

    return {
        checkId: check.id,
        status: check.status,
        createdAt: check.createdAt,
        startedAt: check.startedAt,
        finishedAt: check.finishedAt,
        error: check.errorMessage || check.errorCode,
        result: check.result?.resultJson ? JSON.parse(check.result.resultJson) : null
    };
});

// Admin / Accounts
fastify.get('/admin/accounts', async () => {
    return prisma.account.findMany({
        select: {
            id: true, name: true, state: true, healthScore: true, failureStreak: true, lastKnownChecksLeft: true, lastSuccessAt: true, lastFailureAt: true
        }
    });
});

fastify.post('/admin/accounts', async (request, reply) => {
    const { name } = request.body as any;
    if (!name) return reply.status(400).send({ error: 'Name is required' });

    const account = await prisma.account.create({
        data: { name, state: 'NEED_REAUTH' } // New accounts need auth before becoming ACTIVE
    });
    await updateMetrics();
    return account;
});

fastify.put('/admin/accounts/:id/state', async (request, reply) => {
    const { id } = request.params as any;
    const { state, force } = request.body as any;

    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) return reply.status(404).send({ error: 'Account not found' });

    // Guard against moving to ACTIVE without force bypass or valid storage
    if (state === 'ACTIVE' && !force && !account.storageStateEncrypted) {
        return reply.status(400).send({ error: 'Cannot set state to ACTIVE without storage state. Use Playwright verification or provide {force: true}' });
    }

    const updated = await prisma.account.update({
        where: { id },
        data: { state }
    });

    await updateMetrics();
    return updated;
});

// Admin / Queue Stats
fastify.get('/admin/stats', async () => {
    const counts = await checksQueue.getJobCounts('wait', 'active', 'completed', 'failed', 'delayed');
    return counts;
});

// Health & Metrics
fastify.get('/health', async () => {
    try {
        await prisma.$queryRaw`SELECT 1`; // Test DB connection
        const activeAccountsCount = await prisma.account.count({ where: { state: 'ACTIVE' } });
        const queueDepth = await checksQueue.getJobCounts('wait', 'delayed');

        return {
            status: 'ok',
            db: 'connected',
            activeAccounts: activeAccountsCount,
            queueDepth: (queueDepth.wait || 0) + (queueDepth.delayed || 0)
        };
    } catch (e: any) {
        return { status: 'error', db: e.message };
    }
});

fastify.get('/metrics', async (request, reply) => {
    await updateMetrics();
    reply.header('Content-Type', register.contentType);
    return register.metrics();
});


// Start API Server
export const start = async () => {
    try {
        await fastify.register(cors);
        const port = process.env.PORT ? parseInt(process.env.PORT) : 3003;
        await updateMetrics();
        await fastify.listen({ port, host: '0.0.0.0' });
        console.log(`🚀 Scraper API is running on http://localhost:${port}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

// Only auto-start if not required as a module (e.g. by Jest)
if (process.env.NODE_ENV !== 'test') {
    start();
}

export { fastify };
