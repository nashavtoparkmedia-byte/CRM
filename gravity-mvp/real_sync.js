require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runRealSync() {
    try {
        const { YandexFleetService } = require('./src/lib/YandexFleetService.ts');
        
        // Let's run the exact logic of YandexFleetService manually but with ts-node
    } catch(e) {
        console.error(e);
    }
}
