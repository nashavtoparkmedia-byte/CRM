const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    // Получаем все боты
    const bots = await prisma.bot.findMany({ select: { id: true, name: true } });
    console.log('Боты:', bots);

    if (bots.length === 0) { console.log('Нет ботов'); return; }
    const botId = bots[0].id;
    console.log('\nТестируем botId:', botId);

    // Все пользователи
    const allUsers = await prisma.user.findMany({
        where: { botId },
        select: { id: true, username: true, status: true, _count: { select: { answers: true } } }
    });
    console.log('\nВсе пользователи:', JSON.stringify(allUsers, null, 2));

    // Фильтр "бросили опрос": есть ответы, статус не COMPLETED
    const abandoned = await prisma.user.findMany({
        where: {
            botId,
            answers: { some: {} },
            NOT: { status: 'COMPLETED' }
        },
        select: { id: true, username: true, status: true, _count: { select: { answers: true } } }
    });
    console.log('\n"Бросили опрос" (answers>0 AND NOT COMPLETED):', JSON.stringify(abandoned, null, 2));
    console.log('Итого:', abandoned.length, 'чел.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
