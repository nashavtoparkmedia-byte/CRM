'use strict';

/**
 * Cash referral in the driver bot: the inviter's own link and status, and
 * the capture of a link someone opened.
 *
 * One flag, BOT_REFERRAL_ENTRY_ENABLED, decides whether the menu entry
 * exists; only the exact string "true" releases it. The CRM decides
 * everything else and refuses on its own: who may invite, whether an
 * invitation qualifies, and what access follows.
 *
 * A capture answers every driver with the same sentence, whatever the CRM
 * found, so a link reveals nothing about a code or an earlier invitation. The
 * token is sent to the CRM and never logged or stored here.
 */

const logger = require('../utils/logger');
const config = require('../config');
const { callCRM } = require('../services/crmAction');
const { exactTelegramActionBinding } = require('../services/exactTelegramActionBinding');

const REFERRAL_ENTRY_LABEL = '🎁 Пригласить водителя';
const REFERRAL_TOKEN_PATTERN = /^r_[A-Za-z0-9_-]{22}$/;

const CAPTURE_REPLY = 'Приглашение получено. Подключение ещё не подтверждено: после подключения к парку бот проверит его автоматически.';
const TECHNICAL_FAILURE_TEXT = 'Не удалось получить ссылку-приглашение. Попробуйте ещё раз чуть позже 🔄';
const NOT_LINKED_TEXT = 'Чтобы приглашать водителей, привяжите Telegram к своему профилю водителя: откройте «🚘 Мой автомобиль» и поделитесь номером телефона. Если автоматически привязать не получится, напишите менеджеру.';
const UNAVAILABLE_TEXT = 'Раздел «Пригласить водителя» пока недоступен.';

const STATE_LABELS = [
    ['captured', 'перешли по ссылке'],
    ['pending', 'ждут подтверждения'],
    ['needs_review', 'на проверке у менеджера'],
    ['qualified', 'засчитаны'],
    ['not_qualified', 'пока не засчитаны'],
    ['rejected', 'отклонены'],
];

/** The label as a keyboard entry, or nothing while unreleased. */
function referralEntryButtons() {
    return config.referralEntryEnabled ? [REFERRAL_ENTRY_LABEL] : [];
}

/** Whether a /start payload is a referral token. */
function isReferralPayload(payload) {
    return typeof payload === 'string' && REFERRAL_TOKEN_PATTERN.test(payload);
}

/** Records that this account opened a referral link, then says the one sentence. */
async function captureReferral(ctx, token) {
    try {
        await callCRM('referral_capture', { telegramId: String(ctx.from.id), token, ...exactTelegramActionBinding(ctx) });
    } catch (error) {
        logger.warn(`[referral] capture not recorded: status=${error && error.status ? error.status : 'transport'}`);
    }
    await ctx.reply(CAPTURE_REPLY);
}

function formatDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString('ru-RU', { timeZone: 'Asia/Yekaterinburg' });
}

function statusText(invitations, accessSince) {
    const since = accessSince ? formatDate(accessSince) : null;
    const lines = [since
        ? `Доступ по приглашению: бессрочно, с ${since}.`
        : 'Доступ по приглашению: ещё нет.'];
    const counts = STATE_LABELS
        .map(([state, label]) => [label, Number(invitations && invitations[state]) || 0])
        .filter(([, count]) => count > 0)
        .map(([label, count]) => `${label}: ${count}`);
    lines.push(counts.length > 0 ? `Ваши приглашения — ${counts.join(' · ')}.` : 'По вашим ссылкам пока никто не переходил.');
    return lines.join('\n');
}

/** The inviter's screen: a new personal link, the conditions and their status. */
async function showReferral(ctx) {
    if (!config.referralEntryEnabled) return ctx.reply(UNAVAILABLE_TEXT);
    let answer;
    try {
        answer = await callCRM('referral_issue', { telegramId: String(ctx.from.id), ...exactTelegramActionBinding(ctx) });
    } catch (error) {
        logger.warn(`[referral] issue failed: status=${error && error.status ? error.status : 'transport'}`);
        return ctx.reply(TECHNICAL_FAILURE_TEXT);
    }
    if (!answer || answer.status !== 'issued' || typeof answer.token !== 'string') {
        const reason = answer && answer.reason;
        if (reason === 'disabled') return ctx.reply(UNAVAILABLE_TEXT);
        if (reason === 'identity_busy') return ctx.reply(TECHNICAL_FAILURE_TEXT);
        return ctx.reply(NOT_LINKED_TEXT);
    }
    const botUsername = ctx.botInfo && ctx.botInfo.username;
    if (!botUsername || !isReferralPayload(answer.token)) return ctx.reply(TECHNICAL_FAILURE_TEXT);
    const link = `https://t.me/${botUsername}?start=${answer.token}`;
    return ctx.reply([
        '🎁 Пригласите водителя в YOKO',
        '',
        'Если по вашей ссылке подключится новый водитель или вернётся водитель, который ушёл из парка, и он подключится как парковый самозанятый, вы получите бессрочный доступ к компенсации наличных. Лимиты компенсации при этом не меняются.',
        '',
        `Ваша ссылка: ${link}`,
        '',
        statusText(answer.invitations, answer.accessSince),
    ].join('\n'), { disable_web_page_preview: true });
}

module.exports = {
    REFERRAL_ENTRY_LABEL,
    referralEntryButtons,
    isReferralPayload,
    captureReferral,
    showReferral,
    statusText,
};
