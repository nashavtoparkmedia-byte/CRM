const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const config = {
    // Bot configuration
    botToken: process.env.BOT_TOKEN,
    
    // Admin configuration
    adminId: parseInt(process.env.ADMIN_IDS) || null,
    
    // Database configuration
    databasePath: './database.sqlite',
    
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
