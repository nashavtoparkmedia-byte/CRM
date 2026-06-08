/**
 * Temporarily redirect telegramId=316425068 mapping to a stub Driver
 * with Ахметов's yandexDriverId so that real driver-actions probe runs
 * against his live order. Original mapping is preserved for rollback.
 *
 * Run with:
 *   node scripts/temp_swap_driver_to_ahmetov.js          (swap to Ahmetov)
 *   node scripts/temp_swap_driver_to_ahmetov.js restore  (restore original)
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TG_ID = 316425068n;
const TEST_DRIVER_ID = 'test_temp_driver';
const TEST_FULL_NAME = process.env.TEST_FULL_NAME || '[TEST] Коренько Артем';
const TEST_YANDEX_ID = process.env.TEST_YANDEX_ID || '2caeebdf2a0e44e28996175bcf8daf5c';
const ORIGINAL_DRIVER_ID = 'cmmn7mq4h0003vpz8dxibq1dy';

async function swap() {
    // Clean up the old Ahmetov-specific test driver if it exists.
    await prisma.driverAction.deleteMany({ where: { driverId: 'test_ahmetov_temp' } }).catch(() => {});
    await prisma.driver.delete({ where: { id: 'test_ahmetov_temp' } }).catch(() => {});

    // Idempotent upsert of the test driver
    const testDriver = await prisma.driver.upsert({
        where: { id: TEST_DRIVER_ID },
        update: { yandexDriverId: TEST_YANDEX_ID, fullName: TEST_FULL_NAME, updatedAt: new Date() },
        create: {
            id: TEST_DRIVER_ID,
            yandexDriverId: TEST_YANDEX_ID,
            fullName: TEST_FULL_NAME,
            phone: '+70000000000',
        },
    });
    console.log(`✅ test driver upserted: ${testDriver.id} -> ${testDriver.yandexDriverId}`);

    const updated = await prisma.driverTelegram.updateMany({
        where: { telegramId: TG_ID },
        data: { driverId: TEST_DRIVER_ID },
    });
    console.log(`✅ DriverTelegram updated: ${updated.count} row(s) → driverId=${TEST_DRIVER_ID}`);
    console.log(`\nИди в Telegram → "🚖 Текущий заказ" — должен найти живой заказ Ахметова.`);
    console.log(`Для отката: node scripts/temp_swap_driver_to_ahmetov.js restore`);
}

async function restore() {
    const updated = await prisma.driverTelegram.updateMany({
        where: { telegramId: TG_ID },
        data: { driverId: ORIGINAL_DRIVER_ID },
    });
    console.log(`✅ DriverTelegram restored: ${updated.count} row(s) → driverId=${ORIGINAL_DRIVER_ID} (Ремезов)`);

    // Clean up DriverAction rows pointing at the test driver (FK)
    const cleanedActions = await prisma.driverAction.deleteMany({ where: { driverId: TEST_DRIVER_ID } });
    console.log(`🧹 cleaned ${cleanedActions.count} DriverAction(s) for test driver`);

    const cleaned = await prisma.driver.delete({ where: { id: TEST_DRIVER_ID } }).catch(e => {
        console.log(`(test driver delete skipped: ${e.message})`);
        return null;
    });
    if (cleaned) console.log(`🧹 test driver deleted`);
}

const mode = process.argv[2] === 'restore' ? 'restore' : 'swap';
(mode === 'swap' ? swap : restore)()
    .catch(e => { console.error('💥', e.message); process.exit(1); })
    .finally(() => prisma.$disconnect());
