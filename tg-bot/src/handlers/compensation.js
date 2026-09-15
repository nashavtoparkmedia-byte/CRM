/**
 * "💰 Компенсация наличных" scene.
 *
 * The bot only renders and collects. Every rule — eligibility, the catalogue,
 * the thousand-rouble cap, whether an order may still be claimed — lives in the
 * CRM behind two actions, so the driver cannot be shown one thing here and
 * judged by another rule there.
 *
 *   compensation_section  → eligibility, eligible orders, remaining budget,
 *                           and the driver's existing applications
 *   compensation_submit   → one claim, refused by code if anything is missing
 *
 * Steps: pick an order → confirm support was contacted → enter the amount →
 * attach the support reply → submit.
 */
const { Scenes, Markup } = require('telegraf');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { callCRM } = require('../services/crmAction');
const { exactTelegramActionBinding } = require('../services/exactTelegramActionBinding');

const STATUS_TEXT = {
    submitted: 'на рассмотрении',
    awaiting_payment: 'одобрена, ждёт выплаты',
    paid: 'выплачена',
    rejected: 'отклонена',
};

// Refusals arrive as codes. A driver needs a sentence, and a sentence that
// tells them what to do next rather than what the system checked.
const REFUSAL_TEXT = {
    identity_not_proven: 'Профиль не привязан. Откройте «Мой автомобиль» и поделитесь номером.',
    identity_needs_review: 'Ваш профиль нужно проверить. Напишите менеджеру.',
    identity_busy: 'Профиль сейчас обновляется. Попробуйте через минуту.',
    driver_not_in_park: 'Не вижу вас в парке. Напишите менеджеру.',
    not_self_employed: 'Компенсация доступна только самозанятым водителям парка.',
    self_employment_unknown: 'Пока не вижу ваш налоговый статус. Напишите менеджеру.',
    hire_date_unknown: 'Пока не вижу дату подключения. Напишите менеджеру.',
    outside_first_calendar_month: 'Компенсация действует только в первый календарный месяц после подключения.',
    support_not_confirmed: 'Сначала подтвердите, что обращались в поддержку Яндекса.',
    attachment_missing: 'Нужен ответ поддержки Яндекса — пришлите фото или файл.',
    claim_not_whole_rubles: 'Введите сумму целым числом рублей.',
    claim_below_minimum: 'Сумма должна быть больше нуля.',
    claim_above_pilot_cap: 'Максимум 1000 ₽.',
    order_not_in_catalogue: 'Этот заказ больше недоступен для компенсации.',
    order_already_claimed: 'По этому заказу заявка уже есть.',
    budget_exhausted: 'Месячный бюджет парка исчерпан.',
    // Refusals from the monetary core itself.
    active_pending_exists: 'У вас уже есть заявка на рассмотрении. Дождитесь решения по ней.',
    submission_window_closed: 'Срок подачи заявок за этот месяц закончился.',
    order_already_settled: 'По этому заказу новую заявку подать нельзя.',
    max_attempts_reached: 'По этому заказу новую заявку подать нельзя.',
    second_attempt_requires_rejected_first: 'По этому заказу новую заявку подать нельзя.',
    period_missing: 'Приём заявок за этот месяц закрыт. Напишите менеджеру.',
    period_not_open: 'Приём заявок за этот месяц закрыт. Напишите менеджеру.',
    person_reconciliation_required: 'Ваш профиль нужно проверить. Напишите менеджеру.',
};

// A 409 means this chat is linked but the CRM could not confirm, right now,
// that it belongs to the driver's person. That can be a brief lock as well as a
// missing confirmation, and sharing the number again would not help because
// the link already exists; so the driver is told to retry or ask a manager.
const AUTHORITY_REFUSED_TEXT = 'Не удалось подтвердить привязку этого чата. Попробуйте позже или напишите менеджеру.';

const rubles = (kopecks) => (kopecks / 100).toFixed(2);

function crmFailureText(error) {
    return error && error.status === 409
        ? AUTHORITY_REFUSED_TEXT
        : 'Система недоступна, попробуйте позже.';
}

function refusalText(code) {
    return REFUSAL_TEXT[code] || 'Не получилось отправить заявку. Напишите менеджеру.';
}

function applicationsSummary(applications) {
    if (!applications || applications.length === 0) return '';
    const lines = applications.slice(0, 5).map((application) => {
        const status = STATUS_TEXT[application.status] || application.status;
        const order = application.shortOrderId ? `№${application.shortOrderId}` : '';
        const reason = application.status === 'rejected' && application.rejectionReason
            ? ` — ${application.rejectionReason}`
            : '';
        return `• Заказ ${order}: ${rubles(application.amountKopecks)} ₽ — ${status}${reason}`;
    });
    return `\n\nВаши заявки:\n${lines.join('\n')}`;
}

const compensationScene = new Scenes.BaseScene('compensation');

compensationScene.enter(async (ctx) => {
    ctx.scene.state.step = 'choose_order';
    ctx.scene.state.supportConfirmed = false;
    ctx.scene.state.attachment = null;
    // One key per visit: a retried tap is the same logical submit, a new visit
    // is a new one.
    ctx.scene.state.idempotencyKey = crypto.randomUUID();

    let view;
    try {
        view = await callCRM('compensation_section', {
            telegramId: String(ctx.from.id),
            ...exactTelegramActionBinding(ctx),
        });
    } catch (error) {
        logger.error('[compensation] section failed', error);
        await ctx.reply(crmFailureText(error));
        return ctx.scene.leave();
    }

    if (!view || view.available !== true) {
        const summary = applicationsSummary(view && view.applications);
        await ctx.reply(`${refusalText(view && view.reason)}${summary}`);
        return ctx.scene.leave();
    }

    ctx.scene.state.orders = view.orders || [];
    if (ctx.scene.state.orders.length === 0) {
        await ctx.reply(`Нет заказов, доступных для компенсации.${applicationsSummary(view.applications)}`);
        return ctx.scene.leave();
    }

    const buttons = ctx.scene.state.orders.map((order) => [Markup.button.callback(
        `№${order.shortOrderId || order.externalOrderId.slice(0, 8)} — ${rubles(order.amountKopecks)} ₽`,
        `comp_order:${order.externalOrderId}`,
    )]);
    buttons.push([Markup.button.callback('Отмена', 'comp_cancel')]);

    await ctx.reply(
        `Компенсация наличных заказов.\n`
        + `Остаток бюджета парка на ${view.monthKey}: ${rubles(view.remainingBudgetKopecks)} ₽.\n`
        + `Выберите заказ:${applicationsSummary(view.applications)}`,
        Markup.inlineKeyboard(buttons),
    );
});

compensationScene.action('comp_cancel', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Отменено.');
    return ctx.scene.leave();
});

compensationScene.action(/^comp_order:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const externalOrderId = ctx.match[1];
    const order = (ctx.scene.state.orders || []).find((candidate) => candidate.externalOrderId === externalOrderId);
    if (!order) {
        await ctx.reply('Этот заказ больше недоступен.');
        return ctx.scene.leave();
    }
    ctx.scene.state.order = order;
    ctx.scene.state.step = 'confirm_support';
    await ctx.reply(
        `Заказ №${order.shortOrderId || ''} на ${rubles(order.amountKopecks)} ₽.\n`
        + 'Вы уже обращались в поддержку Яндекса по этому заказу?',
        Markup.inlineKeyboard([
            [Markup.button.callback('Да, обращался', 'comp_support_yes')],
            [Markup.button.callback('Отмена', 'comp_cancel')],
        ]),
    );
});

compensationScene.action('comp_support_yes', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.scene.state.supportConfirmed = true;
    ctx.scene.state.step = 'enter_amount';
    await ctx.reply('Сколько рублей запрашиваете? Целым числом, максимум 1000.');
});

compensationScene.on('text', async (ctx) => {
    if (ctx.scene.state.step !== 'enter_amount') return;
    const raw = (ctx.message.text || '').trim();
    // Parsed here only to keep the conversation moving; the CRM refuses the
    // same values again, and its answer is the one that counts.
    const amount = Number(raw);
    if (!Number.isInteger(amount) || amount < 1) {
        await ctx.reply('Введите целое число рублей, например 300.');
        return;
    }
    if (amount > 1000) {
        await ctx.reply('Максимум 1000 ₽. Введите другую сумму.');
        return;
    }
    ctx.scene.state.claimedRubles = amount;
    ctx.scene.state.step = 'attach';
    await ctx.reply('Пришлите ответ поддержки Яндекса — фото или файл.');
});

async function captureAttachment(ctx, fileId, kind) {
    ctx.scene.state.attachment = { fileId, kind };
    ctx.scene.state.step = 'submit';

    let result;
    try {
        result = await callCRM('compensation_submit', {
            telegramId: String(ctx.from.id),
            externalOrderId: ctx.scene.state.order.externalOrderId,
            claimedRubles: ctx.scene.state.claimedRubles,
            supportConfirmed: ctx.scene.state.supportConfirmed === true,
            attachmentFileId: fileId,
            attachmentKind: kind,
            idempotencyKey: ctx.scene.state.idempotencyKey,
            ...exactTelegramActionBinding(ctx),
        });
    } catch (error) {
        logger.error('[compensation] submit failed', error);
        await ctx.reply(crmFailureText(error));
        return ctx.scene.leave();
    }

    if (!result || result.submitted !== true) {
        await ctx.reply(refusalText(result && result.refusal));
        return ctx.scene.leave();
    }

    await ctx.reply(
        `Заявка отправлена. К выплате ${rubles(result.amountKopecks)} ₽.\n`
        + 'Статус можно посмотреть в разделе «Компенсация наличных».',
    );
    return ctx.scene.leave();
}

compensationScene.on('photo', async (ctx) => {
    if (ctx.scene.state.step !== 'attach') return;
    const photos = ctx.message.photo || [];
    const largest = photos[photos.length - 1];
    if (!largest) {
        await ctx.reply('Не получилось прочитать фото, попробуйте ещё раз.');
        return;
    }
    return captureAttachment(ctx, largest.file_id, 'photo');
});

compensationScene.on('document', async (ctx) => {
    if (ctx.scene.state.step !== 'attach') return;
    return captureAttachment(ctx, ctx.message.document.file_id, 'document');
});

module.exports = { compensationScene };
