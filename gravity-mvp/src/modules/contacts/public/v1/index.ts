import { createResolveContactHandlerV1 } from './resolve-contact-handler'
import { legacyPrismaResolveContactPortV1 } from './legacy-prisma-contact-adapter'
import { createAttachContactIdentityHandlerV1 } from './attach-contact-identity-handler'
import { legacyPrismaAttachContactIdentityPortV1 } from './legacy-prisma-contact-identity-adapter'
import { createSetContactDisplayNameHandlerV1 } from './set-contact-display-name-handler'
import { legacyPrismaSetContactDisplayNamePortV1 } from './legacy-prisma-contact-display-name-adapter'
import { createCreateContactPhoneHandlerV1,createDeactivateContactPhoneHandlerV1 } from './contact-phone-handler'
import { legacyPrismaContactPhonePortV1 } from './legacy-prisma-contact-phone-adapter'
import { createCreateFleetContactHandlerV1, createPatchFleetContactHandlerV1 } from './fleet-contact-handler'
import { legacyPrismaFleetContactPortV1 } from './legacy-prisma-fleet-contact-adapter'
import { createDeleteContactForRetentionHandlerV1 } from './contact-retention-handler'
import { legacyPrismaContactRetentionPortV1 } from './legacy-prisma-contact-retention-adapter'
import {
    createGetPreferredActiveContactPhoneHandlerV1,
    createPrepareContactConversationIdentityHandlerV1,
    createResolveChannelContactHandlerV1,
} from './contact-conversation-handler'
import { legacyPrismaContactConversationPortV1 } from './legacy-prisma-contact-conversation-adapter'

export { createResolveContactHandlerV1 } from './resolve-contact-handler'
export type { ResolveContactPersistencePortV1 } from './resolve-contact-handler'
export { isLegacyPlaceholderContactNameV1 } from './legacy-contact-name-policy'
export { createAttachContactIdentityHandlerV1 } from './attach-contact-identity-handler'
export type { AttachContactIdentityPersistencePortV1 } from './attach-contact-identity-handler'
export { createSetContactDisplayNameHandlerV1 } from './set-contact-display-name-handler'
export type { SetContactDisplayNamePersistencePortV1 } from './set-contact-display-name-handler'

export const resolveContactV1 = createResolveContactHandlerV1(legacyPrismaResolveContactPortV1)
export const attachContactIdentityV1 = createAttachContactIdentityHandlerV1(legacyPrismaAttachContactIdentityPortV1)
export const setContactDisplayNameV1 = createSetContactDisplayNameHandlerV1(legacyPrismaSetContactDisplayNamePortV1)
export { createCreateContactPhoneHandlerV1,createDeactivateContactPhoneHandlerV1 } from './contact-phone-handler'
export type { ContactPhonePersistencePortV1 } from './contact-phone-handler'
export const deactivateContactPhoneV1=createDeactivateContactPhoneHandlerV1(legacyPrismaContactPhonePortV1)
export const createContactPhoneV1=createCreateContactPhoneHandlerV1(legacyPrismaContactPhonePortV1)
export { createCreateFleetContactHandlerV1, createPatchFleetContactHandlerV1 } from './fleet-contact-handler'
export type { FleetContactPersistencePortV1 } from './fleet-contact-handler'
export const patchFleetContactV1 = createPatchFleetContactHandlerV1(legacyPrismaFleetContactPortV1)
export const createFleetContactV1 = createCreateFleetContactHandlerV1(legacyPrismaFleetContactPortV1)
export { createDeleteContactForRetentionHandlerV1 } from './contact-retention-handler'
export type { ContactRetentionPersistencePortV1 } from './contact-retention-handler'
export const deleteContactForRetentionV1 = createDeleteContactForRetentionHandlerV1(legacyPrismaContactRetentionPortV1)
export {
    createGetPreferredActiveContactPhoneHandlerV1,
    createPrepareContactConversationIdentityHandlerV1,
    createResolveChannelContactHandlerV1,
} from './contact-conversation-handler'
export type {
    ContactConversationPersistencePortV1,
    PrepareContactConversationIdentityPersistenceResultV1,
} from './contact-conversation-handler'
export const resolveChannelContactV1 = createResolveChannelContactHandlerV1(legacyPrismaContactConversationPortV1)
export const prepareContactConversationIdentityV1 =
    createPrepareContactConversationIdentityHandlerV1(legacyPrismaContactConversationPortV1)
export const getPreferredActiveContactPhoneV1 =
    createGetPreferredActiveContactPhoneHandlerV1(legacyPrismaContactConversationPortV1)
