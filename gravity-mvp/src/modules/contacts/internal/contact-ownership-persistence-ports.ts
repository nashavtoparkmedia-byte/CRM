import { ContactService } from '@/lib/ContactService'

import type { ContactPhonePersistencePortV1 } from '../public/v1/contact-phone-handler'
import type { ContactRetentionPersistencePortV1 } from '../public/v1/contact-retention-handler'
import type { FleetContactPersistencePortV1 } from '../public/v1/fleet-contact-handler'
import type { MarkTemporaryContactPhonePersistencePortV1 } from '../public/v1/mark-temporary-contact-phone-handler'

/** Owner-local persistence bindings for existing Contacts public handlers. */
export const contactOwnershipPhonePortV1: ContactPhonePersistencePortV1 = {
  async deactivate(contactPhoneId) {
    await ContactService.deactivateContactPhone(contactPhoneId)
  },
  async create(input) {
    const result = await ContactService.addPhoneToContact(input.contactId, input.phone, {
      source: input.source,
      makePrimary: input.isPrimary,
    })
    if (result.kind === 'conflict') {
      throw new Error(`PHONE_BELONGS_TO_OTHER:${result.otherContactId}`)
    }
    return { id: result.phoneId }
  },
}

export const contactOwnershipRetentionPortV1: ContactRetentionPersistencePortV1 = {
  async deleteContactForRetention(contactId) {
    return ContactService.deleteContactForRetention(contactId)
  },
}

export const contactOwnershipFleetPortV1: FleetContactPersistencePortV1 = {
  async patch(contactId, patch) {
    const updated = await ContactService.patchContact(contactId, patch)
    if (!updated) throw new Error(`Contact ${contactId} not found or ownership patch invalid`)
  },
  async create(input) {
    const contact = await ContactService.createFleetContact(input)
    return { id: contact.id, primaryPhoneId: contact.primaryPhoneId }
  },
}

export const contactOwnershipTemporaryPhonePortV1: MarkTemporaryContactPhonePersistencePortV1 = {
  async mark(input) {
    return ContactService.markTemporaryContactPhone(input)
  },
}
