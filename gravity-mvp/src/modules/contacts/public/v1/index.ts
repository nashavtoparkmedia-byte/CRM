import { createResolveContactHandlerV1 } from './resolve-contact-handler'
import { legacyPrismaResolveContactPortV1 } from './legacy-prisma-contact-adapter'

export { createResolveContactHandlerV1 } from './resolve-contact-handler'
export type { ResolveContactPersistencePortV1 } from './resolve-contact-handler'
export { isLegacyPlaceholderContactNameV1 } from './legacy-contact-name-policy'

export const resolveContactV1 = createResolveContactHandlerV1(legacyPrismaResolveContactPortV1)
