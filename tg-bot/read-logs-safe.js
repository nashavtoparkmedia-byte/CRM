const fs = require('fs');
require('dotenv').config();
const { redactText, sanitizeLogValue } = require('./src/security/redactSecrets');
try {
    const txt = fs.readFileSync('error.log', 'utf16le');
    console.log("=== ERROR.LOG LAST 30 LINES ===");
    console.log(redactText(txt.split('\n').map(l => l.trim()).filter(Boolean).slice(-30).join('\n')));
} catch (e) { console.log('error.log unreadable'); }
try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    prisma.bot.findMany({ select: { id: true, name: true, username: true, isActive: true } }).then(d => {
        console.log("=== BOTS IN DB ===", d);
        prisma.$disconnect();
    }).catch(e => console.error("Prisma error:", sanitizeLogValue(e)));
} catch (e) { }
