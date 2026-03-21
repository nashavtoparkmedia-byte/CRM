'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

const BOT_API_URL = process.env.BOT_API_URL || 'http://localhost:4000/api/bot'

async function notifyDriverLinked(telegramId: bigint, driverName: string) {
    try {
        const message = `✅ Ваш профиль водителя успешно привязан к Telegram!\n\nВодитель: *${driverName}*\n\nТеперь вы можете использовать кнопку «💳 Управление лимитом» в меню бота.`
        await fetch(`${BOT_API_URL}/send-message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: telegramId.toString(), text: message })
        })
    } catch (err) {
        console.error('[notifyDriverLinked] Failed to send notification:', err)
    }
}

export async function saveDriverTelegramLink(driverId: string, telegramIdStr: string, driverName?: string) {
    try {
        const telegramId = BigInt(telegramIdStr)

        // Upsert DriverTelegram mapping
        await prisma.driverTelegram.upsert({
            where: { driverId },
            update: { telegramId },
            create: { driverId, telegramId }
        })

        // Notify the driver in Telegram that their profile is now linked
        if (driverName) {
            await notifyDriverLinked(telegramId, driverName)
        }

        revalidatePath(`/drivers/${driverId}`)
        return { success: true }
    } catch (err: any) {
        console.error('Failed to link telegram driver:', err)
        if (err.code === 'P2002' && err.meta?.target?.includes('telegramId')) {
            return { success: false, error: 'Этот Telegram ID уже привязан к другому водителю' }
        }
        return { success: false, error: 'Ошибка базы данных' }
    }
}

export async function removeDriverTelegramLink(driverId: string) {
    try {
        await prisma.driverTelegram.delete({
            where: { driverId }
        })
        revalidatePath(`/drivers/${driverId}`)
        return { success: true }
    } catch (err: any) {
        if (err.code === 'P2025') {
            return { success: true }
        }
        console.error('Failed to unlink telegram driver:', err)
        return { success: false, error: 'Ошибка базы данных' }
    }
}
