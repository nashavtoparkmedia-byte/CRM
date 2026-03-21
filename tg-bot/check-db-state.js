const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log('--- SURVEYS ---');
    const surveys = await prisma.survey.findMany({
        include: { _count: { select: { questions: true } } }
    });
    surveys.forEach(s => {
        console.log(`ID: ${s.id} | Title: ${s.title} | Trigger: [${s.triggerButton}] | Active: ${s.isActive} | Questions: ${s._count.questions}`);
    });

    console.log('\n--- LATEST ANSWERS ---');
    const recentAnswers = await prisma.answer.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: { question: { select: { text: true, surveyId: true } } }
    });
    recentAnswers.forEach(a => {
        console.log(`User: ${a.userId} | Survey: ${a.question.surveyId} | Value: ${a.value} | Q: ${a.question.text}`);
    });

    console.log('\n--- USERS WITH ANSWERS ---');
    const usersWithAnswers = await prisma.user.findMany({
        where: { answers: { some: {} } },
        include: { _count: { select: { answers: true } } }
    });
    usersWithAnswers.forEach(u => {
        console.log(`User: ${u.telegramId} | Status: ${u.status} | Answers: ${u._count.answers}`);
    });

    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
