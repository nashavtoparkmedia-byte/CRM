/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

/** Fixed Calling-owned repair for the singleton AI intern toggle. */
async function enableAiInternV1() {
  const prisma = new PrismaClient()
  try {
    return await prisma.aiAgentConfig.update({
      where: { id: 'singleton' },
      data: { enabled: true, internEnabled: true },
    })
  } finally {
    await prisma.$disconnect()
  }
}

const TELEPHONY_FIELDS = ['criteria', 'outcomeOptions', 'sentimentOptions', 'nextActionOptions']
function validateOptions(value, field) {
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new TypeError(`${field} must be an array of objects`)
  }
}

/** Fixed Calling-owned seed for the singleton telephony AI configuration. */
async function reseedTelephonyAiConfigV1({ criteria, outcomeOptions, sentimentOptions, nextActionOptions }) {
  const values = { criteria, outcomeOptions, sentimentOptions, nextActionOptions }
  for (const field of TELEPHONY_FIELDS) validateOptions(values[field], field)
  const prisma = new PrismaClient()
  try {
    return await prisma.telephonyAiConfig.upsert({
      where: { id: 'singleton' },
      update: values,
      create: {
        id: 'singleton', enabled: true, model: 'gpt-4o',
        systemPrompt: '(generated from criteria)', ...values,
      },
    })
  } finally {
    await prisma.$disconnect()
  }
}

module.exports = { enableAiInternV1, reseedTelephonyAiConfigV1 }
