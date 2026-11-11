// Manual (human) outbound call to one Contact: Calling's single verified-destination policy.
//
// Order, every step fail-closed, the dialler is reached only when all of them pass:
//   1. a signed staff principal (Staff Session) with a role allowed to call, and the server-side
//      SIP extension assigned to that employee;
//   2. the exact canonical Contact (Contacts' person card), not merged away and not archived;
//   3. the phone named by its Contacts phone id belongs to this Contact, is active and current,
//      and Contacts resolves it as unique to this Contact;
//   4. Contacts' voice permission for this exact canonical Contact (denyVoice / denyAll / an
//      unavailable policy store all refuse);
//   5. one durable claim per requestId under a per-Contact lock (replay, conflict, busy);
//   6. the dial. An unknown dial outcome is never redialled.
// A phone number is never an input; the number comes from Contacts only.

import { createHash } from 'node:crypto'
import type {
  ContactCommunicationPermissionResultV1,
  ContactPersonCardPhoneV1,
  ContactPersonCardResultV1,
  ContactPersonCardV1,
} from '@/contracts/contacts/v1'
import {
  CANCEL_MANUAL_CALL_RESULT_V1,
  MANUAL_CALL_AVAILABILITY_RESULT_V1,
  START_MANUAL_CALL_RESULT_V1,
  parseCancelManualCallCommandV1,
  parseManualCallAvailabilityQueryV1,
  parseStartManualCallCommandV1,
  type CancelManualCallResultV1,
  type ManualCallAvailabilityResultV1,
  type ManualCallPhoneV1,
  type ManualCallRefusalV1,
  type StartManualCallResultV1,
} from '@/contracts/calling/v1/manual-call'

/** Roles the Owner allowed to place an ordinary call (decision of 2026-11-11). */
export const MANUAL_CALL_ROLES_V1: readonly string[] = ['Менеджер', 'Руководитель', 'Администратор']
/** Only an administrator may cancel a call another employee started. */
export const MANUAL_CALL_CANCEL_ANY_ROLE_V1 = 'Администратор'

const STRICT_E164 = /^\+[1-9]\d{7,14}$/
const EXTENSION = /^\d{2,6}$/

export type ManualCallPrincipal = { userId: string; role: string }

export type ManualCallRecord = {
  callId: string
  fsUuid: string
  requestId: string
  payloadDigest: string
  contactId: string
  /** Contacts' legacy main-driver projection, kept on the call row as the ESL listener always did. */
  driverId: string | null
  phoneId: string
  e164: string
  staffUserId: string
  extension: string
  createdAt: string
}

export type ManualCallDispatchState = 'claimed' | 'accepted' | 'rejected' | 'unavailable' | 'outcome_unknown'

export type ManualCallClaimResult =
  | { kind: 'claimed' }
  | { kind: 'existing'; payloadDigest: string; dispatch: ManualCallDispatchState }
  | { kind: 'busy' }

export interface ManualCallStorePort {
  /** Atomically: replay an existing requestId, refuse while this Contact or employee has a live call, or record the claim. */
  claim(record: ManualCallRecord): Promise<ManualCallClaimResult>
  settle(callId: string, dispatch: Exclude<ManualCallDispatchState, 'claimed'>): Promise<void>
  findByFsUuid(fsUuid: string): Promise<{ callId: string; staffUserId: string | null; active: boolean } | null>
}

export class ManualDialUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'ManualDialUnavailableError' }
}
export class ManualDialRejectedError extends Error {
  constructor(message: string) { super(message); this.name = 'ManualDialRejectedError' }
}
export class ManualDialOutcomeUnknownError extends Error {
  constructor(message: string) { super(message); this.name = 'ManualDialOutcomeUnknownError' }
}

export interface ManualCallDialPort {
  /** Places the two-leg click-to-call. Throws one of the ManualDial* errors; resolves when the switch accepted the job. */
  originate(input: { fsUuid: string; e164: string; extension: string; staffUserId: string }): Promise<void>
  cancel(fsUuid: string): Promise<void>
}

export interface ManualCallPorts {
  principal(): Promise<ManualCallPrincipal | null>
  extensionFor(userId: string): string | null
  readPerson(contactId: string): Promise<ContactPersonCardResultV1>
  voicePermission(contactId: string): Promise<ContactCommunicationPermissionResultV1>
  store: ManualCallStorePort
  dial: ManualCallDialPort
  now(): Date
}

type Refusal = Exclude<ManualCallRefusalV1, 'busy' | 'request_conflict' | 'provider_unavailable'>
type Checked<T> = { ok: true; value: T } | { ok: false; reason: Refusal; retryable: boolean }

const refused = (reason: ManualCallRefusalV1, retryable = false): StartManualCallResultV1 =>
  ({ contract: START_MANUAL_CALL_RESULT_V1, status: 'refused', reason, retryable })

const unavailable = (reason: Refusal): ManualCallAvailabilityResultV1 =>
  ({ contract: MANUAL_CALL_AVAILABILITY_RESULT_V1, status: 'unavailable', reason })

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

/** Deterministic call id and FreeSWITCH channel uuid for one requestId of one employee. */
export function manualCallIdentityV1(requestId: string): { callId: string; fsUuid: string } {
  const digest = sha256(`calling.manual-call.v1:${requestId}`)
  const variant = ((parseInt(digest[16], 16) & 0x3) | 0x8).toString(16)
  const fsUuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  return { callId: `manual_${digest.slice(0, 32)}`, fsUuid }
}

/** A phone may be dialled only when Contacts holds it as this Contact's active, current, unique number. */
export function isDiallablePhoneV1(phone: ContactPersonCardPhoneV1): boolean {
  return phone.isActive
    && phone.lifecycle === 'current'
    && phone.resolutionState === 'unique'
    && STRICT_E164.test(phone.phone)
}

async function checkStaff(ports: ManualCallPorts): Promise<Checked<{ principal: ManualCallPrincipal; extension: string }>> {
  const principal = await ports.principal()
  if (!principal) return { ok: false, reason: 'staff_not_authenticated', retryable: false }
  if (!MANUAL_CALL_ROLES_V1.includes(principal.role)) return { ok: false, reason: 'staff_not_authorized', retryable: false }
  const extension = ports.extensionFor(principal.userId)
  if (!extension || !EXTENSION.test(extension)) return { ok: false, reason: 'no_extension', retryable: false }
  return { ok: true, value: { principal, extension } }
}

async function checkPerson(ports: ManualCallPorts, contactId: string): Promise<Checked<ContactPersonCardV1>> {
  let result: ContactPersonCardResultV1
  try {
    result = await ports.readPerson(contactId)
  } catch {
    return { ok: false, reason: 'contact_unavailable', retryable: true }
  }
  if (result.status === 'redirected') return { ok: false, reason: 'contact_redirected', retryable: false }
  if (result.status !== 'confirmed') return { ok: false, reason: 'contact_unknown', retryable: false }
  if (result.card.contactId !== contactId) return { ok: false, reason: 'contact_unknown', retryable: false }
  if (result.card.isArchived) return { ok: false, reason: 'contact_archived', retryable: false }
  return { ok: true, value: result.card }
}

async function checkVoice(ports: ManualCallPorts, contactId: string): Promise<Checked<null>> {
  let verdict: ContactCommunicationPermissionResultV1
  try {
    verdict = await ports.voicePermission(contactId)
  } catch {
    return { ok: false, reason: 'permission_unavailable', retryable: true }
  }
  if (verdict.decision === 'allow') {
    // An allow must name this exact canonical Contact; anything else is not a decision about this person.
    if (verdict.canonicalContactId !== contactId || verdict.requestedContactId !== contactId) {
      return { ok: false, reason: 'contact_unknown', retryable: false }
    }
    return { ok: true, value: null }
  }
  switch (verdict.reason) {
    case 'restricted_voice': return { ok: false, reason: 'voice_denied', retryable: false }
    case 'restricted_all': return { ok: false, reason: 'all_denied', retryable: false }
    case 'contact_archived': return { ok: false, reason: 'contact_archived', retryable: false }
    case 'contact_unknown':
    case 'lineage_unsafe': return { ok: false, reason: 'contact_unknown', retryable: false }
    default: return { ok: false, reason: 'permission_unavailable', retryable: verdict.retryable }
  }
}

function diallablePhones(card: ContactPersonCardV1): ManualCallPhoneV1[] {
  const phones = card.phones.filter(isDiallablePhoneV1)
  const ordered = [...phones.filter(phone => phone.isPrimary), ...phones.filter(phone => !phone.isPrimary)]
  return ordered.map((phone, index) => ({ phoneId: phone.phoneId, phone: phone.phone, preferred: index === 0 }))
}

export function createManualCallOperations(ports: ManualCallPorts) {
  return {
    async availability(input: unknown): Promise<ManualCallAvailabilityResultV1> {
      const query = parseManualCallAvailabilityQueryV1(input)
      const staff = await checkStaff(ports)
      if (!staff.ok) return unavailable(staff.reason)
      const person = await checkPerson(ports, query.contactId)
      if (!person.ok) return unavailable(person.reason)
      const phones = diallablePhones(person.value)
      if (phones.length === 0) return unavailable('no_verified_number')
      const voice = await checkVoice(ports, query.contactId)
      if (!voice.ok) return unavailable(voice.reason)
      return { contract: MANUAL_CALL_AVAILABILITY_RESULT_V1, status: 'available', contactId: query.contactId, phones }
    },

    async start(input: unknown): Promise<StartManualCallResultV1> {
      const command = parseStartManualCallCommandV1(input)
      const staff = await checkStaff(ports)
      if (!staff.ok) return refused(staff.reason, staff.retryable)
      const person = await checkPerson(ports, command.contactId)
      if (!person.ok) return refused(person.reason, person.retryable)
      const phone = person.value.phones.find(candidate => candidate.phoneId === command.phoneId)
      if (!phone || !isDiallablePhoneV1(phone)) return refused('no_verified_number')
      // The permission is read last, immediately before the claim and the dial.
      const voice = await checkVoice(ports, command.contactId)
      if (!voice.ok) return refused(voice.reason, voice.retryable)

      const { principal, extension } = staff.value
      const identity = manualCallIdentityV1(command.requestId)
      const record: ManualCallRecord = {
        ...identity,
        requestId: command.requestId,
        payloadDigest: sha256(JSON.stringify([principal.userId, command.contactId, command.phoneId])),
        contactId: command.contactId,
        driverId: person.value.mainDriverId,
        phoneId: command.phoneId,
        e164: phone.phone,
        staffUserId: principal.userId,
        extension,
        createdAt: ports.now().toISOString(),
      }
      const claim = await ports.store.claim(record)
      if (claim.kind === 'busy') return refused('busy', true)
      if (claim.kind === 'existing') {
        if (claim.payloadDigest !== record.payloadDigest) return refused('request_conflict')
        if (claim.dispatch === 'accepted') {
          return { contract: START_MANUAL_CALL_RESULT_V1, status: 'admitted', callId: identity.callId, fsUuid: identity.fsUuid, replay: true }
        }
        if (claim.dispatch === 'rejected' || claim.dispatch === 'unavailable') return refused('provider_unavailable', true)
        return { contract: START_MANUAL_CALL_RESULT_V1, status: 'indeterminate', callId: identity.callId }
      }

      try {
        await ports.dial.originate({ fsUuid: identity.fsUuid, e164: phone.phone, extension, staffUserId: principal.userId })
      } catch (error) {
        if (error instanceof ManualDialUnavailableError || error instanceof ManualDialRejectedError) {
          await ports.store.settle(identity.callId, error instanceof ManualDialRejectedError ? 'rejected' : 'unavailable')
          return refused('provider_unavailable', true)
        }
        await ports.store.settle(identity.callId, 'outcome_unknown')
        return { contract: START_MANUAL_CALL_RESULT_V1, status: 'indeterminate', callId: identity.callId }
      }
      await ports.store.settle(identity.callId, 'accepted')
      return { contract: START_MANUAL_CALL_RESULT_V1, status: 'admitted', callId: identity.callId, fsUuid: identity.fsUuid, replay: false }
    },

    async cancel(input: unknown): Promise<CancelManualCallResultV1> {
      const command = parseCancelManualCallCommandV1(input)
      const cancelRefused = (reason: Extract<CancelManualCallResultV1, { status: 'refused' }>['reason']): CancelManualCallResultV1 =>
        ({ contract: CANCEL_MANUAL_CALL_RESULT_V1, status: 'refused', reason })
      const principal = await ports.principal()
      if (!principal) return cancelRefused('staff_not_authenticated')
      if (!MANUAL_CALL_ROLES_V1.includes(principal.role)) return cancelRefused('staff_not_authorized')
      const call = await ports.store.findByFsUuid(command.fsUuid)
      if (!call) return cancelRefused('call_not_found')
      if (call.staffUserId !== principal.userId && principal.role !== MANUAL_CALL_CANCEL_ANY_ROLE_V1) return cancelRefused('staff_not_authorized')
      if (!call.active) return cancelRefused('call_not_active')
      try {
        await ports.dial.cancel(command.fsUuid)
      } catch {
        return cancelRefused('provider_unavailable')
      }
      return { contract: CANCEL_MANUAL_CALL_RESULT_V1, status: 'cancelled' }
    },
  }
}
