const fs = require('fs');
const originalError = console.error;
const originalLog = console.log;
console.error = function (...args) {
    fs.appendFileSync('bot-errors.log', new Date().toISOString() + ' ERROR ' + args.map(a => typeof a === 'object' ? (a.stack || JSON.stringify(a)) : a).join(' ') + '\n');
    originalError.apply(console, args);
};
console.log = function (...args) {
    fs.appendFileSync('bot-errors.log', new Date().toISOString() + ' LOG ' + args.map(a => typeof a === 'object' ? (a.stack || JSON.stringify(a)) : a).join(' ') + '\n');
    originalLog.apply(console, args);
};
