/**
 * CRM integration DTOs (External Contract, schema_version=1).
 *
 * IMPORTANT: this is the ONLY shape CRM ever sees. Internal database
 * types (Response, Account) are intentionally NOT exported through
 * the webhook or pull API. We translate via the mappers below.
 *
 * Why a separate DTO instead of passing Response/Account directly?
 *   - Internal columns can be renamed / added / dropped without
 *     breaking CRM. Bumping schema_version is the only signal CRM
 *     watches for breaking changes.
 *   - The DTO names are consumer-friendly (chat_url, received_at,
 *     external_id) instead of mirroring our snake/camel mix.
 *   - Pull API returns the same shape as push payloads — CRM has one
 *     parser to maintain.
 *
 * Every event envelope has identical top-level metadata:
 *   { source, schema_version, event_id, event, ts, data }
 */
import { randomUUID } from 'node:crypto';
import type { Response as InternalResponse } from '@avito/db';

export const CRM_SCHEMA_VERSION = 1 as const;
export const CRM_SOURCE = 'avito' as const;

export type CrmEventType =
  | 'lead.created'
  | 'lead.phone_revealed'
  | 'lead.processed'
  | 'account.auto_paused'
  | 'account.degraded'
  | 'ping';

export type CrmAccountRef = {
  id: number;
  name: string;
};

export type CrmLeadStatus =
  | 'new'
  | 'phone_received'
  | 'processed'
  | 'phone_failed'
  | 'duplicate';

export type CrmLeadDto = {
  external_id: string;        // avito dialog id — stable across events
  id: number;                  // our internal responses.id
  account: CrmAccountRef;
  sender: string | null;       // candidate_name
  phone: string | null;        // E.164 compact, e.g. +79222155750
  preview: string | null;
  vacancy_title: string | null;
  chat_url: string | null;     // absolute URL to Avito messenger
  ui_url: string;              // absolute URL to our /responses anchor
  received_at: string | null;  // ISO8601 from Avito (may be null)
  detected_at: string;          // ISO8601, when we first saw it
  status: CrmLeadStatus;
  processed_at: string | null;
  processed_by: string | null;
};

export type CrmAccountEventState =
  | 'login_required'
  | 'ip_blocked';

export type CrmAccountAutoPausedDto = {
  account: CrmAccountRef;
  reason: string;                     // e.g. 'excessive_failures'
  fail_24h: number;
  ip_blocked_24h: number;
  login_required_24h: number;
  paused_at: string;                   // ISO8601
};

export type CrmAccountDegradedDto = {
  account: CrmAccountRef;
  state: CrmAccountEventState;
  fail_24h: number;
  ip_blocked_24h: number;
  login_required_24h: number;
  observed_at: string;                 // ISO8601
};

export type CrmEventEnvelope<TData> = {
  source: typeof CRM_SOURCE;
  schema_version: typeof CRM_SCHEMA_VERSION;
  event_id: string;                    // UUID v4
  event: CrmEventType;
  ts: string;                          // ISO8601 of envelope creation
  data: TData;
};

export type AnyCrmEnvelope =
  | CrmEventEnvelope<CrmLeadDto>
  | CrmEventEnvelope<CrmAccountAutoPausedDto>
  | CrmEventEnvelope<CrmAccountDegradedDto>
  | CrmEventEnvelope<{ message: string }>;

// ---------- mappers ----------

/**
 * Build the event envelope (idempotent — caller should reuse the
 * same event_id when the same logical event is re-tried, which is
 * the case when retry-tick re-sends a row from crm_outbox_events
 * because the outbox row stores the full payload incl. event_id).
 */
export function makeCrmEnvelope<TData>(
  event: CrmEventType,
  data: TData,
  opts?: { eventId?: string; ts?: string },
): CrmEventEnvelope<TData> {
  return {
    source: CRM_SOURCE,
    schema_version: CRM_SCHEMA_VERSION,
    event_id: opts?.eventId ?? randomUUID(),
    event,
    ts: opts?.ts ?? new Date().toISOString(),
    data,
  };
}

/** Strip everything except digits, then re-prefix with '+'. */
function compactPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

/** Avito sometimes returns a path-only href; CRM needs absolute. */
function absoluteAvitoUrl(chatUrl: string | null | undefined): string | null {
  if (!chatUrl) return null;
  if (chatUrl.startsWith('http')) return chatUrl;
  if (chatUrl.startsWith('/')) return `https://www.avito.ru${chatUrl}`;
  return null;
}

/** Best-effort mapping from internal ResponseStatus to CRM status. */
function mapLeadStatus(s: string): CrmLeadStatus {
  switch (s) {
    case 'new':
    case 'phone_pending':
      return 'new';
    case 'phone_received':
    case 'ready_for_manager':
      return 'phone_received';
    case 'phone_failed':
      return 'phone_failed';
    case 'duplicate':
      return 'duplicate';
    default:
      return 'new';
  }
}

export function toCrmLeadDto(
  resp: InternalResponse,
  account: CrmAccountRef,
  webBaseUrl: string,
  overrideStatus?: CrmLeadStatus,
): CrmLeadDto {
  const status = overrideStatus ?? mapLeadStatus(resp.status as unknown as string);
  return {
    external_id: resp.externalId,
    id: resp.id,
    account: { id: account.id, name: account.name },
    sender: resp.candidateName ?? null,
    phone: compactPhone(resp.phone),
    preview: resp.preview ?? null,
    vacancy_title: resp.vacancyTitle ?? null,
    chat_url: absoluteAvitoUrl(resp.chatUrl ?? resp.chatHref),
    ui_url: `${webBaseUrl.replace(/\/+$/, '')}/responses#${resp.id}`,
    received_at: resp.receivedAt ? new Date(resp.receivedAt).toISOString() : null,
    detected_at: new Date(resp.detectedAt).toISOString(),
    status,
    processed_at: resp.processedAt ? new Date(resp.processedAt).toISOString() : null,
    processed_by: resp.processedBy ?? null,
  };
}
