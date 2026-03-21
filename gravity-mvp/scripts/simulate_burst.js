const fetch = require('node-fetch');

async function testBurstFix() {
  const url = 'http://localhost:3002/api/webhook/telegram';
  const telegramId = '316425068';
  
  const messages = ['11 (burst)', '12 (burst)', '13 (burst)', '14 (burst)', '15 (burst)'];

  console.log('Sending 5 messages IN PARALLEL (Burst)...');
  
  const startTime = Date.now();
  const promises = messages.map((text, index) => {
    // Artificial small offset to simulate message sending sequence
    const timestamp = new Date(startTime + (index * 10)).toISOString();
    
    return fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        telegramId,
        text,
        direction: 'INCOMING',
        username: 'testuser',
        timestamp
      })
    }).then(r => r.json());
  });

  const results = await Promise.all(promises);
  results.forEach((r, i) => console.log(`Result ${messages[i]}:`, r.success));
}

testBurstFix().catch(console.error);
