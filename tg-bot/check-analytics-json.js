const express = require('express');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Inline replication of the API logic to see the literal JSON output
async function testEndpoint() {
    BigInt.prototype.toJSON = function () { return this.toString() };
    const id = 'bbd15c7a-c378-41d5-87bc-e917bde5ada4';

    const totalUsers = await prisma.user.count({
        where: { answers: { some: { question: { surveyId: id } } } }
    });

    const completedUsers = await prisma.user.count({
        where: { status: 'COMPLETED', answers: { some: { question: { surveyId: id } } } }
    });

    const completionRate = totalUsers > 0 ? ((completedUsers / totalUsers) * 100).toFixed(2) + '%' : '0%';

    const buttonClicksRaw = await prisma.answer.groupBy({
        by: ['value'],
        where: { question: { surveyId: id, isConversion: true } },
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

    const body = { totalUsers, completedUsers, completionRate, conversions };
    console.log(JSON.stringify(body, null, 2));

    // Also test users endpoint
    const users = await prisma.user.findMany({
        where: { answers: { some: { question: { surveyId: id } } } },
        include: { answers: { include: { question: true } } },
        orderBy: { createdAt: 'desc' }
    });

    // Test manual JSON stringify for the users object 
    const safeUsers = users.map(u => ({ ...u, telegramId: u.telegramId ? u.telegramId.toString() : null }));
    console.log(`Users fetched: ${safeUsers.length}`);
}

testEndpoint().then(() => process.exit(0));
