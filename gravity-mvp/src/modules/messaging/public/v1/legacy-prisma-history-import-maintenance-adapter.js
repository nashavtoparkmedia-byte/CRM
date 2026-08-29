/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

function validateId(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new TypeError(`${field} must be a bounded non-empty string`)
}

/** Messaging-owned one-shot completion repair with a fixed status payload. */
async function completeHistoryImportJobV1(jobId) {
  validateId(jobId, 'jobId')
  const prisma = new PrismaClient()
  try {
    return await prisma.historyImportJob.update({
      where: { id: jobId },
      data: {
        status: 'completed', resultType: 'full', messagesImported: 761,
        chatsScanned: 22, contactsFound: 23, finishedAt: new Date(),
      },
    })
  } finally {
    await prisma.$disconnect()
  }
}

module.exports = { completeHistoryImportJobV1 }
