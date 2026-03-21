const express = require('express');
const router = express.Router();

// GET simple analytics for a bot
router.get('/', async (req, res, next) => {
    try {
        const { botId } = req.query;
        if (!botId) return res.status(400).json({ error: 'botId query param is required' });

        // 1. Total Users
        const totalUsers = await req.prisma.user.count({ where: { botId } });

        // 2. Completed Users
        const completedUsers = await req.prisma.user.count({
            where: { botId, status: 'COMPLETED' }
        });

        // 3. Funnel / Conversion Math
        const completionRate = totalUsers > 0 ? ((completedUsers / totalUsers) * 100).toFixed(2) + '%' : '0%';

        // Option MVP: We can aggregate how many users are stuck on which question
        const stuckUsersRaw = await req.prisma.user.groupBy({
            by: ['currentQuestionId'],
            where: { botId, status: 'ACTIVE' },
            _count: { _all: true }
        });

        const stuckUsers = stuckUsersRaw.map(su => ({
            questionId: su.currentQuestionId,
            count: su._count._all
        }));

        res.json({
            totalUsers,
            completedUsers,
            completionRate,
            dropOffPoints: stuckUsers
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
