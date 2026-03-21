const { google } = require('googleapis');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID;
const SHEET_NAME_SURVEY = process.env.GOOGLE_SHEETS_NAME || 'Лист1';
const SHEET_NAME_CONNECTION = 'Подключиться из Бота';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || 'service-account.json';

const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth: auth });

async function enhanceSheets() {
    try {
        console.log('Fetching spreadsheet metadata...');
        const spreadsheet = await sheets.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID
        });

        const surveySheet = spreadsheet.data.sheets.find(s => s.properties.title === SHEET_NAME_SURVEY);
        const connectionSheet = spreadsheet.data.sheets.find(s => s.properties.title === SHEET_NAME_CONNECTION);

        if (!surveySheet || !connectionSheet) {
            console.error('Available sheets:', spreadsheet.data.sheets.map(s => s.properties.title));
            throw new Error('Required sheets not found');
        }

        const surveySheetId = surveySheet.properties.sheetId;
        const connectionSheetId = connectionSheet.properties.sheetId;

        console.log(`Enhancing Survey Sheet (${SHEET_NAME_SURVEY})...`);
        await applyEnhancements(surveySheetId, SHEET_NAME_SURVEY);

        console.log(`Enhancing Connection Sheet (${SHEET_NAME_CONNECTION})...`);
        await applyEnhancements(connectionSheetId, SHEET_NAME_CONNECTION);

        console.log('✅ Dashboard enhancement completed!');
    } catch (err) {
        console.error('❌ Error enhancing sheets:', err.message);
    }
}

async function applyEnhancements(sheetId, title) {
    console.log(`Step 1: Inserting summary rows at the top of ${title}...`);
    // Insert 6 rows at the top for Summary
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
            requests: [
                {
                    insertDimension: {
                        range: {
                            sheetId: sheetId,
                            dimension: 'ROWS',
                            startIndex: 0,
                            endIndex: 7
                        },
                        inheritFromBefore: false
                    }
                }
            ]
        }
    });

    console.log(`Step 2: Adding Summary Formulas and Header Emojis for ${title}...`);
    const isSurvey = title === SHEET_NAME_SURVEY;

    // Headers with Emojis
    const headers = isSurvey
        ? [['📅 UTC Timestamp', '🆔 Telegram ID', '👤 Username', '📝 Full Name', '📞 Phone', '🆔 VU', '🆔 STS', '📊 Status', '❓ Q1', '❓ Q2', '❓ Q3', '❓ Q4']]
        : [['📅 UTC Timestamp', '🆔 Telegram ID', '👤 Username', '📝 Full Name', '📞 Phone Number', '🆔 VU Link', '🆔 STS Link', '⏳ Status', '📝 Notes', '👮 Admin ID', '🔗 Chat Link']];

    const summaryData = [
        [`📊 SUMMARY: ${title.toUpperCase()}`],
        ['👥 Total Users:', `=COUNTA(B9:B1000)`],
        ['✅ Completed:', isSurvey ? `=COUNTIF(H9:H1000, "Completed Survey")` : `=COUNTIF(H9:H1000, "Accepted")`],
        ['⏳ In Progress:', isSurvey ? `=COUNTIF(H9:H1000, "Started Survey")` : `=COUNTIF(H9:H1000, "Connection Requested")`],
        ['🆕 New Today:', `=COUNTIFS(A9:A1000, ">=" & TODAY())`],
        [''] // Spacer
    ];

    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${title}!A1:B8`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: summaryData }
    });

    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${title}!A8`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: headers }
    });

    console.log(`Step 3: Applying Styling and Conditional Formatting for ${title}...`);
    const requests = [
        // Freeze first 8 rows (Summary + Header)
        {
            updateSheetProperties: {
                properties: {
                    sheetId: sheetId,
                    gridProperties: {
                        frozenRowCount: 8,
                        frozenColumnCount: 2
                    }
                },
                fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount'
            }
        },
        // Format Header Row (8th row)
        {
            repeatCell: {
                range: { sheetId: sheetId, startRowIndex: 7, endRowIndex: 8 },
                cell: {
                    userEnteredFormat: {
                        backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 },
                        textFormat: { bold: true, fontSize: 10, foregroundColor: { red: 1, green: 1, blue: 1 } },
                        horizontalAlignment: 'CENTER'
                    }
                },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
            }
        },
        // Alternating Row Colors (from 9th row)
        {
            addBanding: {
                bandingProperties: {
                    range: { sheetId: sheetId, startRowIndex: 8, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 12 },
                    rowProperties: {
                        headerColor: { red: 0.4, green: 0.4, blue: 0.4 },
                        firstBandColor: { red: 1, green: 1, blue: 1 },
                        secondBandColor: { red: 0.94, green: 0.96, blue: 0.98 }
                    }
                }
            }
        },
        // Summary Block Styling (1st row)
        {
            repeatCell: {
                range: { sheetId: sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 },
                cell: {
                    userEnteredFormat: {
                        backgroundColor: { red: 0.1, green: 0.4, blue: 0.7 },
                        textFormat: { bold: true, fontSize: 14, foregroundColor: { red: 1, green: 1, blue: 1 } }
                    }
                },
                fields: 'userEnteredFormat(backgroundColor,textFormat)'
            }
        },
        // Borders for all cells
        {
            updateBorders: {
                range: { sheetId: sheetId, startRowIndex: 7, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 12 },
                top: { style: 'SOLID', width: 1 },
                bottom: { style: 'SOLID', width: 1 },
                left: { style: 'SOLID', width: 1 },
                right: { style: 'SOLID', width: 1 },
                innerHorizontal: { style: 'SOLID', width: 1 },
                innerVertical: { style: 'SOLID', width: 1 }
            }
        },
        // Conditional Formatting (Status column is H = index 7)
        {
            addConditionalFormatRule: {
                rule: {
                    ranges: [{ sheetId: sheetId, startColumnIndex: 7, endColumnIndex: 8, startRowIndex: 8 }],
                    booleanRule: {
                        condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: isSurvey ? 'Opened' : 'New' }] },
                        format: { backgroundColor: { red: 1, green: 1, blue: 0.8 } }
                    }
                }, index: 0
            }
        },
        {
            addConditionalFormatRule: {
                rule: {
                    ranges: [{ sheetId: sheetId, startColumnIndex: 7, endColumnIndex: 8, startRowIndex: 8 }],
                    booleanRule: {
                        condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: isSurvey ? 'Started Survey' : 'Connection Requested' }] },
                        format: { backgroundColor: { red: 0.8, green: 0.9, blue: 1 } }
                    }
                }, index: 1
            }
        },
        {
            addConditionalFormatRule: {
                rule: {
                    ranges: [{ sheetId: sheetId, startColumnIndex: 7, endColumnIndex: 8, startRowIndex: 8 }],
                    booleanRule: {
                        condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: isSurvey ? 'Completed Survey' : 'Accepted' }] },
                        format: { backgroundColor: { red: 0.8, green: 1, blue: 0.8 } }
                    }
                }, index: 2
            }
        },
        // Step 4: Add Pivot Table for Status (on a new sheet if needed, but here we can add to the right)
        {
            updateCells: {
                range: { sheetId: sheetId, startRowIndex: 1, endRowIndex: 7, startColumnIndex: 4, endColumnIndex: 5 },
                rows: [{
                    values: [{
                        pivotTable: {
                            source: { sheetId: sheetId, startRowIndex: 7, endRowIndex: 1000, startColumnIndex: 1, endColumnIndex: 8 },
                            rows: [{ sourceColumnOffset: 6, sortOrder: 'ASCENDING', showTotals: true }],
                            values: [{ summarizeFunction: 'COUNT', sourceColumnOffset: 6 }]
                        }
                    }]
                }],
                fields: 'pivotTable'
            }
        },
        // Step 5: Add Chart for Status Distribution
        {
            addChart: {
                chart: {
                    spec: {
                        title: `Status Distribution (${title})`,
                        basicChart: {
                            chartType: 'COLUMN',
                            legendPosition: 'BOTTOM_LEGEND',
                            axis: [{ position: 'BOTTOM_AXIS', title: 'Status' }, { position: 'LEFT_AXIS', title: 'Count' }],
                            series: [{
                                series: { sourceRange: { sources: [{ sheetId: sheetId, startRowIndex: 1, endRowIndex: 6, startColumnIndex: 4, endColumnIndex: 5 }] } }
                            }]
                        }
                    },
                    position: {
                        overlayPosition: {
                            anchorCell: { sheetId: sheetId, rowIndex: 1, columnIndex: 6 },
                            offsetXPixels: 0,
                            offsetYPixels: 0
                        }
                    }
                }
            }
        }
    ];

    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests }
    });
}


enhanceSheets();
