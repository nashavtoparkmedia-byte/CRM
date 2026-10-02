import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'
import {
  lockContactOwnershipRows,
  runContactOwnershipTransaction,
} from '../../internal/contact-ownership-coordinator'

/**
 * Operator surface for the manual canonical pin.
 *
 * `canonicalPinnedAt` is already the decisive input to the merge survivor
 * heuristic: `evaluateContactSurvivorV1` compares `manual_canonical_pin` first,
 * before `substantive_contact`, `current_workflows` and `richer_history`, so a
 * Contact pinned on its own wins the survivor election against an unpinned one.
 * It is also read by `contact-display-policy` as a manually curated identity, and
 * it is listed in `CONTACT_SYSTEM_EVIDENCE_FIELDS`, so it never counts as a
 * business field when a Contact is classified.
 *
 * Until now nothing in the repository wrote it: the mechanism shipped without an
 * operator surface. This is that surface, and nothing more. It records "an
 * operator has proven this record is the real person of record" and grants no
 * authority by itself — no driver action, no confirmation and no merge follows
 * from the pin alone. It only changes which side survives if a merge of this
 * Contact is later performed.
 *
 * Ownership: Contacts owns `Contact.customFields`, so the write lives here,
 * inside the contact-ownership transaction and behind the ownership row lock, and
 * never in shared infrastructure.
 */

export type PinCanonicalContactResultV1 = {
  status: 'pinned' | 'already_pinned'
  contactId: string
  canonicalPinnedAt: string
  canonicalPinnedBy: string | null
}

export class CanonicalContactPinErrorV1 extends Error {
  readonly code: 'CONTACT_NOT_ELIGIBLE' | 'INPUT_INVALID'

  constructor(code: 'CONTACT_NOT_ELIGIBLE' | 'INPUT_INVALID', message: string) {
    super(message)
    this.name = 'CanonicalContactPinErrorV1'
    this.code = code
  }
}

function requireText(value: unknown, field: string): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result) throw new CanonicalContactPinErrorV1('INPUT_INVALID', `${field} is required`)
  return result
}

function fields(value: Prisma.JsonValue | null): Prisma.JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Prisma.JsonObject : {}
}

/**
 * Pins one Contact as the canonical record of a person.
 *
 * Idempotent: an existing pin is preserved exactly, including its original
 * timestamp and author, and reported as `already_pinned`. A repeat is never a
 * second write, so re-running a repair that pins first cannot rewrite history.
 */
export async function pinCanonicalContactV1(input: {
  contactId: string
  pinnedBy: string
}): Promise<PinCanonicalContactResultV1> {
  const contactId = requireText(input?.contactId, 'contactId')
  const pinnedBy = requireText(input?.pinnedBy, 'pinnedBy')

  return runContactOwnershipTransaction(async transaction => {
    await lockContactOwnershipRows(transaction, { contactIds: [contactId] })
    const contact = await transaction.contact.findUnique({
      where: { id: contactId },
      select: { id: true, isArchived: true, customFields: true },
    })
    if (!contact || contact.isArchived) {
      throw new CanonicalContactPinErrorV1(
        'CONTACT_NOT_ELIGIBLE',
        `Contact ${contactId} is missing or archived`,
      )
    }

    const contactFields = fields(contact.customFields)
    const existingPin = typeof contactFields.canonicalPinnedAt === 'string'
      ? contactFields.canonicalPinnedAt
      : null
    if (existingPin) {
      return {
        status: 'already_pinned' as const,
        contactId,
        canonicalPinnedAt: existingPin,
        canonicalPinnedBy: typeof contactFields.canonicalPinnedBy === 'string'
          ? contactFields.canonicalPinnedBy
          : null,
      }
    }

    const pinnedAt = new Date().toISOString()
    await transaction.contact.update({
      where: { id: contactId },
      data: {
        customFields: {
          ...contactFields,
          canonicalPinnedAt: pinnedAt,
          canonicalPinnedBy: pinnedBy,
        } as Prisma.InputJsonObject,
      },
    })
    return {
      status: 'pinned' as const,
      contactId,
      canonicalPinnedAt: pinnedAt,
      canonicalPinnedBy: pinnedBy,
    }
  })
}
