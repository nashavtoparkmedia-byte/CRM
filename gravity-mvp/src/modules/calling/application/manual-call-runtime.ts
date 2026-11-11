import 'server-only'

import { CONTACT_COMMUNICATION_PERMISSION_QUERY_V1, CONTACT_PERSON_CARD_QUERY_V1 } from '@/contracts/contacts/v1'
import { getContactCommunicationPermissionV1, readContactPersonCardV1 } from '@/modules/contacts/public/v1'
import { getStaffSessionPrincipalV1 } from '@/modules/identity-access/public/v1'
import type {
  CancelManualCallResultV1,
  ManualCallAvailabilityResultV1,
  StartManualCallResultV1,
} from '@/contracts/calling/v1/manual-call'
import { freeswitchManualCallDialPort } from '../internal/manual-calls/freeswitch-manual-call-adapter'
import { manualCallPrismaStore } from '../internal/manual-calls/manual-call-prisma-adapter'
import { staffExtensionForV1 } from '../internal/manual-calls/staff-extension-directory'
import { createManualCallOperations } from './manual-call'

const operations = createManualCallOperations({
  async principal() {
    // Only a signed Staff Session counts. There is no fallback to the unsigned legacy cookie:
    // without a Staff Session, manual calls from the CRM are unavailable (Owner decision Q1).
    const principal = await getStaffSessionPrincipalV1()
    return principal === null ? null : { userId: principal.userId, role: principal.role }
  },
  extensionFor: staffExtensionForV1,
  readPerson: contactId => readContactPersonCardV1({ contract: CONTACT_PERSON_CARD_QUERY_V1, contactId }),
  voicePermission: contactId => getContactCommunicationPermissionV1({
    contract: CONTACT_COMMUNICATION_PERMISSION_QUERY_V1,
    contactId,
    communicationClass: 'voice',
  }),
  store: manualCallPrismaStore,
  dial: freeswitchManualCallDialPort,
  now: () => new Date(),
})

export async function startManualCall(input: unknown): Promise<StartManualCallResultV1> {
  return operations.start(input)
}

export async function readManualCallAvailability(input: unknown): Promise<ManualCallAvailabilityResultV1> {
  return operations.availability(input)
}

export async function cancelManualCall(input: unknown): Promise<CancelManualCallResultV1> {
  return operations.cancel(input)
}
