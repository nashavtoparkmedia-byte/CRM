import { createCrmUserQueryHandlerV1 } from '../public/v1/crm-user-query-handler'
import { legacyPrismaCrmUserQueryPortV1 } from '../public/v1/legacy-prisma-crm-user-query-adapter'

const queryCrmUser = createCrmUserQueryHandlerV1(legacyPrismaCrmUserQueryPortV1)

export const queryCrmUserV1 = (...args: Parameters<typeof queryCrmUser>) => queryCrmUser(...args)
