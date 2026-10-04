const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const config = {
    // Bot configuration
    botToken: process.env.BOT_TOKEN,
    
    // Admin configuration
    adminId: parseInt(process.env.ADMIN_IDS) || null,
    
    // Database configuration. The production compose mounts a named volume at
    // /app/data and points BOT_SQLITE_PATH at it, so the bot's SQLite file
    // survives container recreation; without this read the path would resolve
    // inside the container and the database would be lost on every deploy.
    // The fallback is the original in-image path, so hosts that do not set the
    // variable are unaffected.
    databasePath: process.env.BOT_SQLITE_PATH || './database.sqlite',
    
    // Release visibility for the Telegram cash-compensation entry. Exactly the
    // string "true" releases it; absent, empty, "false", a mistyped value or any
    // other value keeps it hidden, so a deploy that forgets the variable fails
    // closed rather than exposing the pilot.
    //
    // This answers one question only: is the entry released? It never decides
    // whether a driver may compensate - eligibility, park authority, catalogue
    // state, budget and order freshness all stay with the CRM, which refuses
    // independently. The flag can therefore only ever hide, never grant.
    compensationEntryEnabled: process.env.BOT_COMPENSATION_ENTRY_ENABLED === 'true',

    // Bot settings
    botName: 'SurveyBot',
    
    // Validate configuration
    validate() {
        if (!this.botToken) {
            throw new Error('BOT_TOKEN is required in .env file');
        }
        if (!this.adminId) {
            console.warn('Warning: ADMIN_IDS not set in .env file');
        }
    }
};

module.exports = config;
