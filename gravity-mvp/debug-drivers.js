
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkDriver() {
  const drivers = await prisma.driver.findMany({
    where: {
      OR: [
        { fullName: { contains: 'Huseynzade', mode: 'insensitive' } },
        { fullName: { contains: 'Vasif', mode: 'insensitive' } },
        { fullName: { contains: 'Аветисян', mode: 'insensitive' } },
      ]
    },
    select: {
      fullName: true,
      lastOrderAt: true,
      yandexDriverId: true,
      dismissedAt: true
    }
  });

  console.log(JSON.stringify(drivers, null, 2));
  await prisma.\$disconnect();
}

checkDriver();
