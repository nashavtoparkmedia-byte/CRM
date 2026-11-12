const fetch = require('node-fetch');

async function testSequentialFix() {
  const url = 'http://localhost:3002/api/webhook/telegram';
  const telegramId = (process.env.YOKO_SCRIPT_TELEGRAM_ID || (() => { throw new Error('YOKO_SCRIPT_TELEGRAM_ID is required: no built-in Telegram id'); })());
  
  const messages = ['Раз (seq)', 'Два (seq)', 'Три (seq)', 'Четыре (seq)', 'Пять (seq)'];

  console.log('Sending 5 messages SEQUENTIALLY...');
  for (const text of messages) {
    console.log(`Sending: ${text}`);
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
    const json = await res.json();
    console.log(`Response for ${text}:`, json.success);
    // Tiny delay to ensure different timestamps if needed, though sequential should be enough
    await new Promise(r => setTimeout(r, 200));
  }
}

testSequentialFix().catch(console.error);
