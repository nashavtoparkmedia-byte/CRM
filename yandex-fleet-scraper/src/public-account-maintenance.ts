import { PrismaClient } from '@prisma/client'

/** Yandex Fleet-owned exact repair for accounts missing encrypted session state. */
export async function disableAccountsWithoutStorageStateV1() {
    const prisma = new PrismaClient()
    try {
        return await prisma.account.updateMany({ where: { storageStateEncrypted: null }, data: { state: 'DISABLED' } })
    } finally {
        await prisma.$disconnect()
    }
}
