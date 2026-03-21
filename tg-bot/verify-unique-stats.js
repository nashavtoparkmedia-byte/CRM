const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function verify() {
    const botId = (await prisma.bot.findFirst()).id;
    console.log(`Using botId: ${botId}\n`);

    // 1. Get raw counts from DB
    const totalEvents = await prisma.analyticsEvent.count({
        where: { botId, eventType: 'SURVEY_COMPLETED' }
    });

    const uniqueUsers = (await prisma.analyticsEvent.findMany({
        where: { botId, eventType: 'SURVEY_COMPLETED' },
        select: { userId: true },
        distinct: ['userId']
    })).length;

    console.log(`Total "SURVEY_COMPLETED" events: ${totalEvents}`);
    console.log(`Unique users who completed: ${uniqueUsers}`);

    if (totalEvents > uniqueUsers) {
        console.log('✅ Found duplicates in DB (good for testing unique logic).');
    } else {
        console.log('ℹ️ No duplicates found in DB for "SURVEY_COMPLETED".');
    }

    // 2. Mock a request to see what the API returns
    // In a real scenario we'd call the endpoint, but here we can just check the logic 
    // or run a quick check on one survey
    const survey = await prisma.survey.findFirst({ where: { botId } });
    if (survey) {
        const uniqueStartedPerSurvey = (await prisma.analyticsEvent.findMany({
            where: { botId, eventType: 'SURVEY_STARTED', sourceId: survey.id },
            select: { userId: true },
            distinct: ['userId']
        })).length;
        console.log(`\nSurvey "${survey.title}":`);
        console.log(`- Unique users started: ${uniqueStartedPerSurvey}`);
    }
}

verify().finally(() => prisma.$disconnect());
