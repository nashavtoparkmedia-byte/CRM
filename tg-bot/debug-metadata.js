const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log('--- Checking Analytics Events ---');
    const events = await prisma.analyticsEvent.findMany({
        where: { eventType: 'SURVEY_COMPLETED' },
        orderBy: { createdAt: 'desc' },
        take: 20
    });

    console.log(`Total "SURVEY_COMPLETED" events found (last 20): ${events.length}`);

    events.forEach((ev, i) => {
        console.log(`[${i}] ID: ${ev.id}, User: ${ev.userId}, SurveyID(sourceId): ${ev.sourceId}, Created: ${ev.createdAt}, HasMetadata: ${!!ev.metadata}`);
        if (ev.metadata) {
            console.log(`    Metadata Sample: ${JSON.stringify(ev.metadata).substring(0, 100)}...`);
        }
    });
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
