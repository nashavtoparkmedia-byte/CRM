/* eslint-disable @typescript-eslint/no-require-imports */
const { renameDefaultParkConnectionsV1 } = require('../src/modules/fleet-operations/public/v1/legacy-prisma-api-connection-maintenance-adapter');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const all = await prisma.apiConnection.findMany({ select: { id: true, parkId: true, name: true } });
  console.log('Current parks:', JSON.stringify(all, null, 2));

  const { yoko, ourPark: na } = await renameDefaultParkConnectionsV1();
  console.log('Updated Yoko:', yoko.count);
  console.log('Updated НА:', na.count);

  const after = await prisma.apiConnection.findMany({ select: { id: true, parkId: true, name: true } });
  console.log('After update:', JSON.stringify(after, null, 2));

  await prisma.$disconnect();
}

run().catch(console.error);
