import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import * as path from 'node:path';
// .env лежит рядом с package.json worker'а (в CRM-монорепо это
// D:\Github\CRM\avito-worker\.env). Раньше worker жил в monorepo и
// читал общий .env из корня; теперь — свой собственный.
loadEnv({ path: path.resolve(__dirname, '..', '.env') });
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ensureStorageDirs } from '@avito/db';
import { FileLogger } from './logger/file-logger';
import { JobPollerService } from './jobs/job-poller.service';

async function bootstrap() {
  await ensureStorageDirs();
  const logger = new FileLogger('worker');
  const app = await NestFactory.createApplicationContext(AppModule, { logger });
  const poller = app.get(JobPollerService);
  logger.log('worker started', 'bootstrap');
  poller.start();

  const shutdown = async (signal: string) => {
    logger.log(`received ${signal}, shutting down`, 'bootstrap');
    await poller.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[worker] bootstrap failed', err);
  process.exit(1);
});
