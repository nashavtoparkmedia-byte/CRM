const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const s1 = await prisma.survey.findUnique({
        where: { id: 'f43f7a88-45c8-4665-95ff-8eb0df8763f1' },
        include: { questions: true }
    });
    console.log(JSON.stringify(s1, null, 2));

    const s2 = await prisma.survey.findUnique({
        where: { id: 'bbd15c7a-c378-41d5-87bc-e917bde5ada4' },
        include: { questions: true }
    });
    console.log(JSON.stringify(s2, null, 2));
}

main().then(() => process.exit(0));
