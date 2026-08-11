/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

/** Fleet Operations-owned fixed park display-name seed. */
async function renameDefaultParkConnectionsV1() {
  const prisma = new PrismaClient()
  try {
    const yoko = await prisma.apiConnection.updateMany({
      where: { parkId: '3a23295d8d714c03b61a17a6fc86601b' },
      data: { name: 'Yoko' },
    })
    const ourPark = await prisma.apiConnection.updateMany({
      where: { parkId: '45e30e9d6b824c608e5d28719cb19a6e' },
      data: { name: 'Наш Автопарк' },
    })
    return { yoko, ourPark }
  } finally {
    await prisma.$disconnect()
  }
}

module.exports = { renameDefaultParkConnectionsV1 }
