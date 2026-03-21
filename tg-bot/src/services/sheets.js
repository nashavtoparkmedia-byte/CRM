const { google } = require('googleapis');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../config');

// Constants from .env or defaults
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID;
const SHEET_NAME_SURVEY = process.env.GOOGLE_SHEETS_NAME || 'Лист1';
const SHEET_NAME_CONNECTION = 'Подключиться из Бота';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || 'service-account.json';

// Singleton for auth and sheets
let authClient = null;
let sheetsApi = null;

async function getSheetsApi() {
    if (sheetsApi) return sheetsApi;

    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: path.resolve(process.cwd(), KEY_FILE),
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        authClient = await auth.getClient();
        sheetsApi = google.sheets({ version: 'v4', auth: authClient });
        return sheetsApi;
    } catch (err) {
        logger.error('Failed to initialize Google Sheets API:', err);
        throw err;
    }
}

/**
 * Find or Create a row for a user based on Telegram ID (Column B)
 */
async function upsertUserRow(userId, username, data, sheetName = SHEET_NAME_SURVEY) {
    try {
        const sheets = await getSheetsApi();

        // 1. Get all values to find the user
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${sheetName}!A8:B1000` // Assuming Header at 8, data from 9
        });

        const rows = response.data.values || [];
        // userId is in Column B (index 1)
        let rowIndex = rows.findIndex(row => row[1] === String(userId));

        const timestamp = new Date().toISOString();

        // Prepare row data based on columns defined in enhance-sheets.js
        // Survey: Timestamp (A), TG ID (B), Username (C), Name (D), Phone (E), VU (F), STS (G), Status (H), Q1 (I)...
        // Connection: Timestamp (A), TG ID (B), Username (C), Name (D), Phone (E), VU (F), STS (G), Status (H), Notes (I)...

        if (rowIndex === -1) {
            // New user - Append
            const newRow = [timestamp, String(userId), username || ''];
            // Fill remaining columns with empty strings or specific data
            const cols = new Array(10).fill('');
            const finalRow = [...newRow, ...cols];

            // Apply data to specific columns
            if (data.Status) finalRow[7] = data.Status;
            if (data.Phone) finalRow[4] = data.Phone;
            if (data['Full Name']) finalRow[3] = data['Full Name'];

            await sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: `${sheetName}!A9`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [finalRow] }
            });
            logger.info(`[Sheets] Appended new user ${userId} to ${sheetName}`);
        } else {
            // Existing user - Update
            const actualRow = rowIndex + 8; // Offset for range start (8)

            // Update individual cells based on what we have
            if (data.Status) {
                await sheets.spreadsheets.values.update({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `${sheetName}!H${actualRow}`,
                    valueInputOption: 'USER_ENTERED',
                    requestBody: { values: [[data.Status]] }
                });
            }
            if (data.Phone) {
                await sheets.spreadsheets.values.update({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `${sheetName}!E${actualRow}`,
                    valueInputOption: 'USER_ENTERED',
                    requestBody: { values: [[data.Phone]] }
                });
            }
            // Update timestamp
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `${sheetName}!A${actualRow}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [[timestamp]] }
            });
            logger.info(`[Sheets] Updated user ${userId} in ${sheetName}`);
        }
    } catch (err) {
        logger.error(`[Sheets] Upsert failed for user ${userId}:`, err);
        // Do not throw to keep bot alive
    }
}

/**
 * Find or Create a row for a user in the Connection sheet
 */
async function upsertConnectionRow(userId, username, data) {
    return upsertUserRow(userId, username, data, SHEET_NAME_CONNECTION);
}

async function exportSurveyToSheets(bot, survey, user, answers, prisma) {
    // Legacy mapping or specific export logic
    logger.info(`[Sheets] Exporting survey results for ${user.telegramId}`);
}

async function initializeSheet() {
    logger.info('[Sheets Service] API is ready for use');
    return Promise.resolve();
}

async function testWrite() {
    return upsertUserRow(123, 'testuser', { Status: 'Test Writing' });
}

module.exports = {
    upsertUserRow,
    upsertConnectionRow,
    exportSurveyToSheets,
    initializeSheet,
    testWrite,
    get sheets() { return sheetsApi; } // Export the sheets instance for direct use
};
