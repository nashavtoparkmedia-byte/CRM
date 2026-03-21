const { PrismaClient } = require('@prisma/client');
const http = require('http');

const prisma = new PrismaClient();
const surveyId = 'bbd15c7a-c378-41d5-87bc-e917bde5ada4';

async function diagnose() {
    console.log('--- 1. Checking Database Directly ---');
    const users = await prisma.user.findMany({
        where: {
            answers: { some: { question: { surveyId: surveyId } } }
        },
        include: {
            analyticsEvents: {
                where: { eventType: 'SURVEY_COMPLETED', sourceId: surveyId },
                orderBy: { createdAt: 'desc' }
            }
        }
    });

    console.log(`Users found for survey ${surveyId}: ${users.length}`);
    users.forEach(u => {
        console.log(`User ${u.firstName} (${u.id}): ${u.analyticsEvents.length} completions in history.`);
    });

    console.log('\n--- 2. Checking API Response (Internal call) ---');
    // We'll simulate what the API does
    const apiResult = users.map(u => ({
        id: u.id,
        firstName: u.firstName,
        surveyHistory: u.analyticsEvents || []
    }));

    if (apiResult.length > 0) {
        console.log('Sample API object surveyHistory length:', apiResult[0].surveyHistory.length);
        console.log('Sample metadata keys:', apiResult[0].surveyHistory[0]?.metadata ? Object.keys(apiResult[0].surveyHistory[0].metadata) : 'NONE');
    }

    console.log('\n--- 3. Testing Local Connection to Port 3001 ---');
    const checkPort = (host) => {
        return new Promise((resolve) => {
            const req = http.get({ host, port: 3001, path: '/api/admin/bots' }, (res) => {
                console.log(`Successfully connected to ${host}:3001 (Status: ${res.statusCode})`);
                resolve(true);
            });
            req.on('error', (e) => {
                console.log(`Failed to connect to ${host}:3001: ${e.message}`);
                resolve(false);
            });
            req.end();
        });
    };

    await checkPort('127.0.0.1');
    await checkPort('localhost');
}

diagnose()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
