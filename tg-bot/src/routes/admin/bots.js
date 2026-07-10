const express = require('express');
const router = express.Router();
const botRuntime = require('../../services/botRuntime');

async function findRuntimeBot(req, res) {
    const bot = await req.prisma.bot.findUnique({ where: { id: req.params.id } });
    if (!bot) {
        res.status(404).json({ error: 'Bot not found' });
        return null;
    }
    if (!botRuntime.matchesToken(bot.token)) {
        res.status(409).json({ error: 'This bot is not attached to the running Telegram worker' });
        return null;
    }
    return bot;
}

router.get('/:id/health', async (req, res, next) => {
    try {
        if (!await findRuntimeBot(req, res)) return;
        res.json(await botRuntime.getStatus());
    } catch (error) {
        next(error);
    }
});

router.post('/:id/restart', async (req, res, next) => {
    try {
        if (!await findRuntimeBot(req, res)) return;
        await botRuntime.ensureWebhook('admin_manual_repair');
        res.json(await botRuntime.getStatus());
    } catch (error) {
        next(error);
    }
});

// GET all bots
router.get('/', async (req, res, next) => {
    try {
        const bots = await req.prisma.bot.findMany({
            include: {
                surveys: true,
                _count: {
                    select: { users: true }
                }
            }
        });
        res.json(bots);
    } catch (error) {
        console.error('Bot list fetch error:', error);
        const fs = require('fs');
        fs.writeFileSync('last_bot_error.json', JSON.stringify({ error: error.message, stack: error.stack, time: new Date() }, null, 2), 'utf8');
        next(error);
    }
});

// GET one bot by id
router.get('/:id', async (req, res, next) => {
    try {
        const bot = await req.prisma.bot.findUnique({
            where: { id: req.params.id },
            include: {
                surveys: true,
                _count: {
                    select: { users: true }
                }
            }
        });
        if (!bot) return res.status(404).json({ error: 'Bot not found' });
        res.json(bot);
    } catch (error) {
        next(error);
    }
});

// POST add a new bot
router.post('/', async (req, res, next) => {
    try {
        const { token, name, username } = req.body;

        // Базовая валидация
        if (!token || !name) {
            return res.status(400).json({ error: 'Поля token и name обязательны' });
        }

        // Атомарное создание бота + связанного опроса
        const bot = await req.prisma.bot.create({
            data: {
                token,
                name,
                username,
                surveys: {
                    create: [{ title: 'Основной опрос', triggerButton: '📊 Опрос качества' }]
                }
            }
        });

        res.status(201).json(bot);
    } catch (error) {
        // Перехват ошибки уникального токена
        if (error.code === 'P2002' && error.meta?.target?.includes('token')) {
            return res.status(400).json({ error: 'Бот с таким токеном уже существует.' });
        }
        console.error('Bot creation error:', error);
        const fs = require('fs');
        fs.writeFileSync('last_bot_error.json', JSON.stringify({ error: error.message, stack: error.stack, time: new Date() }, null, 2), 'utf8');
        next(error);
    }
});

// PUT update bot settings
router.put('/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { isActive, name } = req.body;

        const bot = await req.prisma.bot.update({
            where: { id },
            data: { isActive, name }
        });
        res.json(bot);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
