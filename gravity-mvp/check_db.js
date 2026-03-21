const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fs = require('fs');

async function main() {
    const msgs = await prisma.message.findMany({ take: 10, orderBy: { createdAt: 'desc' } });
    fs.writeFileSync('db_out.json', JSON.stringify(msgs, null, 2));
    console.log('done');
}
main().finally(() => prisma.$disconnect());
