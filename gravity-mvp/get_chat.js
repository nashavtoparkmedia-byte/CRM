const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
    const fs = require('fs');
    fs.writeFileSync('chats_out.txt', JSON.stringify(chats, null, 2));
    console.log("Wrote chats to chats_out.txt");
    await prisma.$disconnect();
}

run();
