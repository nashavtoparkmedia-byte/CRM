/**
 * Startup script for Telegram Survey Bot
 * Ensures correct working directory before launching bot
 */

const path = require('path');

// Define the target working directory (optional, can be current dir)
const TARGET_DIR = process.cwd();

console.log('========================================');
console.log('STARTUP SCRIPT');
console.log('========================================');
console.log('Working directory:', TARGET_DIR);

// We verify the existence of src/bot.js to ensure we are in the right place
const fs = require('fs');
if (!fs.existsSync(path.join(TARGET_DIR, 'src', 'bot.js'))) {
    console.error('ERROR: Could not find src/bot.js in the current directory.');
    console.error('Please run this script from the project root.');
    process.exit(1);
}

console.log('========================================');

// Load environment variables BEFORE loading any other modules
require('dotenv').config();
console.log('Environment variables loaded from .env');

// Now require and run the main bot from src/
require('./src/bot.js');

// Start the backend API server
const { startServer } = require('./src/app.js');
startServer();
