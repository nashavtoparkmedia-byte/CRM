const http = require('http');

const surveyId = 'bbd15c7a-c378-41d5-87bc-e917bde5ada4';
const url = `http://127.0.0.1:3001/api/admin/surveys/${surveyId}/users`;

http.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
        try {
            const users = JSON.parse(data);
            console.log(`Total users found: ${users.length}`);
            if (users.length > 0) {
                const user = users.find(u => u.id === 'af194939-fb9e-4600-945e-e6922ebe6391');
                if (user) {
                    console.log('--- User with History Info ---');
                    console.log(`ID: ${user.id}`);
                    console.log(`SurveyHistory Length: ${user.surveyHistory ? user.surveyHistory.length : 'UNDEFINED'}`);
                    if (user.surveyHistory) {
                        user.surveyHistory.forEach((h, i) => {
                            console.log(`  [${i}] Created: ${h.createdAt}, HasMetadata: ${!!h.metadata}`);
                        });
                    }
                } else {
                    console.log('User af194939... not found in this survey response.');
                    console.log('Users in response:', users.map(u => u.id));
                }
            }
        } catch (e) {
            console.error('Failed to parse JSON:', e.message);
            console.log('Raw response:', data.substring(0, 500));
        }
    });
}).on('error', (err) => {
    console.error('Request failed:', err.message);
});
