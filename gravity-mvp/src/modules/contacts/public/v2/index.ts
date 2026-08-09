import { createResolveContactHandlerV2 } from './resolve-contact-handler'
import { legacyPrismaResolveContactPortV2 } from './legacy-prisma-contact-adapter'
export { createResolveContactHandlerV2 } from './resolve-contact-handler'
export type { ResolveContactPersistencePortV2 } from './resolve-contact-handler'
export const resolveContactV2 = createResolveContactHandlerV2(legacyPrismaResolveContactPortV2)
