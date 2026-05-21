import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())
import { MessageService } from '../src/lib/MessageService'

async function main() {
    const chatId = process.argv[2] ?? 'cmp7a5b080001vp1sz33nrbjx'
    const limit = Number(process.argv[3] ?? 50)
    const messages = await MessageService.listMessages(chatId, limit)

    if (!Array.isArray(messages)) {
        console.log('NOT_ARRAY:', JSON.stringify(messages).slice(0, 500))
        process.exit(0)
    }
    console.log(`MessageService.listMessages returned: ${messages.length} items`)
    if (messages.length === 0) {
        console.log('Empty — listMessages filters something out even though DB has rows.')
    } else {
        console.log('First 3 (shape that frontend receives):')
        messages.slice(0, 3).forEach((m: any) => {
            console.log('  ' + JSON.stringify({
                id: m.id,
                type: m.type,
                channel: m.channel,
                direction: m.direction,
                content: m.content,
                sentAt: m.sentAt,
                metadata: m.metadata,
            }))
        })
    }
    process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
