import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { BrowserRegistryService } from './playwright/browser-registry.service';
import { JobPollerService } from './jobs/job-poller.service';
import { JobDispatcherService } from './jobs/job-dispatcher.service';
import { OpenLoginWindowHandler } from './jobs/handlers/open-login-window.handler';
import { CheckSessionHandler } from './jobs/handlers/check-session.handler';
import { ScanAccountHandler } from './jobs/handlers/scan-account.handler';
import { CollectResponsesHandler } from './jobs/handlers/collect-responses.handler';

@Module({
  imports: [DbModule],
  providers: [
    BrowserRegistryService,
    JobPollerService,
    JobDispatcherService,
    OpenLoginWindowHandler,
    CheckSessionHandler,
    ScanAccountHandler,
    CollectResponsesHandler,
  ],
})
export class AppModule {}
