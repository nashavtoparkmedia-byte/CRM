// Start ONLY the API server (no bot) for testing
require('dotenv').config();
const { startServer } = require('./src/app.js');
startServer();
console.log('API-only mode (no bot)');
