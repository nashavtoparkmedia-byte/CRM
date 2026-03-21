const express = require('express');
const router = express.Router();

// GET all surveys for the Surveys list page (1:N architecture)
router.get('/surveys', async (req, res, next) => {
    try {
        const surveys = await req.prisma.survey.findMany({
            include: { bot: true },
            orderBy: { id: 'desc' }
        });

        const stats = await Promise.all(surveys.map(async (survey) => {
            // How many users have engaged with THIS specific survey
            // Note: Currently, Answer table links userId -> questionId. 
            // We can approximate users who took THIS survey by counting unique Answer userIds linked to questions of THIS survey.
            // A more exact count requires Prisma aggregate, but for now we query unique users who answered its questions.

            const totalUsersQuery = await req.prisma.analyticsEvent.findMany({
                where: { eventType: 'SURVEY_STARTED', sourceId: survey.id },
                select: { userId: true },
                distinct: ['userId']
            });
            const totalUsers = totalUsersQuery.length;

            const completedUsersQuery = await req.prisma.analyticsEvent.findMany({
                where: { eventType: 'SURVEY_COMPLETED', sourceId: survey.id },
                select: { userId: true },
                distinct: ['userId']
            });
            const completedUsers = completedUsersQuery.length;
            const completionRate = totalUsers > 0 ? ((completedUsers / totalUsers) * 100).toFixed(0) + '%' : '0%';

            return {
                id: survey.id,
                botId: survey.botId,
                botName: survey.bot ? survey.bot.name : 'Unknown Bot',
                title: survey.title,
                triggerButton: survey.triggerButton,
                isActive: survey.isActive,
                createdAt: survey.createdAt,
                archivedAt: survey.archivedAt,
                totalUsers,
                completedUsers,
                completionRate
            };
        }));

        const safeStats = stats.map(s => ({
            ...s,
            // Ensure any stray BigInt IDs (from relation or user) are stringified
            id: s.id,
            botId: s.botId ? s.botId.toString() : null
        }));

        res.json(safeStats);
    } catch (error) {
        next(error);
    }
});

// GET survey and its questions by surveyId
router.get('/surveys/:surveyId', async (req, res, next) => {
    try {
        const { surveyId } = req.params;
        const survey = await req.prisma.survey.findUnique({
            where: { id: surveyId },
            include: {
                questions: {
                    orderBy: { order: 'asc' }
                }
            }
        });

        if (!survey) return res.status(404).json({ error: 'Survey not found' });

        res.json(survey);
    } catch (error) {
        next(error);
    }
});

// POST create new survey
router.post('/surveys', async (req, res, next) => {
    try {
        const { botId, title, triggerButton, isLinear } = req.body;

        if (!botId) return res.status(400).json({ error: 'botId is required' });

        const newSurvey = await req.prisma.survey.create({
            data: {
                botId,
                title: title || 'Новый опрос',
                triggerButton: triggerButton || '📊 Опрос качества',
                isActive: true,
                isLinear: isLinear !== undefined ? isLinear : true
            }
        });

        res.status(201).json(newSurvey);
    } catch (error) {
        next(error);
    }
});

// PUT update survey settings
router.put('/surveys/:surveyId', async (req, res, next) => {
    try {
        const { surveyId } = req.params;
        const { title, triggerButton, isActive, googleSheetId, syncMode, isLinear, archivedAt } = req.body;

        const updateData = { title, triggerButton, isActive, googleSheetId, syncMode, isLinear };
        if (archivedAt !== undefined) {
            updateData.archivedAt = archivedAt;
        }

        const survey = await req.prisma.survey.update({
            where: { id: surveyId },
            data: updateData
        });
        res.json(survey);
    } catch (error) {
        next(error);
    }
});

// POST duplicate survey (versioning)
router.post('/surveys/:surveyId/duplicate', async (req, res, next) => {
    try {
        const { surveyId } = req.params;
        const crypto = require('crypto');

        // Fetch old survey
        const oldSurvey = await req.prisma.survey.findUnique({
            where: { id: surveyId },
            include: { questions: { orderBy: { order: 'asc' } } }
        });

        if (!oldSurvey) return res.status(404).json({ error: 'Survey not found' });

        // Archive old survey
        await req.prisma.survey.update({
            where: { id: surveyId },
            data: { isActive: false, archivedAt: new Date() }
        });

        // Create new survey
        const newSurvey = await req.prisma.survey.create({
            data: {
                botId: oldSurvey.botId,
                title: oldSurvey.title,
                triggerButton: oldSurvey.triggerButton,
                isActive: true,
                isLinear: oldSurvey.isLinear,
                googleSheetId: null, // Reset integration so data goes missing or to new place
                syncMode: oldSurvey.syncMode
            }
        });

        // Map old question IDs to new UUIDs
        const idMap = {};
        for (const q of oldSurvey.questions) {
            idMap[q.id] = crypto.randomUUID();
        }

        const newQuestions = oldSurvey.questions.map(q => {
            let newRoutingRules = q.routingRules;
            if (newRoutingRules && Array.isArray(newRoutingRules)) {
                newRoutingRules = newRoutingRules.map(rule => ({
                    ...rule,
                    next_question_id: rule.next_question_id && idMap[rule.next_question_id] ? idMap[rule.next_question_id] : rule.next_question_id
                }));
            }

            return {
                id: idMap[q.id],
                surveyId: newSurvey.id,
                order: q.order,
                type: q.type,
                text: q.text,
                options: q.options || null,
                isRequired: q.isRequired,
                isConversion: q.isConversion,
                routingRules: newRoutingRules || null
            };
        });

        if (newQuestions.length > 0) {
            await req.prisma.question.createMany({ data: newQuestions });
        }

        res.status(201).json({ success: true, newSurveyId: newSurvey.id });
    } catch (error) {
        next(error);
    }
});


// POST append a new question to a survey
router.post('/questions', async (req, res, next) => {
    try {
        const { surveyId, type, text, options, isRequired, routingRules, isConversion } = req.body;

        // Allow any question type to be a conversion
        const actualIsConversion = Boolean(isConversion);

        // Find highest order to append to the end
        const lastQ = await req.prisma.question.findFirst({
            where: { surveyId },
            orderBy: { order: 'desc' }
        });
        const order = lastQ ? lastQ.order + 1 : 0;

        const question = await req.prisma.question.create({
            data: { surveyId, order, type, text, options, isRequired, isConversion: actualIsConversion, routingRules }
        });
        res.status(201).json(question);
    } catch (error) {
        next(error);
    }
});

// PUT reorder questions (mass update)
router.put('/questions/reorder', async (req, res, next) => {
    try {
        const { orderedIds } = req.body; // Array of question UUIDs in exact order

        // Use a transaction to perform all updates reliably
        const updates = orderedIds.map((id, index) => {
            return req.prisma.question.update({
                where: { id },
                data: { order: index }
            });
        });

        await req.prisma.$transaction(updates);
        res.json({ success: true, message: 'Questions reordered' });
    } catch (error) {
        next(error);
    }
});

// PUT update a specific question (text, rules, etc)
router.put('/questions/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { text, type, options, isRequired, routingRules, isConversion } = req.body;

        // Allow any question type to be a conversion
        const actualIsConversion = Boolean(isConversion);

        const question = await req.prisma.question.update({
            where: { id },
            data: { text, type, options, isRequired, isConversion: actualIsConversion, routingRules }
        });
        res.json(question);
    } catch (error) {
        next(error);
    }
});

// GET survey analytics tied to Survey ID
router.get('/surveys/:id/analytics', async (req, res, next) => {
    try {
        const { id } = req.params;

        // Total Users: have fired a SURVEY_STARTED event for this survey
        const totalUsersQuery = await req.prisma.analyticsEvent.findMany({
            where: { eventType: 'SURVEY_STARTED', sourceId: id },
            select: { userId: true },
            distinct: ['userId']
        });
        const totalUsers = totalUsersQuery.length;

        // Completed Users: have fired a SURVEY_COMPLETED event for this survey
        const completedUsersQuery = await req.prisma.analyticsEvent.findMany({
            where: { eventType: 'SURVEY_COMPLETED', sourceId: id },
            select: { userId: true },
            distinct: ['userId']
        });
        const completedUsers = completedUsersQuery.length;

        // Zero Division Protection
        const completionRate = totalUsers > 0 ? ((completedUsers / totalUsers) * 100).toFixed(0) + '%' : '0%';

        // Conversion Aggregation Requirements (DB-level)
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

        res.json({
            totalUsers,
            completedUsers,
            completionRate,
            conversions
        });
    } catch (error) {
        next(error);
    }
});

// Export handler extracted for dual-route registration
async function handleExport(req, res, next) {
    try {
        const { id } = req.params;
        const { columns: selectedColsStr, all } = req.query;
        const ExcelJS = require('exceljs');

        // 1. Fetch survey and questions
        const survey = await req.prisma.survey.findUnique({
            where: { id },
            include: { questions: { orderBy: { order: 'asc' } } }
        });

        if (!survey) return res.status(404).json({ error: 'Survey not found' });

        // Determine which questions to export
        let questionsToExport = survey.questions;
        if (all !== 'true' && selectedColsStr) {
            const selectedIds = selectedColsStr.split(',');
            questionsToExport = survey.questions.filter(q => selectedIds.includes(q.id));
        }

        const users = await req.prisma.user.findMany({
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

        if (!users || users.length === 0) {
            console.log("No users found for survey export:", id);
        }

        // 2. Create Workbook
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Ответы');

        // 3. Define Columns
        const columns = [
            { header: 'Имя', key: 'firstName', width: 25 },
            { header: 'Username', key: 'username', width: 25 },
            { header: 'Дата завершения', key: 'completionDate', width: 25 }
        ];

        questionsToExport.forEach(q => {
            columns.push({
                header: q.text,
                key: `q_${q.id}`,
                width: 40
            });
        });

        worksheet.columns = columns;

        // Header Styling
        worksheet.getRow(1).eachCell(cell => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        });

        // 4. Add Rows
        users.forEach(user => {
            const userAnswersMap = {};

            // Current answers
            user.answers.forEach(ans => {
                userAnswersMap[ans.questionId] = ans.value;
            });

            // History fallback
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

            questionsToExport.forEach(q => {
                rowData[`q_${q.id}`] = userAnswersMap[q.id] || '-';
            });

            worksheet.addRow(rowData);
        });

        // 5. Send File
        const filename = req.params.filename || `survey_export_${id}.xlsx`;
        console.log(`[Export] Serving: ${filename}`);
        const buffer = await workbook.xlsx.writeBuffer();

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        res.status(200).send(buffer);

    } catch (error) {
        console.error('Export error (Detailed):', error);
        res.status(500).json({ error: 'Failed to generate export', details: error.message });
    }
}

// Register both routes for export (with and without filename in path)
router.get('/surveys/:id/export', handleExport);
router.get('/surveys/:id/export/:filename', handleExport);

// GET survey users strictly filtered by interaction
router.get('/surveys/:id/users', async (req, res, next) => {
    try {
        const { id } = req.params;

        // Fetch all users who have either current answers OR completion events for this survey
        const users = await req.prisma.user.findMany({
            where: {
                OR: [
                    { answers: { some: { question: { surveyId: id } } } },
                    { analyticsEvents: { some: { eventType: 'SURVEY_COMPLETED', sourceId: id } } }
                ]
            },
            include: {
                answers: {
                    include: { question: true }
                },
                analyticsEvents: {
                    where: { eventType: 'SURVEY_COMPLETED', sourceId: id },
                    orderBy: { createdAt: 'desc' }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        const safeUsers = users.map(u => ({
            ...u,
            telegramId: u.telegramId ? u.telegramId.toString() : null,
            surveyHistory: u.analyticsEvents || []
        }));

        res.json(safeUsers);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
