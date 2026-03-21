
import { PrismaClient } from '@prisma/client'
import * as fs from 'fs'
const prisma = new PrismaClient()

async function main() {
  const fortyFiveDaysAgo = new Date()
  fortyFiveDaysAgo.setDate(fortyFiveDaysAgo.getDate() - 45)

  const activeByOrder = await prisma.driver.count({
    where: { 
      dismissedAt: null,
      lastOrderAt: { gte: fortyFiveDaysAgo }
    }
  })
  
  const activeByHired = await prisma.driver.count({
    where: {
      dismissedAt: null,
      hiredAt: { gte: fortyFiveDaysAgo },
      lastOrderAt: { lt: fortyFiveDaysAgo } // To avoid double counting
    }
  })

  const output = JSON.stringify({
    activeByOrder,
    activeByHired,
    totalExpectedActive: activeByOrder + activeByHired
  }, null, 2)
  
  fs.writeFileSync('final_sync_results.log', output)
  console.log('Final counts:', output)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
