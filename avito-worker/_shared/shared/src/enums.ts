export const ACCOUNT_STATUSES = [
  'new',
  'auth_pending',
  'active',
  'reauth_required',
  'paused',
  'error',
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const RESPONSE_STATUSES = [
  'new',
  'phone_pending',
  'phone_received',
  'phone_failed',
  'ready_for_manager',
  'duplicate',
] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

export const JOB_TYPES = [
  'scan_account',
  'fetch_phone',
  'open_login_window',
  'check_session',
  'collect_responses',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['pending', 'processing', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const PHONE_REVEAL_ATTEMPT_STATUSES = [
  'started',
  'success',
  'technical_error_before_click',
  'technical_error_after_click',
  'technical_error_unknown_state',
  'no_phone_found',
  'blocked',
  'ui_changed',
] as const;
export type PhoneRevealAttemptStatus = (typeof PHONE_REVEAL_ATTEMPT_STATUSES)[number];
