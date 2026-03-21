const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log('--- ANSWERS FOR USER 8505573537 ---');

    // Find internal User ID for telegramId 8505573537
    const users = await prisma.user.findMany({
        where: { telegramId: 8505573537n }
    });

    for (const u of users) {
        console.log(`\nUser DB ID: ${u.id} | Bot: ${u.botId} | Telegram: ${u.telegramId}`);
        const answers = await prisma.answer.findMany({
            where: { userId: u.id },
            include: { question: { include: { survey: true } } }
        });
        answers.forEach(a => {
            console.log(`   Survey: ${a.question.survey?.title} [${a.question.survey?.id}]`);
            console.log(`   Q: ${a.question.text}`);
            console.log(`   A: ${a.value}`);
        });
    }

}

main().then(() => process.exit(0));
