import { createResolveContactHandlerV2 } from '../public/v2/resolve-contact-handler'
import { legacyPrismaResolveContactPortV2 } from '../public/v2/legacy-prisma-contact-adapter'

const resolveContact = createResolveContactHandlerV2(legacyPrismaResolveContactPortV2)

export const resolveContactV2 = (...args: Parameters<typeof resolveContact>) => resolveContact(...args)
