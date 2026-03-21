require('dotenv').config();
const sheetsService = require('./src/services/sheets');

async function testSheet() {
    console.log('='.repeat(60));
    console.log('Google Sheets Test');
    console.log('='.repeat(60));
    
    // Step 1: Initialize sheet
    console.log('\n[Step 1] Initializing sheet headers...');
    try {
        await sheetsService.initializeSheet();
    } catch (err) {
        console.error('❌ Initialization failed:', err.message);
        throw err;
    }
    
    // Step 2: Test write
    console.log('\n[Step 2] Running test write...');
    try {
        await sheetsService.testWrite();
        console.log('\n✅ All tests passed!');
    } catch (err) {
        console.error('\n❌ Test write failed:', err.message);
        throw err;
    }
    
    console.log('\n' + '='.repeat(60));
}

testSheet().catch(err => {
    console.error('\n' + '='.repeat(60));
    console.error('TEST FAILED');
    console.error('='.repeat(60));
    console.error('Full error:', err);
    process.exit(1);
});
