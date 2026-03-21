
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
    const dc = await prisma.driver.count();
    const sc = await prisma.driverDaySummary.count();
    const tc = await prisma.driverDaySummary.count({ where: { tripCount: { gt: 0 } } });
    console.log(`Drivers: ${dc}`);
    console.log(`Summaries: ${sc}`);
    console.log(`Summaries with trips: ${tc}`);
}
main().finally(() => prisma.$disconnect());
