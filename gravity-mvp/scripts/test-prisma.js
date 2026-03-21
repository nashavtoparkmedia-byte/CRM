const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
    try {
        const id = "f55fbc217bc8db76e06e6fa79894c607";
        console.log("Testing findFirst for driverId:", id);

        const tgLink = await prisma.driverTelegram.findFirst({
            where: { driverId: id }
        });

        console.log("Result:", tgLink);
    } catch (err) {
        console.error("Prisma Error:", err);
    } finally {
        await prisma.$disconnect();
    }
}
run();
