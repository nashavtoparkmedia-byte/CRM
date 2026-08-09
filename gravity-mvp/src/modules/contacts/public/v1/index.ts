import { createResolveContactHandlerV1 } from './resolve-contact-handler'
import { legacyPrismaResolveContactPortV1 } from './legacy-prisma-contact-adapter'
import { createAttachContactIdentityHandlerV1 } from './attach-contact-identity-handler'
import { legacyPrismaAttachContactIdentityPortV1 } from './legacy-prisma-contact-identity-adapter'
import { createSetContactDisplayNameHandlerV1 } from './set-contact-display-name-handler'
import { legacyPrismaSetContactDisplayNamePortV1 } from './legacy-prisma-contact-display-name-adapter'

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
