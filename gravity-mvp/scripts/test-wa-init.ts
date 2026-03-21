import { initializeClient, getClient } from '../src/lib/whatsapp/WhatsAppService'
import { prisma } from '../src/lib/prisma'

async function main() {
    const conn = await prisma.whatsAppConnection.findFirst({ where: { status: 'ready' } })
    if (!conn) {
        console.log('No ready connection found')
        return
    }
    console.log(`Found connection: ${conn.id}, starting init...`)
    await initializeClient(conn.id)
    
    // Wait for it to become ready
    console.log('Waiting for client to be ready...')
    let attempts = 0
    const interval = setInterval(() => {
        attempts++
        const client = getClient(conn.id)
        if (client && client.info) {
            console.log('Client is READY!', client.info.wid.user)
            clearInterval(interval)
            process.exit(0)
        }
        if (attempts > 60) {
            console.log('Timeout reached!')
            clearInterval(interval)
            process.exit(1)
        }
    }, 1000)
}

main().catch(console.error)
