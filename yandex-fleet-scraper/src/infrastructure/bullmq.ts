import { Queue, Worker, UnrecoverableError, type Job } from 'bullmq';
import { Redis } from 'ioredis';

export const fleetQueueConnection = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
};

/** Exact clients used by the fleet check and driver-action workflow. */
export function createCheckHistoryQueueV1() {
    return new Queue('check-history', { connection: fleetQueueConnection });
}

export function createFleetRedisV1() {
    return new Redis(fleetQueueConnection);
}

export function createCheckHistoryWorkerV1(processor: (job: Job) => Promise<unknown>) {
    return new Worker('check-history', processor, { connection: fleetQueueConnection, concurrency: 1 });
}

export { UnrecoverableError };
export type { Job };
