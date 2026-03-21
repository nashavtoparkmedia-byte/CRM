const { PrismaClient } = require('@prisma/client');
const req = { prisma: new PrismaClient() };

async function getAnalytics(id) {
    // Total Users: have at least one answer to this survey
    const totalUsers = await req.prisma.user.count({
        where: {
            answers: { some: { question: { surveyId: id } } }
        }
    });

    // Completed Users: have at least one answer to this survey AND status is COMPLETED
    const completedUsers = await req.prisma.user.count({
        where: {
            status: 'COMPLETED',
            answers: { some: { question: { surveyId: id } } }
        }
    });

    const completionRate = totalUsers > 0 ? ((completedUsers / totalUsers) * 100).toFixed(2) + '%' : '0%';

    const buttonClicksRaw = await req.prisma.answer.groupBy({
        by: ['value'],
        where: {
            question: {
                surveyId: id,
                isConversion: true
            }
        },
        _count: { id: true }
    });

    const conversions = buttonClicksRaw.map(bc => {
        let percentage = 0;
        if (completedUsers > 0) {
            percentage = ((bc._count.id / completedUsers) * 100).toFixed(2);
        }
        return {
            button_name: bc.value,
            click_count: bc._count.id,
            percentage_of_completed: percentage + '%'
        };
    });

    return { totalUsers, completedUsers, completionRate, conversions };
}

async function main() {
    const id = 'bbd15c7a-c378-41d5-87bc-e917bde5ada4';
    console.log(await getAnalytics(id));
}

main().then(() => process.exit(0));
