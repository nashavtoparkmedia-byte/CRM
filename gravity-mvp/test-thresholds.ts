
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const thresholds = await prisma.scoringThreshold.findMany()
  console.log('Current thresholds:', thresholds)
  
  const drivers = await prisma.driver.count()
  console.log('Total drivers:', drivers)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
