const fs = require('fs');
const html = fs.readFileSync('max_dom_dump.txt', 'utf8');
console.log('File length:', html.length);

const idx = html.indexOf('Ремезов');
if (idx !== -1) {
    console.log('FOUND:', html.substring(Math.max(0, idx - 300), idx + 300));
} else {
    console.log('Ремезов not found. Dumping first 500 chars:', html.substring(0, 500));
}
