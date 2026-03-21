const express = require('express');
const router = express.Router();
const telegramService = require('../../services/telegramService');

// GET users for a specific bot (with simple pagination MVP and segment/filter filtering)
router.get('/', async (req, res, next) => {
    try {
        const { botId, skip = 0, take = 50, status, segment, filter } = req.query;
        if (!botId) return res.status(400).json({ error: 'botId query param is required' });

        const whereClause = { botId };
        if (status) whereClause.status = status;

        if (segment === 'COMPLETED_SURVEY') {
            whereClause.status = 'COMPLETED';
        } else if (segment === 'STARTED_SURVEY') {
            whereClause.status = 'ACTIVE';
            whereClause.answers = { some: {} };
        } else if (segment === 'STARTED_BOT_ONLY') {
            whereClause.answers = { none: {} };
        }

        // Dashboard funnel filters:
        // 'entered': all unique users (already covered by botId)
        // 'started': users who have STARTED an event or answered > 0
        // 'completed': users who have COMPLETED an event or status = COMPLETED
        if (filter === 'started') {
            whereClause.analyticsEvents = { some: { eventType: 'SURVEY_STARTED' } };
        } else if (filter === 'completed') {
            whereClause.analyticsEvents = { some: { eventType: 'SURVEY_COMPLETED' } };
        } else if (filter === 'started_survey') {
            // Бросили опрос: есть хотя бы один ответ, но статус не COMPLETED
            whereClause.answers = { some: {} };
            whereClause.NOT = { status: 'COMPLETED' };
        }

        const users = await req.prisma.user.findMany({
            where: whereClause,
            skip: parseInt(skip),
            take: parseInt(take),
            orderBy: { createdAt: 'desc' },
            include: {
                bot: true,
                answers: {
                    include: { question: true }
                },
                analyticsEvents: {
                    where: { eventType: { in: ['BOT_STARTED', 'SURVEY_STARTED', 'SURVEY_COMPLETED'] } },
                    orderBy: { createdAt: 'asc' }
                }
            }
        });

        const total = await req.prisma.user.count({ where: whereClause });

        // Map data to include FIO, Phone, and event dates for the frontend table
        const mappedUsers = users.map(u => {
            // Find FIO and phone in answers by guessing standard terms or types
            let fio = null;
            let phone = null;
            if (u.answers) {
                u.answers.forEach(a => {
                    const qText = a.question?.text?.toLowerCase() || '';
                    if (qText.includes('имя') || qText.includes('фио')) {
                        if (!fio) fio = a.value;
                    }
                    if (qText.includes('телефон') || qText.includes('номер')) {
                        if (!phone) phone = a.value;
                    }
                });
            }

            // Find event dates
            let dateStartedBot = u.createdAt; // Default to user creation date
            let dateStartedSurvey = null;
            let dateCompletedSurvey = null;

            if (u.analyticsEvents) {
                const bStart = u.analyticsEvents.find(e => e.eventType === 'BOT_STARTED');
                const sStart = u.analyticsEvents.find(e => e.eventType === 'SURVEY_STARTED');
                const sComp = u.analyticsEvents.find(e => e.eventType === 'SURVEY_COMPLETED');
                if (bStart) dateStartedBot = bStart.createdAt;
                if (sStart) dateStartedSurvey = sStart.createdAt;
                if (sComp) dateCompletedSurvey = sComp.createdAt;
            }

            return {
                ...u,
                fio,
                phone,
                dateStartedBot,
                dateStartedSurvey,
                dateCompletedSurvey,
                // Remove raw lists to save payload size if necessary
                answers: undefined,
                analyticsEvents: undefined
            };
        });

        res.json({ data: mappedUsers, total, skip, take });
    } catch (error) {
        next(error);
    }
});

// GET answers history for a user
router.get('/:id/answers', async (req, res, next) => {
    try {
        const { id } = req.params;
        const answers = await req.prisma.answer.findMany({
            where: { userId: id },
            include: {
                question: { select: { text: true, order: true } }
            },
            orderBy: { createdAt: 'asc' }
        });
        res.json(answers);
    } catch (error) {
        next(error);
    }
});

// POST manual message from admin to user
router.post('/:id/message', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { text } = req.body;

        const user = await req.prisma.user.findUnique({
            where: { id },
            include: { bot: true }
        });

        if (!user) return res.status(404).json({ error: 'User not found' });
        if (!text) return res.status(400).json({ error: 'Text is required' });

        await telegramService.sendMessage(user.bot.token, user.telegramId.toString(), text);

        res.json({ success: true, message: 'Message sent via Telegram API' });
    } catch (error) {
        next(error);
    }
});

// Global state for simple broadcast MVP lock
global.activeBroadcasts = global.activeBroadcasts || {};

// POST mass broadcast message to segmented users
router.post('/broadcast', async (req, res, next) => {
    try {
        const { botId, segment, text } = req.body;
        if (!botId || !text) return res.status(400).json({ error: 'botId and text are required' });

        if (global.activeBroadcasts[botId]) {
            return res.status(429).json({ error: 'A broadcast is already running for this bot' });
        }

        // Segment logic map (translating UI filters to Prisma queries)
        // MVP segments:
        // 'ALL' -> everyone
        // 'STARTED_BOT_ONLY' -> Users with 0 answers
        // 'STARTED_SURVEY' -> Users with >0 answers (and ACTIVE status)
        // 'COMPLETED_SURVEY' -> Users with COMPLETED status

        const whereClause = { botId };
        if (segment === 'COMPLETED_SURVEY') {
            whereClause.status = 'COMPLETED';
        } else if (segment === 'STARTED_SURVEY') {
            whereClause.status = 'ACTIVE';
            whereClause.answers = { some: {} };
        } else if (segment === 'STARTED_BOT_ONLY') {
            whereClause.answers = { none: {} };
        }

        const bot = await req.prisma.bot.findUnique({ where: { id: botId } });
        if (!bot) return res.status(404).json({ error: 'Bot not found' });

        const targetUsers = await req.prisma.user.findMany({
            where: whereClause,
            select: { id: true, telegramId: true }
        });

        if (targetUsers.length === 0) {
            return res.status(400).json({ error: 'No users found for this segment' });
        }

        // Fire and Forget execution
        global.activeBroadcasts[botId] = true;

        (async () => {
            let successCount = 0;
            let failureCount = 0;

            console.log(`[Broadcast Data] Starting broadcast to ${targetUsers.length} users in bot ${botId}`);
            for (const user of targetUsers) {
                try {
                    await telegramService.sendMessage(bot.token, user.telegramId.toString(), text);
                    successCount++;
                } catch (err) {
                    console.error(`[Broadcast Data] Failed to route to ${user.telegramId}: ${err.message}`);
                    failureCount++;
                }
                // Delay to respect rate limits
                await new Promise(r => setTimeout(r, 80));
            }
            console.log(`[Broadcast Data] Broadcast complete. Success: ${successCount}, Failed: ${failureCount}`);

            global.activeBroadcasts[botId] = false;
        })().catch(err => {
            console.error('[Broadcast Data] Uncaught error in broadcast loop', err);
            global.activeBroadcasts[botId] = false;
        });

        // Response sent immediately
        res.json({
            status: 'started',
            targetCount: targetUsers.length,
            message: 'Broadcast is running in the background'
        });

    } catch (error) {
        next(error);
    }
});

module.exports = router;
