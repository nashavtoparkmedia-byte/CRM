const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Helper to calculate start date based on period
function getStartDate(period) {
    const now = new Date();
    switch (period) {
        case 'today':
            now.setHours(0, 0, 0, 0);
            return now;
        case '7d':
            now.setDate(now.getDate() - 7);
            return now;
        case '30d':
            now.setDate(now.getDate() - 30);
            return now;
        case 'all':
        default:
            return new Date(0); // Beginning of time
    }
}

// GET /api/admin/dashboard
router.get('/', async (req, res, next) => {
    try {
        const { botId, period = '30d' } = req.query;
        if (!botId) return res.status(400).json({ error: 'botId query param is required' });

        const startDate = getStartDate(period);
        const dateFilter = { gte: startDate };

        // 1. KPI Cards
        const totalUsers = await req.prisma.user.count({
            where: { botId, createdAt: dateFilter }
        });

        // Unique users who started ANY survey
        const startedSurveysQuery = await req.prisma.analyticsEvent.findMany({
            where: { botId, eventType: 'SURVEY_STARTED', createdAt: dateFilter },
            select: { userId: true },
            distinct: ['userId']
        });
        const startedSurveys = startedSurveysQuery.length;

        // Unique users who completed ANY survey
        const completedSurveysQuery = await req.prisma.analyticsEvent.findMany({
            where: { botId, eventType: 'SURVEY_COMPLETED', createdAt: dateFilter },
            select: { userId: true },
            distinct: ['userId']
        });
        const completedSurveys = completedSurveysQuery.length;

        // Unique users is essentially anyone created in this timeframe
        const uniqueUsers = totalUsers; // BOT_STARTED equivalent

        const completionRate = uniqueUsers > 0 ? ((completedSurveys / uniqueUsers) * 100).toFixed(2) + '%' : '0%';
        const surveyCompletionRate = startedSurveys > 0 ? ((completedSurveys / startedSurveys) * 100).toFixed(2) + '%' : '0%';

        // 2. Audience Growth (Group by Date)
        // Prisma doesn't have a direct DATE() function for grouping in raw builder without queryRaw, 
        // so we'll fetch within range and bucket in JS for MVP, or use queryRaw.
        // For simplicity and DB agnostic, JS bucketing on limited timeframe:
        const eventsForGrowth = await req.prisma.analyticsEvent.findMany({
            where: { botId, createdAt: dateFilter, eventType: { in: ['BOT_STARTED', 'SURVEY_STARTED', 'SURVEY_COMPLETED'] } },
            select: { createdAt: true, eventType: true }
        });

        const growthMap = {};
        eventsForGrowth.forEach(ev => {
            const dateStr = ev.createdAt.toISOString().split('T')[0];
            if (!growthMap[dateStr]) {
                growthMap[dateStr] = { date: dateStr, newUsers: 0, started: 0, completed: 0 };
            }
            if (ev.eventType === 'BOT_STARTED') growthMap[dateStr].newUsers++;
            if (ev.eventType === 'SURVEY_STARTED') growthMap[dateStr].started++;
            if (ev.eventType === 'SURVEY_COMPLETED') growthMap[dateStr].completed++;
        });

        const audienceGrowth = Object.values(growthMap).sort((a, b) => a.date.localeCompare(b.date));

        // 3. Survey Breakdown (Unique users per survey)
        const surveys = await req.prisma.survey.findMany({ where: { botId } });
        const surveyMap = {};
        surveys.forEach(s => surveyMap[s.id] = s.title);

        const surveyEvents = await req.prisma.analyticsEvent.findMany({
            where: {
                botId,
                createdAt: dateFilter,
                eventType: { in: ['SURVEY_STARTED', 'SURVEY_COMPLETED'] },
                sourceId: { not: null }
            },
            select: { sourceId: true, eventType: true, userId: true },
            distinct: ['sourceId', 'eventType', 'userId']
        });

        const breakdownMap = {};
        surveyEvents.forEach(ev => {
            const sId = ev.sourceId;
            if (!breakdownMap[sId]) {
                breakdownMap[sId] = {
                    surveyId: sId,
                    surveyTitle: surveyMap[sId] || 'Unknown Survey',
                    started: 0,
                    completed: 0
                };
            }
            if (ev.eventType === 'SURVEY_STARTED') breakdownMap[sId].started++;
            if (ev.eventType === 'SURVEY_COMPLETED') breakdownMap[sId].completed++;
        });

        // Compute CR per survey
        const surveyBreakdown = Object.values(breakdownMap).map(b => ({
            ...b,
            completionRate: b.started > 0 ? ((b.completed / b.started) * 100).toFixed(2) + '%' : '0%'
        }));

        // 4. Broadcast Stats
        const broadcasts = await req.prisma.broadcast.findMany({
            where: { botId, createdAt: dateFilter },
            include: { stats: true }
        });

        const broadcastSummary = {
            totalSent: 0,
            success: 0,
            failed: 0
        };

        broadcasts.forEach(b => {
            if (b.stats) {
                // Sent to TG API
                const attempted = b.stats.successCount + b.stats.failedCount;
                broadcastSummary.totalSent += attempted;
                broadcastSummary.success += b.stats.successCount;
                broadcastSummary.failed += b.stats.failedCount;
            }
        });

        res.json({
            kpi: {
                uniqueUsers,
                startedSurveys,
                completedSurveys,
                completionRate,       // Global CR relative to unique users
                surveyCompletionRate  // CR relative to those who started
            },
            audienceGrowth,
            surveyBreakdown,
            broadcastSummary,
            funnel: {
                entered: uniqueUsers,
                started: startedSurveys,
                completed: completedSurveys
            }
        });

    } catch (error) {
        console.error('Dashboard Analytics Error:', error);
        next(error);
    }
});

module.exports = router;
