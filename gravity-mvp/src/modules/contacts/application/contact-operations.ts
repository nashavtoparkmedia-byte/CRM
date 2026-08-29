import { createResolveContactHandlerV1 } from '../public/v1/resolve-contact-handler'
import { legacyPrismaResolveContactPortV1 } from '../public/v1/legacy-prisma-contact-adapter'
import { createAttachContactIdentityHandlerV1 } from '../public/v1/attach-contact-identity-handler'
import { legacyPrismaAttachContactIdentityPortV1 } from '../public/v1/legacy-prisma-contact-identity-adapter'
import { createSetContactDisplayNameHandlerV1 } from '../public/v1/set-contact-display-name-handler'
import { legacyPrismaSetContactDisplayNamePortV1 } from '../public/v1/legacy-prisma-contact-display-name-adapter'
import { createCreateContactPhoneHandlerV1, createDeactivateContactPhoneHandlerV1 } from '../public/v1/contact-phone-handler'
import { legacyPrismaContactPhonePortV1 } from '../public/v1/legacy-prisma-contact-phone-adapter'
import { createMarkTemporaryContactPhoneHandlerV1 } from '../public/v1/mark-temporary-contact-phone-handler'
import { legacyPrismaMarkTemporaryContactPhonePortV1 } from '../public/v1/legacy-prisma-mark-temporary-contact-phone-adapter'
import { createCreateFleetContactHandlerV1, createPatchFleetContactHandlerV1 } from '../public/v1/fleet-contact-handler'
import { legacyPrismaFleetContactPortV1 } from '../public/v1/legacy-prisma-fleet-contact-adapter'
import { createDeleteContactForRetentionHandlerV1 } from '../public/v1/contact-retention-handler'
import { legacyPrismaContactRetentionPortV1 } from '../public/v1/legacy-prisma-contact-retention-adapter'
import {
    createGetPreferredActiveContactPhoneHandlerV1,
    createPrepareContactConversationIdentityHandlerV1,
    createResolveChannelContactHandlerV1,
} from '../public/v1/contact-conversation-handler'
import { legacyPrismaContactConversationPortV1 } from '../public/v1/legacy-prisma-contact-conversation-adapter'
import {
    addPhoneToContactV1 as addPhoneToContact,
    attachPhoneToIdentityV1 as attachPhoneToIdentity,
    cleanupDanglingContactIdentitiesV1 as cleanupDanglingContactIdentities,
    resolveChannelContactOperationV1 as resolveChannelContactOperation,
    resolveContactByPhoneV1 as resolveContactByPhone,
} from '../public/v1/contact-identity-maintenance'
import {
    getContactParkCheckContextV1 as getContactParkCheckContext,
    persistContactParkCheckResultV1 as persistContactParkCheckResult,
} from '../public/v1/contact-park-check'

const resolveContact = createResolveContactHandlerV1(legacyPrismaResolveContactPortV1)
const attachContactIdentity = createAttachContactIdentityHandlerV1(legacyPrismaAttachContactIdentityPortV1)
const setContactDisplayName = createSetContactDisplayNameHandlerV1(legacyPrismaSetContactDisplayNamePortV1)
const deactivateContactPhone = createDeactivateContactPhoneHandlerV1(legacyPrismaContactPhonePortV1)
const markTemporaryContactPhone = createMarkTemporaryContactPhoneHandlerV1(legacyPrismaMarkTemporaryContactPhonePortV1)
const createContactPhone = createCreateContactPhoneHandlerV1(legacyPrismaContactPhonePortV1)
const patchFleetContact = createPatchFleetContactHandlerV1(legacyPrismaFleetContactPortV1)
const createFleetContact = createCreateFleetContactHandlerV1(legacyPrismaFleetContactPortV1)
const deleteContactForRetention = createDeleteContactForRetentionHandlerV1(legacyPrismaContactRetentionPortV1)
const resolveChannelContact = createResolveChannelContactHandlerV1(legacyPrismaContactConversationPortV1)
const prepareContactConversationIdentity = createPrepareContactConversationIdentityHandlerV1(legacyPrismaContactConversationPortV1)
const getPreferredActiveContactPhone = createGetPreferredActiveContactPhoneHandlerV1(legacyPrismaContactConversationPortV1)

export const resolveContactV1 = (...args: Parameters<typeof resolveContact>) => resolveContact(...args)
export const attachContactIdentityV1 = (...args: Parameters<typeof attachContactIdentity>) => attachContactIdentity(...args)
export const setContactDisplayNameV1 = (...args: Parameters<typeof setContactDisplayName>) => setContactDisplayName(...args)
export const deactivateContactPhoneV1 = (...args: Parameters<typeof deactivateContactPhone>) => deactivateContactPhone(...args)
export const markTemporaryContactPhoneV1 = (...args: Parameters<typeof markTemporaryContactPhone>) => markTemporaryContactPhone(...args)
export const createContactPhoneV1 = (...args: Parameters<typeof createContactPhone>) => createContactPhone(...args)
export const patchFleetContactV1 = (...args: Parameters<typeof patchFleetContact>) => patchFleetContact(...args)
export const createFleetContactV1 = (...args: Parameters<typeof createFleetContact>) => createFleetContact(...args)
export const deleteContactForRetentionV1 = (...args: Parameters<typeof deleteContactForRetention>) => deleteContactForRetention(...args)
export const resolveChannelContactV1 = (...args: Parameters<typeof resolveChannelContact>) => resolveChannelContact(...args)
export const prepareContactConversationIdentityV1 = (...args: Parameters<typeof prepareContactConversationIdentity>) => prepareContactConversationIdentity(...args)
export const getPreferredActiveContactPhoneV1 = (...args: Parameters<typeof getPreferredActiveContactPhone>) => getPreferredActiveContactPhone(...args)
export const addPhoneToContactV1 = (...args: Parameters<typeof addPhoneToContact>) => addPhoneToContact(...args)
export const attachPhoneToIdentityV1 = (...args: Parameters<typeof attachPhoneToIdentity>) => attachPhoneToIdentity(...args)
export const cleanupDanglingContactIdentitiesV1 = (...args: Parameters<typeof cleanupDanglingContactIdentities>) => cleanupDanglingContactIdentities(...args)
export const resolveChannelContactOperationV1 = (...args: Parameters<typeof resolveChannelContactOperation>) => resolveChannelContactOperation(...args)
export const resolveContactByPhoneV1 = (...args: Parameters<typeof resolveContactByPhone>) => resolveContactByPhone(...args)
export const getContactParkCheckContextV1 = (...args: Parameters<typeof getContactParkCheckContext>) => getContactParkCheckContext(...args)
export const persistContactParkCheckResultV1 = (...args: Parameters<typeof persistContactParkCheckResult>) => persistContactParkCheckResult(...args)
