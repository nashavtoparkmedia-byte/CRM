const fetch = require('node-fetch');

async function testMissedMessages() {
  const url = 'http://localhost:3002/api/webhook/telegram';
  const telegramId = '316425068';
  
  const messages = ['2222', '3333'];

  for (const text of messages) {
    console.log(`Sending message: ${text}...`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-bot-signature': 'secret'
      },
      body: JSON.stringify({
        telegramId,
        text,
        direction: 'INCOMING',
        username: 'testuser'
      })
    });
    console.log(`Response for ${text}:`, await res.json());
    // Small delay to simulate real user typing
    await new Promise(r => setTimeout(r, 1000));
  }
}

testMissedMessages().catch(console.error);
