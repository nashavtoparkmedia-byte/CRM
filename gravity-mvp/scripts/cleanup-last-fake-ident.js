/* eslint-disable @typescript-eslint/no-require-imports */
const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const { deactivateFakeContactIdentityV1 } = require('../src/modules/contacts/public/v1/legacy-prisma-contact-identity-maintenance-adapter')
const prisma = new PrismaClient()
async function main() {
  const fakeIdent = await prisma.contactIdentity.findFirst({
    where: { channel: 'whatsapp', externalId: '71037351088', isActive: true },
  })
  if (!fakeIdent) { console.log('Already clean'); process.exit(0) }
  console.log('Found fake identity:', fakeIdent)
  await deactivateFakeContactIdentityV1(fakeIdent.id)
  console.log('Deactivated.')
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
