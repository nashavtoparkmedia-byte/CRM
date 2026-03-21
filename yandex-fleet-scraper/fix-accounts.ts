import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const updated = await prisma.account.updateMany({
        where: { storageStateEncrypted: null },
        data: { state: 'DISABLED' }
    });
    console.log(`Disabled ${updated.count} empty accounts! ✅`);
}
main().finally(() => prisma.$disconnect());
