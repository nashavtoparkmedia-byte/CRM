
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const ExcelJS = require('exceljs');
const fs = require('fs');

async function testExport() {
    // Correct survey ID from DB list
    const id = 'bbd15c7a-c378-41d5-87bc-e917bde5ada4';
    console.log(`Testing export for survey: ${id}`);

    try {
        // 1. Fetch survey
        const survey = await prisma.survey.findUnique({
            where: { id },
            include: { questions: { orderBy: { order: 'asc' } } }
        });

        if (!survey) {
            console.error('Survey not found');
            return;
        }

        console.log(`Found survey: ${survey.triggerButton}`);

        // 2. Fetch users
        const users = await prisma.user.findMany({
            where: {
                OR: [
                    { answers: { some: { question: { surveyId: id } } } },
                    { analyticsEvents: { some: { eventType: 'SURVEY_COMPLETED', sourceId: id } } }
                ]
            },
            include: {
                answers: {
                    where: { question: { surveyId: id } },
                    include: { question: true }
                },
                analyticsEvents: {
                    where: { eventType: 'SURVEY_COMPLETED', sourceId: id },
                    orderBy: { createdAt: 'desc' }
                }
            }
        });

        console.log(`Found ${users.length} users`);

        // 3. Create Workbook
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Ответы');

        const columns = [
            { header: 'Имя', key: 'firstName', width: 25 },
            { header: 'Username', key: 'username', width: 25 },
            { header: 'Дата завершения', key: 'completionDate', width: 25 }
        ];

        survey.questions.forEach(q => {
            columns.push({ header: q.text, key: `q_${q.id}`, width: 40 });
        });

        worksheet.columns = columns;

        users.forEach(user => {
            const userAnswersMap = {};
            user.answers.forEach(ans => { userAnswersMap[ans.questionId] = ans.value; });

            const latestHistory = user.analyticsEvents && user.analyticsEvents.length > 0 ? user.analyticsEvents[0] : null;
            if (user.answers.length === 0 && latestHistory && latestHistory.metadata) {
                try {
                    const meta = typeof latestHistory.metadata === 'string' ? JSON.parse(latestHistory.metadata) : latestHistory.metadata;
                    Object.keys(meta).forEach(qId => { userAnswersMap[qId] = meta[qId]; });
                } catch (e) { }
            }

            const rowData = {
                firstName: user.firstName || '-',
                username: user.username ? `@${user.username}` : '-',
                completionDate: (latestHistory ? new Date(latestHistory.createdAt) : new Date(user.createdAt)).toLocaleString('ru-RU')
            };

            survey.questions.forEach(q => {
                rowData[`q_${q.id}`] = userAnswersMap[q.id] || '-';
            });

            worksheet.addRow(rowData);
        });

        await workbook.xlsx.writeFile('test_export_result.xlsx');
        console.log('✅ Success! Export written to test_export_result.xlsx');

        const stats = fs.statSync('test_export_result.xlsx');
        console.log(`File size: ${stats.size} bytes`);

    } catch (err) {
        console.error('❌ Export failed:', err);
    } finally {
        await prisma.$disconnect();
    }
}

testExport();
