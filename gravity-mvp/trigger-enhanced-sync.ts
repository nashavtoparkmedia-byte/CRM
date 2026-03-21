
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const connection = await prisma.apiConnection.findFirst({
        orderBy: { createdAt: 'desc' },
  });

  if (!connection) {
    console.error('No API connection');
    return;
  }

  console.log('Starting full sync with activity dates...');
  const res = await fetch('http://localhost:3002/api/monitoring/sync', {
    method: 'POST',
    headers: {
      'x-cron-key': process.env.CRON_SECRET || '',
    }
  });

  const data = await res.json();
  console.log('Sync result:', data);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
