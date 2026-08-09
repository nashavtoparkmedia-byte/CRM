import{prisma}from'@/lib/prisma';import type{ContactPhonePersistencePortV1}from'./contact-phone-handler'
export const legacyPrismaContactPhonePortV1:ContactPhonePersistencePortV1={async deactivate(contactPhoneId){await prisma.contactPhone.update({where:{id:contactPhoneId},data:{isActive:false}})},async create(input){return prisma.contactPhone.create({data:input})}}
