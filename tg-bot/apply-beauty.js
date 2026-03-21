const sheetsService = require('./src/services/sheets');
const logger = require('./src/utils/logger');

async function run() {
    try {
        console.log('Applying professional formatting to Google Sheets...');
        await sheetsService.initializeSheet();
        console.log('✅ Success! Check your Google Sheets now.');
    } catch (err) {
        console.error('❌ Error:', err.message);
    }
}

run();
