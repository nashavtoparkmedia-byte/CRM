/**
 * One-shot: merge phone-format WA chat into the @lid chat that has the actual
 * conversation, then rename the @lid chat to the canonical phone format.
 *
 * Chats in question (found via logs):
 *   KEEP  cmqfw19gs0002sg2639z1tz9g  165193082482905@lid  (has messages, current)
 *   DEL   cmq9z45jy02e9l3243rrql7ik  whatsapp:79222155750 (empty duplicate)
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const { mergeDuplicateWaChatV1 } = require('../src/modules/messaging/public/v1/legacy-prisma-duplicate-wa-chat-maintenance-adapter')
const { repairLegacyDuplicateWaChatV1 } = require('../src/modules/whatsapp-channel/public/v1/legacy-prisma-duplicate-wa-chat-maintenance-adapter')

async function main() {
  const result = await mergeDuplicateWaChatV1()
  console.log(`Moved ${result.moved.count} messages from DEL to KEEP`)
  await repairLegacyDuplicateWaChatV1()

  console.log('Done.')
}

main().catch(e => { console.error(e); process.exit(1) })
