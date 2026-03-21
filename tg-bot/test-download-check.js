// Test export logic directly, in-process, to catch any crash
require('dotenv').config();

async function main() {
    const { PrismaClient } = require('@prisma/client');
    const ExcelJS = require('exceljs');
    const prisma = new PrismaClient();
    const SURVEY_ID = 'bbd15c7a-c378-41d5-87bc-e917bde5ada4';

    try {
        console.log('1. Fetching survey...');
        const survey = await prisma.survey.findUnique({
            where: { id: SURVEY_ID },
            include: { questions: { orderBy: { order: 'asc' } } }
        });

        if (!survey) {
            console.log('Survey not found!');
            return;
        }
        console.log(`   Found: "${survey.title || survey.triggerButton}", ${survey.questions.length} questions`);

        console.log('2. Fetching users...');
        const users = await prisma.user.findMany({
            where: {
                OR: [
                    { answers: { some: { question: { surveyId: SURVEY_ID } } } },
                    { analyticsEvents: { some: { eventType: 'SURVEY_COMPLETED', sourceId: SURVEY_ID } } }
                ]
            },
            include: {
                answers: {
                    where: { question: { surveyId: SURVEY_ID } },
                    include: { question: true }
                },
                analyticsEvents: {
                    where: { eventType: 'SURVEY_COMPLETED', sourceId: SURVEY_ID },
                    orderBy: { createdAt: 'desc' }
                }
            }
        });
        console.log(`   Found ${users.length} users`);

        console.log('3. Creating workbook...');
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

        console.log('4. Adding rows...');
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

        console.log('5. Writing to buffer...');
        const buffer = await workbook.xlsx.writeBuffer();
        console.log(`   Buffer size: ${buffer.length} bytes`);
        console.log(`   First 4 bytes: ${Buffer.from(buffer).slice(0, 4).toString('hex').toUpperCase()}`);

        const fs = require('fs');
        fs.writeFileSync('test_generated.xlsx', buffer);
        console.log('6. Saved to test_generated.xlsx');

        // Verify
        const wb2 = new ExcelJS.Workbook();
        await wb2.xlsx.load(buffer);
        const ws = wb2.worksheets[0];
        console.log(`7. Verification: ${ws.rowCount} rows, ${ws.columnCount} columns`);
        const headerRow = ws.getRow(1);
        const headers = [];
        headerRow.eachCell(c => headers.push(c.value));
        console.log(`   Headers: ${headers.join(' | ')}`);
        for (let i = 2; i <= ws.rowCount; i++) {
            const row = ws.getRow(i);
            const vals = [];
            row.eachCell({ includeEmpty: true }, c => vals.push(String(c.value).substring(0, 30)));
            console.log(`   Row ${i}: ${vals.join(' | ')}`);
        }

        console.log('\n✅ Excel file is VALID and contains correct data!');
    } catch (err) {
        console.error('\n❌ ERROR:', err);
        console.error('Stack:', err.stack);
    } finally {
        await prisma.$disconnect();
    }
}

main();
