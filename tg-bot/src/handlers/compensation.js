/**
 * "💰 Компенсация наличных" scene.
 *
 * The bot only renders and collects. Every rule — eligibility, the catalogue,
 * the selected park, whether Yandex confirmed an order recently enough, the
 * thousand-rouble cap, whether an order may still be claimed — lives in the CRM
 * behind four actions, so the driver cannot be shown one thing here and judged
 * by another rule there.
 *
 *   compensation_section      → the selected park's local list (today, earlier,
 *                               search), remaining budget, existing applications
 *   compensation_order_check  → whether a chosen order may go on, and whether
 *                               Yandex is being asked about it
 *   compensation_refresh      → schedules a refresh of the park's list
 *   compensation_submit       → one claim, refused by code if anything is missing
 *
 * Nothing remembered here is trusted. Each action is proven again in the CRM
 * from the current Telegram link, and every offered order carries the scope
 * token the CRM issued with its list, so a button from a list shown for another
 * park is answered as stale. No handler waits for Yandex: a check or a refresh
 * is scheduled and the driver carries on.
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
    park_not_selected: 'Сначала выберите парк.',
    selected_park_profile_unproven: 'В выбранном парке компенсация пока недоступна для вашего подтверждённого профиля. Переключите парк или напишите менеджеру.',
    driver_not_in_park: 'Не вижу вас в парке. Напишите менеджеру.',
    catalogue_disabled: 'В этом парке компенсация наличных пока не подключена.',
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
    budget_exhausted: 'Месячный бюджет компенсаций исчерпан.',
    stale_context: 'Список устарел: сменился парк или профиль. Откройте «💰 Компенсация наличных» заново.',
    order_confirmation_pending: 'Ещё проверяем заказ в Яндексе. Нажмите «Отправить ещё раз» через минуту.',
    order_not_confirmed: 'Яндекс не подтвердил этот заказ как завершённый за наличные. Компенсация по нему недоступна.',
    order_check_failed: 'Не получилось проверить заказ в Яндексе. Попробуйте ещё раз чуть позже.',
    order_check_unavailable: 'Проверка заказов в этом парке сейчас недоступна. Попробуйте позже.',
    // Refusals from the monetary core itself.
    active_pending_exists: 'У вас уже есть заявка на рассмотрении. Дождитесь решения по ней.',
    submission_window_closed: 'Срок подачи заявок за этот месяц закончился.',
    order_already_settled: 'По этому заказу новую заявку подать нельзя.',
    max_attempts_reached: 'По этому заказу новую заявку подать нельзя.',
    second_attempt_requires_rejected_first: 'По этому заказу новую заявку подать нельзя.',
    period_missing: 'Приём заявок за этот месяц закрыт. Напишите менеджеру.',
    period_not_open: 'Приём заявок за этот месяц закрыт. Напишите менеджеру.',
    person_reconciliation_required: 'Ваш профиль нужно проверить. Напишите менеджеру.',
    idempotency_conflict: 'Заявка по этому заказу уже отправлена. Статус — в разделе «💰 Компенсация наличных».',
};

// A park the driver must choose, or choose again, before anything is shown.
const PARK_REFUSALS = new Set(['park_not_selected', 'selected_park_profile_unproven']);

// An order check that ends the claim, as the refusal it amounts to.
const CHECK_STATE_REFUSAL = {
    gone: 'order_not_in_catalogue',
    already_claimed: 'order_already_claimed',
    not_confirmed: 'order_not_confirmed',
    check_failed: 'order_check_failed',
    unavailable: 'order_check_unavailable',
    stale_context: 'stale_context',
};

const CATALOGUE_HINT = {
    partial: 'Список ещё догружается: часть заказов за месяц может появиться позже.',
    stale: 'Список давно не обновлялся — нажмите «🔄 Обновить».',
};

// A 409 means this chat is linked but the CRM could not confirm, right now,
// that it belongs to the driver's person. That can be a brief lock as well as a
// missing confirmation, and sharing the number again would not help because
// the link already exists; so the driver is told to retry or ask a manager.
const AUTHORITY_REFUSED_TEXT = 'Не удалось подтвердить привязку этого чата. Попробуйте позже или напишите менеджеру.';
const STALE_LIST_TEXT = 'Этот список устарел. Откройте «💰 Компенсация наличных» заново.';

const EARLIER_PAGE_SIZE = 8;
// Telegram refuses callback data over 64 bytes.
const CALLBACK_DATA_LIMIT = 64;

const rubles = (kopecks) => (kopecks % 100 === 0 ? String(kopecks / 100) : (kopecks / 100).toFixed(2));

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

function orderLabel(order, withDate) {
    const when = withDate ? `${order.localDate} ${order.localTime}` : order.localTime;
    return `${when} — ${rubles(order.amountKopecks)} ₽${order.claimed ? ' · заявка подана' : ''}`;
}

/**
 * The button for one order. It names the order and the scope the list was
 * issued for, so pressing it later, or from another list, cannot mean a
 * different order. An id too long for Telegram's limit is kept in this visit's
 * state under a number that is never reused.
 */
function orderButton(ctx, scopeKey, order, withDate) {
    let data = `comp_o:${scopeKey}:${order.externalOrderId}`;
    if (Buffer.byteLength(data) > CALLBACK_DATA_LIMIT) {
        const longIds = ctx.scene.state.longIds || (ctx.scene.state.longIds = []);
        longIds.push(order.externalOrderId);
        data = `comp_x:${scopeKey}:${longIds.length - 1}`;
    }
    return [Markup.button.callback(orderLabel(order, withDate), data)];
}

function crmPayload(ctx, fields = {}) {
    return {
        telegramId: String(ctx.from.id),
        ...fields,
        ...exactTelegramActionBinding(ctx),
    };
}

function resetClaim(state) {
    state.order = null;
    state.supportConfirmed = false;
    state.claimedRubles = null;
    state.attachment = null;
}

/** Reads the section. Returns the view, or null after telling the driver why not. */
async function loadSection(ctx, search) {
    let view;
    try {
        view = await callCRM('compensation_section', crmPayload(ctx, search ? { search } : {}));
    } catch (error) {
        logger.error('[compensation] section failed', error);
        await ctx.reply(crmFailureText(error));
        await ctx.scene.leave();
        return null;
    }

    if (!view || view.available !== true) {
        const reason = view && view.reason;
        const summary = applicationsSummary(view && view.applications);
        if (PARK_REFUSALS.has(reason)) {
            // The scene stays open so the button below works.
            await ctx.reply(`${refusalText(reason)}${summary}`, Markup.inlineKeyboard([
                [Markup.button.callback('🏢 Выбрать парк', 'comp_park')],
                [Markup.button.callback('Отмена', 'comp_cancel')],
            ]));
            return null;
        }
        await ctx.reply(`${refusalText(reason)}${summary}`);
        await ctx.scene.leave();
        return null;
    }

    ctx.scene.state.scopeKey = view.scopeKey;
    return view;
}

function header(view) {
    const hint = CATALOGUE_HINT[view.catalogueStatus];
    return `💰 Компенсация наличных\n`
        + `Остаток бюджета на ${view.monthKey}: ${rubles(view.remainingBudgetKopecks)} ₽.`
        + (hint ? `\n${hint}` : '');
}

async function showToday(ctx) {
    ctx.scene.state.step = 'list';
    const view = await loadSection(ctx, null);
    if (!view) return;

    const today = view.orders.filter((order) => order.dayKey === view.todayKey);
    const earlierCount = view.orders.length - today.length;
    const buttons = today.map((order) => orderButton(ctx, view.scopeKey, order, false));
    buttons.push([
        Markup.button.callback('Более ранние заказы', 'comp_earlier:0'),
        Markup.button.callback('Найти заказ', 'comp_find'),
    ]);
    buttons.push([Markup.button.callback('🔄 Обновить', 'comp_refresh')]);
    buttons.push([Markup.button.callback('Отмена', 'comp_cancel')]);

    let body;
    if (today.length > 0) body = 'Сегодня:\nВыберите заказ.';
    else if (earlierCount > 0) body = 'Сегодня завершённых заказов за наличные пока нет.';
    else body = 'Сегодня завершённых заказов за наличные пока нет, более ранних тоже.';

    await ctx.reply(`${header(view)}\n\n${body}${applicationsSummary(view.applications)}`, Markup.inlineKeyboard(buttons));
}

async function showEarlier(ctx, page) {
    ctx.scene.state.step = 'list';
    const view = await loadSection(ctx, null);
    if (!view) return;

    const earlier = view.orders.filter((order) => order.dayKey !== view.todayKey);
    const pages = Math.max(1, Math.ceil(earlier.length / EARLIER_PAGE_SIZE));
    const current = Math.min(Math.max(0, page), pages - 1);
    const shown = earlier.slice(current * EARLIER_PAGE_SIZE, (current + 1) * EARLIER_PAGE_SIZE);

    const buttons = shown.map((order) => orderButton(ctx, view.scopeKey, order, true));
    const navigation = [];
    if (current > 0) navigation.push(Markup.button.callback('‹ Новее', `comp_earlier:${current - 1}`));
    if (current < pages - 1) navigation.push(Markup.button.callback('Старее ›', `comp_earlier:${current + 1}`));
    if (navigation.length > 0) buttons.push(navigation);
    buttons.push([Markup.button.callback('К сегодняшним', 'comp_today')]);
    buttons.push([Markup.button.callback('Отмена', 'comp_cancel')]);

    const body = earlier.length === 0
        ? 'Более ранних заказов за наличные нет.'
        : `Более ранние заказы (${current + 1} из ${pages}):`;
    await ctx.reply(`${header(view)}\n\n${body}`, Markup.inlineKeyboard(buttons));
}

async function showSearch(ctx, query) {
    ctx.scene.state.step = 'list';
    const view = await loadSection(ctx, query);
    if (!view) return;

    const search = view.search || { kind: 'unsupported', externalOrderIds: [], truncated: false };
    const byId = new Map(view.orders.map((order) => [order.externalOrderId, order]));
    const matches = search.externalOrderIds.map((id) => byId.get(id)).filter(Boolean);

    const buttons = matches.map((order) => orderButton(ctx, view.scopeKey, order, true));
    buttons.push([
        Markup.button.callback('Найти ещё', 'comp_find'),
        Markup.button.callback('К сегодняшним', 'comp_today'),
    ]);
    buttons.push([Markup.button.callback('🔄 Обновить', 'comp_refresh')]);

    let body;
    if (search.kind === 'unsupported') {
        body = 'Не понял запрос. Введите номер заказа, сумму в рублях (например 680) или время (например 15:42).';
    } else if (matches.length === 0) {
        body = 'Ничего не нашли. Если заказ завершился только что — нажмите «🔄 Обновить» и попробуйте через минуту.';
    } else {
        // Every match is offered, a single one included: none of these keys is
        // proven unique, so the driver chooses.
        body = `Найдено заказов: ${matches.length}${search.truncated ? ' (показаны первые)' : ''}. Выберите нужный:`;
    }
    await ctx.reply(body, Markup.inlineKeyboard(buttons));
}

function askSupport(ctx, order, checking) {
    const lead = checking
        ? 'Проверяем этот заказ в Яндексе — обычно это до пары минут. Можно продолжать.\n\n'
        : '';
    return ctx.reply(
        `${lead}Заказ ${order.localDate} ${order.localTime} на ${rubles(order.amountKopecks)} ₽.\n`
        + 'Вы уже обращались в поддержку Яндекса по этому заказу?',
        Markup.inlineKeyboard([
            [Markup.button.callback('Да, обращался', 'comp_support_yes')],
            [Markup.button.callback('Отмена', 'comp_cancel')],
        ]),
    );
}

const backToList = () => Markup.inlineKeyboard([
    [Markup.button.callback('К списку', 'comp_today')],
    [Markup.button.callback('Отмена', 'comp_cancel')],
]);

/**
 * Asks the CRM about one order. A repeated tap while the answer is pending is
 * the same request and is dropped.
 */
async function checkOrder(ctx, scopeKey, externalOrderId, retry) {
    const state = ctx.scene.state;
    if (state.checking === externalOrderId) return;
    state.checking = externalOrderId;

    let check;
    try {
        check = await callCRM('compensation_order_check', crmPayload(ctx, { externalOrderId, scopeKey, retry }));
    } catch (error) {
        logger.error('[compensation] order check failed', error);
        await ctx.reply(crmFailureText(error));
        return;
    } finally {
        state.checking = null;
    }

    switch (check && check.state) {
        case 'fresh':
        case 'checking':
            if (!state.order || state.order.externalOrderId !== check.order.externalOrderId) {
                resetClaim(state);
                // One key per chosen order: a retried submit of this claim is
                // the same logical submit, another order is a new one.
                state.idempotencyKey = crypto.randomUUID();
            }
            state.order = check.order;
            state.scopeKey = scopeKey;
            state.step = 'confirm_support';
            return askSupport(ctx, check.order, check.state === 'checking');
        case 'already_claimed':
            return ctx.reply(REFUSAL_TEXT.order_already_claimed, backToList());
        case 'gone':
            return ctx.reply(REFUSAL_TEXT.order_not_in_catalogue, backToList());
        case 'not_confirmed':
            return ctx.reply(REFUSAL_TEXT.order_not_confirmed, backToList());
        case 'check_failed':
            state.order = check.order;
            state.scopeKey = scopeKey;
            return ctx.reply(REFUSAL_TEXT.order_check_failed, Markup.inlineKeyboard([
                [Markup.button.callback('Проверить ещё раз', 'comp_retry_check')],
                [Markup.button.callback('К списку', 'comp_today')],
            ]));
        case 'unavailable':
            return ctx.reply(REFUSAL_TEXT.order_check_unavailable, backToList());
        case 'stale_context':
            await ctx.reply(REFUSAL_TEXT.stale_context);
            return ctx.scene.leave();
        default:
            await ctx.reply(refusalText(check && check.refusal));
            return ctx.scene.leave();
    }
}

async function submitClaim(ctx) {
    const state = ctx.scene.state;
    // One submit at a time: a second photo or tap while one is in flight is
    // the same submit.
    if (state.submitting) return;
    state.submitting = true;
    state.step = 'submitting';

    let result;
    try {
        result = await callCRM('compensation_submit', crmPayload(ctx, {
            externalOrderId: state.order.externalOrderId,
            claimedRubles: state.claimedRubles,
            supportConfirmed: state.supportConfirmed === true,
            attachmentFileId: state.attachment.fileId,
            attachmentKind: state.attachment.kind,
            idempotencyKey: ctx.scene.state.idempotencyKey,
            scopeKey: state.scopeKey,
        }));
    } catch (error) {
        logger.error('[compensation] submit failed', error);
        if (error && error.status === 409) {
            await ctx.reply(AUTHORITY_REFUSED_TEXT);
            return ctx.scene.leave();
        }
        // The answer may have been lost after the CRM wrote it; the same key
        // makes another try a replay, never a second claim.
        state.step = 'resubmit';
        return ctx.reply('Система недоступна, попробуйте отправить ещё раз.', Markup.inlineKeyboard([
            [Markup.button.callback('Отправить ещё раз', 'comp_resubmit')],
            [Markup.button.callback('Отмена', 'comp_cancel')],
        ]));
    } finally {
        state.submitting = false;
    }

    if (result && result.submitted === true) {
        await ctx.reply(
            `Заявка отправлена. К выплате ${rubles(result.amountKopecks)} ₽.\n`
            + 'Статус можно посмотреть в разделе «💰 Компенсация наличных».',
        );
        return ctx.scene.leave();
    }

    const refusal = result && result.refusal;
    if (refusal === 'order_confirmation_pending') {
        state.step = 'resubmit';
        return ctx.reply(REFUSAL_TEXT.order_confirmation_pending, Markup.inlineKeyboard([
            [Markup.button.callback('Отправить ещё раз', 'comp_resubmit')],
            [Markup.button.callback('Отмена', 'comp_cancel')],
        ]));
    }
    if (refusal === 'order_check_failed') {
        state.step = 'resubmit';
        return ctx.reply(REFUSAL_TEXT.order_check_failed, Markup.inlineKeyboard([
            [Markup.button.callback('Проверить ещё раз', 'comp_retry_check')],
            [Markup.button.callback('Отмена', 'comp_cancel')],
        ]));
    }
    await ctx.reply(refusalText(refusal));
    return ctx.scene.leave();
}

const compensationScene = new Scenes.BaseScene('compensation');

compensationScene.enter(async (ctx) => {
    ctx.scene.state.step = 'list';
    ctx.scene.state.supportConfirmed = false;
    ctx.scene.state.attachment = null;
    // One key per visit until an order is chosen; choosing one issues its own.
    ctx.scene.state.idempotencyKey = crypto.randomUUID();
    return showToday(ctx);
});

compensationScene.action('comp_cancel', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Отменено.');
    return ctx.scene.leave();
});

compensationScene.action('comp_park', async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.scene.enter('parkSelect');
});

compensationScene.action('comp_today', async (ctx) => {
    await ctx.answerCbQuery();
    return showToday(ctx);
});

compensationScene.action(/^comp_earlier:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    return showEarlier(ctx, Number(ctx.match[1]));
});

compensationScene.action('comp_find', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.scene.state.step = 'search';
    await ctx.reply(
        'Введите номер заказа, сумму в рублях или время завершения, например 15:42.',
        Markup.inlineKeyboard([[Markup.button.callback('К сегодняшним', 'comp_today')]]),
    );
});

compensationScene.action('comp_refresh', async (ctx) => {
    await ctx.answerCbQuery();
    let outcome;
    try {
        outcome = await callCRM('compensation_refresh', crmPayload(ctx));
    } catch (error) {
        logger.error('[compensation] refresh failed', error);
        return ctx.reply(crmFailureText(error));
    }
    const show = Markup.inlineKeyboard([[Markup.button.callback('Показать список', 'comp_today')]]);
    switch (outcome && outcome.status) {
        case 'scheduled':
        case 'joined':
            return ctx.reply('Обновляем список из Яндекса — это займёт до минуты. Нажмите «Показать список», когда будете готовы.', show);
        case 'recent':
            return ctx.reply('Список только что обновлялся.', show);
        case 'unavailable':
            return ctx.reply('Обновление в этом парке сейчас недоступно.', show);
        case 'refused':
            await ctx.reply(refusalText(outcome.refusal));
            return ctx.scene.leave();
        default:
            return ctx.reply('Не получилось запустить обновление, попробуйте позже.', show);
    }
});

compensationScene.action(/^comp_o:([0-9a-f]+):(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    return checkOrder(ctx, ctx.match[1], ctx.match[2], false);
});

compensationScene.action(/^comp_x:([0-9a-f]+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const externalOrderId = (ctx.scene.state.longIds || [])[Number(ctx.match[2])];
    if (!externalOrderId) return ctx.reply(STALE_LIST_TEXT);
    return checkOrder(ctx, ctx.match[1], externalOrderId, false);
});

compensationScene.action('comp_retry_check', async (ctx) => {
    await ctx.answerCbQuery();
    const state = ctx.scene.state;
    if (!state.order || !state.scopeKey) return ctx.reply(STALE_LIST_TEXT);
    if (state.step !== 'resubmit') return checkOrder(ctx, state.scopeKey, state.order.externalOrderId, true);

    // Everything is already collected: ask Yandex again and keep it.
    let check;
    try {
        check = await callCRM('compensation_order_check', crmPayload(ctx, {
            externalOrderId: state.order.externalOrderId,
            scopeKey: state.scopeKey,
            retry: true,
        }));
    } catch (error) {
        logger.error('[compensation] order recheck failed', error);
        return ctx.reply(crmFailureText(error));
    }
    const resubmit = Markup.inlineKeyboard([
        [Markup.button.callback('Отправить ещё раз', 'comp_resubmit')],
        [Markup.button.callback('Отмена', 'comp_cancel')],
    ]);
    if (check && check.state === 'fresh') return ctx.reply('Заказ подтверждён. Нажмите «Отправить ещё раз».', resubmit);
    if (check && check.state === 'checking') return ctx.reply(REFUSAL_TEXT.order_confirmation_pending, resubmit);
    await ctx.reply(refusalText(check && (check.refusal || CHECK_STATE_REFUSAL[check.state])));
    return ctx.scene.leave();
});

compensationScene.action('comp_support_yes', async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.scene.state.step !== 'confirm_support') return ctx.reply(STALE_LIST_TEXT);
    ctx.scene.state.supportConfirmed = true;
    ctx.scene.state.step = 'enter_amount';
    await ctx.reply('Сколько рублей запрашиваете? Целым числом, максимум 1000.');
});

compensationScene.action('comp_resubmit', async (ctx) => {
    await ctx.answerCbQuery();
    const state = ctx.scene.state;
    if (state.step !== 'resubmit' || !state.attachment || !state.order) return ctx.reply(STALE_LIST_TEXT);
    return submitClaim(ctx);
});

// Any other compensation button pressed while the scene is open belongs to a
// list or step that is gone.
compensationScene.action(/^comp_/, async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.reply(STALE_LIST_TEXT);
});

compensationScene.on('text', async (ctx) => {
    const step = ctx.scene.state.step;
    const raw = (ctx.message.text || '').trim();

    if (step === 'search') return showSearch(ctx, raw);

    if (step === 'attach') {
        await ctx.reply(REFUSAL_TEXT.attachment_missing);
        return;
    }

    if (step !== 'enter_amount') return;
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
    return submitClaim(ctx);
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

/**
 * A compensation button pressed with no compensation scene open: the list it
 * came from was shown before a restart, a park change or another section. It
 * is answered, never acted on.
 */
async function compensationStaleCallback(ctx) {
    await ctx.answerCbQuery('Список устарел').catch(() => {});
    await ctx.reply(STALE_LIST_TEXT);
}

module.exports = { compensationScene, compensationStaleCallback };
