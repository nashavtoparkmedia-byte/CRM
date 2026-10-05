'use strict';

/**
 * Manager-facing diagnostics for driver order failures.
 *
 * A qualifying order failure is an order-system incident: the configured
 * managers are paged with the scraper's screenshot when there is one, and with
 * a bounded text note when there is not. A driver who has simply not linked a
 * profile yet is an expected onboarding state, not an incident, and is
 * deliberately suppressed.
 *
 * Kept free of Telegraf so the classification and the fan-out can be exercised
 * directly against a stub transport.
 */

const logger = require('./logger');

const PRE_FLEET_ERRORS = new Set(['NOT_LINKED', 'NO_YANDEX_ID', 'LINK_INCOMPLETE']);

/** Below this a base64 payload is not a usable screenshot. */
const MIN_DIAGNOSTIC_IMAGE_LENGTH = 100;

function stoppedBeforeFleet(state) {
    return state?.preFleet === true || PRE_FLEET_ERRORS.has(state?.error);
}

function shouldNotifyManagerAboutFailure(state) {
    // A user who has not linked a profile yet is an expected onboarding state,
    // not an order-system incident. Broken existing links remain actionable.
    return state?.error !== 'NOT_LINKED';
}

function diagnosticTitle(state) {
    return stoppedBeforeFleet(state)
        ? '⚠️ Требуется восстановить привязку водителя'
        : '⚠️ Ошибка действия с заказом';
}

function screenshotFallbackNote(state) {
    return stoppedBeforeFleet(state)
        ? 'Скриншот отсутствует: запрос остановлен до запуска Fleet.'
        : 'Скриншот сохранён в CRM или не был получен от скрапера.';
}

/**
 * Configured diagnostic recipients.
 *
 * Accepts the plural production setting and the legacy singular one, in either
 * comma, semicolon or whitespace separated form. There is deliberately no
 * built-in recipient: production configures `ADMIN_IDS`, so a hardcoded
 * personal id would be unreachable there while silently paging one individual
 * in every other environment. With nothing configured, nothing is sent.
 */
function diagnosticAdminIds(environment = process.env) {
    const raw = [environment.ADMIN_IDS, environment.ADMIN_ID].filter(Boolean).join(',');
    const ids = raw
        .split(/[\s,;]+/)
        // Empty segments must be dropped before Number(): `Number('')` is 0, and
        // 0 is a safe integer, so an unset configuration would otherwise resolve
        // to a recipient list of [0] and attempt a send to it.
        .filter(Boolean)
        .map(Number)
        .filter(id => Number.isSafeInteger(id) && id > 0);
    return [...new Set(ids)];
}

function diagnosticCaption(ctx, state) {
    return [
        diagnosticTitle(state),
        `Водитель TG: ${ctx?.from?.id || 'неизвестно'}`,
        `Этап: ${state?.diagnosticStep || state?.error || state?.errorMessage || state?.status || 'неизвестно'}`,
        state?.result?.shortOrderId ? `Заказ: ${state.result.shortOrderId}` : null,
        state?.actionId ? `CRM action: ${state.actionId}` : null,
    ].filter(Boolean).join('\n');
}

/**
 * Page every configured manager exactly once: photo, then document, then text.
 *
 * Returns the per-admin delivery record. It is NOT reported back to CRM: the
 * deployed Gravity lineage has no `report_diagnostic_delivery` action, so that
 * call could only produce a 4xx today. Recording the delivery result in CRM is
 * a follow-up, and its omission here is deliberate.
 */
async function notifyManagerAboutFailure(ctx, state, environment = process.env) {
    if (!shouldNotifyManagerAboutFailure(state)) return [];

    const caption = diagnosticCaption(ctx, state);
    const encoded = state?.diagnosticImageBase64;
    const buffer = typeof encoded === 'string' && encoded.length >= MIN_DIAGNOSTIC_IMAGE_LENGTH
        ? Buffer.from(encoded, 'base64')
        : null;
    const filename = `order-error-${state?.result?.shortOrderId || 'unknown'}.jpg`;

    const deliveries = [];
    for (const adminId of diagnosticAdminIds(environment)) {
        let delivered = false;
        let imageError = null;

        if (buffer) {
            try {
                await ctx.telegram.sendPhoto(adminId, { source: buffer }, { caption });
                deliveries.push({ adminId, status: 'delivered', method: 'photo' });
                delivered = true;
            } catch (photoError) {
                imageError = photoError?.message || String(photoError);
                // Telegram rejects some screenshots as photos but accepts the
                // same bytes as a document.
                try {
                    await ctx.telegram.sendDocument(
                        adminId,
                        { source: buffer, filename },
                        { caption },
                    );
                    deliveries.push({ adminId, status: 'delivered', method: 'document' });
                    delivered = true;
                } catch (documentError) {
                    imageError = documentError?.message || String(documentError);
                }
            }
        }

        if (!delivered) {
            try {
                await ctx.telegram.sendMessage(
                    adminId,
                    `${caption}\n${screenshotFallbackNote(state)}`,
                );
                deliveries.push({ adminId, status: 'delivered', method: 'text', imageError });
            } catch (textError) {
                deliveries.push({
                    adminId,
                    status: 'failed',
                    error: textError?.message || String(textError),
                    imageError,
                });
                logger.warn(`[DriverOrder] manager diagnostic send failed: ${textError?.message || textError}`);
            }
        }
    }

    return deliveries;
}

module.exports = {
    diagnosticAdminIds,
    diagnosticCaption,
    diagnosticTitle,
    notifyManagerAboutFailure,
    screenshotFallbackNote,
    shouldNotifyManagerAboutFailure,
    stoppedBeforeFleet,
};
