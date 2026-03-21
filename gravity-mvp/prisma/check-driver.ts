import { PrismaClient } from '@prisma/client'
import fs from 'fs'
import path from 'path'

// Manually load .env since we are in a standalone script without next
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const matches = envContent.match(/DATABASE_URL=["']?(.+?)["']?(\s|$)/);
    if (matches && matches[1]) {
      process.env.DATABASE_URL = matches[1];
      console.log('Successfully loaded DATABASE_URL from .env');
    }
  }
} catch (e) {
  console.error('Failed to load .env', e);
}

const prisma = new PrismaClient()

async function main() {
  console.log('Querying database for drivers named "Александр"...');
  const drivers = await prisma.driver.findMany({
    where: {
      fullName: {
        contains: 'Александр',
        mode: 'insensitive'
      }
    },
    select: {
      id: true,
      fullName: true,
      phone: true,
      yandexDriverId: true
    }
  })

  console.log('RESULT_START');
  console.log(JSON.stringify(drivers, null, 2));
  console.log('RESULT_END');
}

main()
  .catch((e) => {
    console.error('Error executing query:', e);
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
