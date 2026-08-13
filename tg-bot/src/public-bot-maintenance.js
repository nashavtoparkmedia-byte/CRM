const { PrismaClient } = require('@prisma/client')

const adminBotPublicSelect = Object.freeze({
    id: true,
    name: true,
    username: true,
    isActive: true,
    createdAt: true,
    surveys: true,
})

function requiredText(value, field) {
    if (typeof value !== 'string' || value.trim() === '' || value.length > 256) throw new TypeError(`${field} must be bounded text`)
    return value.trim()
}

/** Telegram-bot-owned bootstrap capability for the configured bot mapping. */
async function ensureBotMappingV1({ token, name }) {
    token = requiredText(token, 'token')
    name = requiredText(name, 'name')
    const prisma = new PrismaClient()
    try {
        const bot = await prisma.bot.findFirst({ where: { token }, include: { surveys: true } })
        if (!bot) {
            return await prisma.bot.create({
                data: { token, name, isActive: true, surveys: { create: [{ title: 'Основной опрос', triggerButton: '📊 Опрос качества' }] } },
            })
        }
        if (!bot.surveys || bot.surveys.length === 0) {
            await prisma.survey.create({ data: { botId: bot.id, title: 'Основной опрос', triggerButton: '📊 Опрос качества' } })
        }
        return bot
    } finally {
        await prisma.$disconnect()
    }
}

/** Telegram-bot-owned bootstrap capability for a dynamic survey flow. */
async function ensureSurveyBotV1({ token, name }) {
    token = requiredText(token, 'token')
    name = requiredText(name, 'name')
    const prisma = new PrismaClient()
    try {
        const bot = await prisma.bot.findFirst({ where: { token } })
        if (bot) return bot
        return await prisma.bot.create({ data: { token, name, surveys: { create: {} } } })
    } finally {
        await prisma.$disconnect()
    }
}

/** Telegram-bot-owned admin capability for a bot with its primary survey. */
async function createAdminBotV1({ token, name, username }) {
    token = requiredText(token, 'token')
    name = requiredText(name, 'name')
    if (username !== undefined && username !== null) username = requiredText(username, 'username')
    const prisma = new PrismaClient()
    try {
        return await prisma.bot.create({
            data: { token, name, username, surveys: { create: [{ title: 'Основной опрос', triggerButton: '📊 Опрос качества' }] } },
            // The owner capability itself projects the public result.  A
            // downstream route/projector change therefore cannot recover the
            // stored token from the value returned across this boundary.
            select: adminBotPublicSelect,
        })
    } finally {
        await prisma.$disconnect()
    }
}

module.exports = { ensureBotMappingV1, ensureSurveyBotV1, createAdminBotV1 }
