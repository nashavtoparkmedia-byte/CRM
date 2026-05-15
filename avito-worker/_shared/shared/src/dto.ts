import type { AccountStatus, JobStatus, JobType } from './enums';

export interface AccountDto {
  id: number;
  name: string;
  loginPhone: string | null;
  notes: string | null;
  profilePath: string;
  status: AccountStatus;
  lastAuthAt: string | null;
  lastScanAt: string | null;
  lastSuccessAt: string | null;
  reauthRequiredAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccountDto {
  name: string;
  loginPhone?: string | null;
  notes?: string | null;
}

export interface UpdateAccountDto {
  name?: string;
  loginPhone?: string | null;
  notes?: string | null;
}

export interface JobDto {
  id: number;
  type: JobType;
  status: JobStatus;
  attempt: number;
  runAt: string;
  lastError: string | null;
  payloadJson: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityLogEntryDto {
  id: number;
  entityType: string;
  entityId: string | null;
  action: string;
  detailsJson: unknown;
  createdAt: string;
}

export interface EnqueueJobResponseDto {
  jobId: number;
  type: JobType;
  status: JobStatus;
}
