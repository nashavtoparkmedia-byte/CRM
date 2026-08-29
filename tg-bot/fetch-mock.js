const axios = require('axios');

const API_BASE = 'http://localhost:3001/api/admin';
const api = axios.create({
    baseURL: API_BASE,
    headers: { 'Content-Type': 'application/json' }
});

async function run() {
    // Diagnostic requests must use explicit ADMIN_USER/ADMIN_PASS values and
    // send them in an Authorization header. No bypass or query-token lane exists.
}
run();
