const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const surveys = await prisma.survey.findMany({
        include: { questions: true }
    });

    console.log('--- Surveys and Questions ---');
    surveys.forEach(s => {
        console.log(`Survey: ${s.title} (${s.id})`);
        s.questions.forEach(q => {
            console.log(`  - Question: ${q.text} (${q.id})`);
        });
    });

    // Check one user's history
    const userId = 'af194939-fb9e-4600-945e-e6922ebe6391';
    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
            analyticsEvents: {
                where: { eventType: 'SURVEY_COMPLETED' },
                orderBy: { createdAt: 'desc' }
            }
        }
    });

    if (user) {
        console.log(`\n--- History for user ${user.firstName} ---`);
        user.analyticsEvents.forEach((ev, i) => {
            console.log(`Attempt ${i}: sourceId=${ev.sourceId}, HasMeta=${!!ev.metadata}`);
            if (ev.metadata) {
                console.log(`  Meta Keys: ${Object.keys(ev.metadata)}`);
            }
        });
    }
}

main().finally(() => prisma.$disconnect());
