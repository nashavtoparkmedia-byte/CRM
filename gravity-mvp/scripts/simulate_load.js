const fetch = require('node-fetch');

async function testHighLoad() {
  const url = 'http://localhost:3002/api/webhook/telegram';
  const telegramId = '316425068';
  
  const messages = [
    'Load 1', 'Load 2', 'Load 3', 'Load 4', 'Load 5',
    'Load 6', 'Load 7', 'Load 8', 'Load 9', 'Load 10'
  ];

  console.log('Sending 10 messages RAPIDLY...');
  const promises = messages.map(text => {
    return fetch(url, {
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
    }).then(res => res.json());
  });

  const results = await Promise.all(promises);
  console.log('Results:', results.length, 'messages processed.');
}

testHighLoad().catch(console.error);
