const express = require('express');
const router = express.Router();
const { createAdminBotV1 } = require('../../public-bot-maintenance');
const { projectBotMetadata } = require('../../security/publicCredentialMetadata');

const publicBotSelect = {
    id: true,
    name: true,
    username: true,
    isActive: true,
    createdAt: true,
    surveys: true,
    _count: {
        select: { users: true }
    }
};

// GET all bots
router.get('/', async (req, res, next) => {
    try {
        const bots = await req.prisma.bot.findMany({
            select: publicBotSelect
        });
        res.json(bots.map(bot => projectBotMetadata(bot)));
    } catch (error) {
        console.error('Bot list fetch error:', error);
        next(error);
    }
});

// GET one bot by id
router.get('/:id', async (req, res, next) => {
    try {
        const bot = await req.prisma.bot.findUnique({
            where: { id: req.params.id },
            select: publicBotSelect
        });
        if (!bot) return res.status(404).json({ error: 'Bot not found' });
        res.json(projectBotMetadata(bot));
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
        const bot = await createAdminBotV1({ token, name, username });

        res.status(201).json(projectBotMetadata(bot));
    } catch (error) {
        // Перехват ошибки уникального токена
        if (error.code === 'P2002' && error.meta?.target?.includes('token')) {
            return res.status(400).json({ error: 'Бот с таким токеном уже существует.' });
        }
        console.error('Bot creation error:', error);
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
            data: { isActive, name },
            select: publicBotSelect
        });
        res.json(projectBotMetadata(bot));
    } catch (error) {
        next(error);
    }
});

module.exports = router;
