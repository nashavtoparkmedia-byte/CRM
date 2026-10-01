import { NextRequest, NextResponse } from 'next/server'

import { RepairTelegramConversationPersonBindingRefusalV1 } from '@/modules/contacts/public/v1'
import {
  getIntegrationAdminPrincipal,
  isExactSameOriginMutationRequest,
} from '@/modules/identity-access/public/v1'
import {
  readTelegramPersonBindingRepairBeforeStateV1,
  resolveDuplicateTelegramExternalIdV1,
  runTelegramConversationPersonBindingRepairV1,
} from '@/infrastructure/telegram-conversation-person-binding-repair-composition'

/**
 * POST /api/contacts/:id/telegram-person-binding-repair
 *
 * `:id` is the canonical Contact, which this repair makes survive. It is a
 * bounded, integration-admin-only repair for one Telegram conversation whose
 * person binding is wrong, NOT a generic merge API. The survivor is elected by
 * the unchanged merge heuristic: the repair records a manual canonical pin on the
 * named canonical Contact, which `evaluateContactSurvivorV1` compares first. No
 * survivor directive is injected anywhere, and
 * `POST /api/contacts/:sourceId/merge-to/:targetId` is untouched.
 *
 * Three phases, because `pinCanonicalContactV1` and `confirmDriverPersonV1` each
 * open their own contact-ownership transaction and Prisma interactive
 * transactions cannot nest: pin, merge, confirm.
 *
 *   REPAIRED                              all three phases committed
 *   PHASE_1_COMPLETE_CONFIRMATION_PENDING pin and merge committed, confirmation
 *                                         did not; authority stays denied, retry
 *                                         resumes the confirmation and never
 *                                         re-pins or re-merges
 *   ALREADY_REPAIRED                      end state already holds; zero mutation
 *   PRECONDITION_FAILED                   proof refused; zero mutation, except
 *                                         for the two reasons that name the pin
 *                                         explicitly — `CANONICAL_PIN_FAILED`
 *                                         (nothing committed) and
 *                                         `MERGE_FAILED_AFTER_CANONICAL_PIN`
 *                                         (the pin committed, nothing else did,
 *                                         and no authority was granted)
 *
 * IRREVERSIBILITY: the merge is ONE-WAY under current supported owner
 * capabilities. `automated-contact-merge-recovery` refuses a manual merge
 * (`not_recoverable / manual_merge`), no revoke capability exists for a
 * driver-person confirmation, and none removes a canonical pin. The `before`
 * snapshot in every response is captured for audit and forensic reconstruction
 * only; it is NOT a supported automatic rollback and must not be described as one.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isExactSameOriginMutationRequest(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const principal = await getIntegrationAdminPrincipal()
  if (!principal) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: canonicalContactId } = await params
  const body = await request.json().catch(() => null) as {
    duplicateContactId?: string
    representativeDriverId?: string
  } | null
  const duplicateContactId = body?.duplicateContactId?.trim() ?? ''
  const representativeDriverId = body?.representativeDriverId?.trim() ?? ''

  if (!canonicalContactId || !duplicateContactId || !representativeDriverId) {
    return NextResponse.json({
      status: 'PRECONDITION_FAILED',
      reason: 'INPUT_INVALID',
      message: 'canonicalContactId, duplicateContactId and representativeDriverId are all required',
    }, { status: 400 })
  }
  if (canonicalContactId === duplicateContactId) {
    return NextResponse.json({
      status: 'PRECONDITION_FAILED',
      reason: 'INPUT_INVALID',
      message: 'canonical and duplicate Contact must differ',
    }, { status: 400 })
  }

  // The Telegram peer id is derived from the named pair's single active Telegram
  // identity, so no production peer id is hardcoded in application code and the
  // caller cannot choose which conversation is repaired. After phase 1 the
  // identity belongs to the canonical Contact, which is why the resolver is given
  // both ids: without that a retry could not resume phase 2.
  const resolved = await resolveDuplicateTelegramExternalIdV1(duplicateContactId, canonicalContactId)
  if ('error' in resolved) {
    return NextResponse.json({
      status: 'PRECONDITION_FAILED',
      reason: resolved.error,
      message: 'The duplicate Contact must own exactly one active numeric Telegram identity',
    }, { status: 409 })
  }

  const repairInput = {
    canonicalContactId,
    duplicateContactId,
    representativeDriverId,
    telegramExternalId: resolved.externalId,
    actorId: principal.id,
  }

  // Audit snapshot, captured before any mutation. Not a rollback mechanism.
  const before = await readTelegramPersonBindingRepairBeforeStateV1(repairInput)

  try {
    const result = await runTelegramConversationPersonBindingRepairV1(repairInput)
    if (result.status === 'repaired') {
      return NextResponse.json({
        status: 'REPAIRED',
        irreversible: true,
        before,
        result,
      })
    }
    if (result.status === 'already_repaired') {
      return NextResponse.json({ status: 'ALREADY_REPAIRED', before, result })
    }
    return NextResponse.json({
      status: 'PHASE_1_COMPLETE_CONFIRMATION_PENDING',
      irreversible: true,
      retryResumesPhase2: true,
      before,
      result,
    }, { status: 409 })
  } catch (error: unknown) {
    if (error instanceof RepairTelegramConversationPersonBindingRefusalV1) {
      return NextResponse.json({
        status: 'PRECONDITION_FAILED',
        reason: error.reason,
        message: error.message,
        before,
      }, { status: 409 })
    }
    console.error('[telegram-person-binding-repair] unexpected failure:', error)
    return NextResponse.json({
      status: 'PRECONDITION_FAILED',
      reason: 'UNEXPECTED_FAILURE',
      message: error instanceof Error ? error.message : String(error),
    }, { status: 500 })
  }
}
