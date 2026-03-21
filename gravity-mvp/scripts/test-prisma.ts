import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function test() {
  try {
    const drivers = await prisma.driver.findMany({
      take: 1,
      select: {
        id: true,
        licenseNumber: true,
        hiredAt: true,
        dismissedAt: true,
        lastOrderAt: true
      }
    })
    console.log('Success:', drivers)
  } catch (error: any) {
    console.error('Validation Error Details:', error.message)
  } finally {
    await prisma.$disconnect()
  }
}

test()
