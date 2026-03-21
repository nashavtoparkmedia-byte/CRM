
async function testTgConnection() {
    try {
        console.log('Testing connection to TG-Bot-1 at http://localhost:3001/api/bot/send-message...')
        const res = await fetch('http://localhost:3001/api/bot/send-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chatId: '12345',
                text: 'Test connection from script'
            })
        })
        console.log('Status:', res.status)
        const data = await res.json().catch(() => ({ msg: 'No JSON body' }))
        console.log('Data:', data)
    } catch (err: any) {
        console.error('Fetch error:', err.message)
    }
}

testTgConnection()
