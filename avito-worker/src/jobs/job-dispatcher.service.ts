import { Inject, Injectable } from '@nestjs/common';
import type { Job } from '@avito/db';
import { OpenLoginWindowHandler } from './handlers/open-login-window.handler';
import { CheckSessionHandler } from './handlers/check-session.handler';
import { ScanAccountHandler } from './handlers/scan-account.handler';
import { CollectResponsesHandler } from './handlers/collect-responses.handler';

@Injectable()
export class JobDispatcherService {
  constructor(
    @Inject(OpenLoginWindowHandler) private readonly openLogin: OpenLoginWindowHandler,
    @Inject(CheckSessionHandler) private readonly checkSession: CheckSessionHandler,
    @Inject(ScanAccountHandler) private readonly scanAccount: ScanAccountHandler,
    @Inject(CollectResponsesHandler)
    private readonly collectResponses: CollectResponsesHandler,
  ) {}

  async dispatch(job: Job): Promise<void> {
    switch (job.type) {
      case 'open_login_window':
        await this.openLogin.handle(job);
        return;
      case 'check_session':
        await this.checkSession.handle(job);
        return;
      case 'scan_account':
        await this.scanAccount.handle(job);
        return;
      case 'collect_responses':
        await this.collectResponses.handle(job);
        return;
      case 'fetch_phone':
        // Manual phone-reveal retry path — lands in STEP B7 once the
        // `POST /responses/:id/reveal-phone` endpoint is wired up.
        throw new Error(
          `Job type "${job.type}" is not implemented yet`,
        );
      default: {
        const exhaustive: never = job.type;
        throw new Error(`Unknown job type: ${String(exhaustive)}`);
      }
    }
  }
}
