/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')
const { enableAiInternV1 } = require('../src/modules/calling/public/v1/legacy-prisma-ai-maintenance-adapter')
const p = new PrismaClient()
async function main() {
    const config = await p.aiAgentConfig.findUnique({ where: { id: 'singleton' } })
    console.log('=== Current ===')
    console.log('enabled:', config.enabled)
    console.log('internEnabled:', config.internEnabled)
    console.log('mode:', config.mode)

    if (!config.enabled || !config.internEnabled) {
        const updated = await enableAiInternV1()
        console.log('\n=== Fixed ===')
        console.log('enabled:', updated.enabled)
        console.log('internEnabled:', updated.internEnabled)
    } else {
        console.log('\nAll OK — no fix needed')
    }
}
main().catch(console.error).finally(() => p.$disconnect())
