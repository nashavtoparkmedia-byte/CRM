require('dotenv').config();
const { google } = require('googleapis');
const logger = require('./src/utils/logger');

// Configuration from .env
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID;
const SHEET_NAME = process.env.GOOGLE_SHEETS_NAME || 'Sheet1';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || 'service-account.json';

const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

async function runVerification() {
    console.log('='.repeat(60));
    console.log('Google Sheets Integration Verification');
    console.log('='.repeat(60));

    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });

        // 1. Write Data
        console.log('\n[Step 1] Writing test entry...');
        const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
        const values = [
            ['Test Entry', timestamp, 'Verified by Gravity']
        ];

        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A:C`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values }
        });
        console.log('✅ Write successful');

        // 2. Read back
        console.log('\n[Step 2] Reading back data...');
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A:C`
        });

        const rows = response.data.values;
        if (rows && rows.length > 0) {
            const lastRow = rows[rows.length - 1];
            console.log('✅ Read successful');
            console.log('\nLast entry in sheet:');
            console.log('  Column A:', lastRow[0]);
            console.log('  Column B:', lastRow[1]);
            console.log('  Column C:', lastRow[2]);

            if (lastRow[2] === 'Verified by Gravity' && lastRow[0] === 'Test Entry') {
                console.log('\n✨ INTEGRATION VERIFIED: Data matches!');
            } else {
                console.warn('\n⚠️ Warning: Last row found does not match expected test entry.');
                console.warn('It might be that another process wrote to the sheet simultaneously.');
            }
        } else {
            throw new Error('No data found in sheet after write');
        }

    } catch (err) {
        console.error('\n❌ VERIFICATION FAILED');
        console.error('Error:', err.message);
        if (err.response) {
            console.error('API Response:', JSON.stringify(err.response.data));
        }
        process.exit(1);
    }
    console.log('\n' + '='.repeat(60));
}

runVerification();
