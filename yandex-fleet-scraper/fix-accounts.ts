import { PrismaClient } from '@prisma/client';
import { disableAccountsWithoutStorageStateV1 } from './src/public-account-maintenance.js';
const prisma = new PrismaClient();

async function main() {
    const updated = await disableAccountsWithoutStorageStateV1();
    console.log(`Disabled ${updated.count} empty accounts! ✅`);
}
main().finally(() => prisma.$disconnect());
