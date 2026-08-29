import{prisma}from'@/lib/prisma';import type{ApiLogPersistencePortV1}from'./api-log-handler'
export const legacyPrismaApiLogPortV1:ApiLogPersistencePortV1={async deleteForConnection(connectionId){const result=await prisma.apiLog.deleteMany({where:{connectionId}});return{deletedCount:result.count}},async create(data){return prisma.apiLog.create({data})}}
