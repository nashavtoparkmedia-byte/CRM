/**
 * Canonical Driver Bot API transport id, owned by the Telegram channel context.
 *
 * The Bot transport is CONFIGURATION-owned. It is deliberately not derived from
 * any stored row: `Chat.metadata.connectionId` is descriptive legacy telemetry
 * that may name the MTProto personal-account transport, and
 * `TelegramConnection` is the MTProto connection model — numeric, shaped like an
 * account id, and explicitly forbidden as one. Nothing here reads the database.
 * See docs/design/provider-account-identity-v1.md.
 *
 * There is no fallback. A missing or non-concrete value fails closed so that a
 * misconfigured runtime refuses Bot-bound work instead of silently routing it
 * through whichever transport a legacy conversation happens to carry.
 */

/** The exact configuration name that owns the Bot transport id. */
export const TELEGRAM_BOT_CONNECTION_ENV_NAME = 'CRM_TELEGRAM_CONNECTION_ID'

/**
 * Placeholders that exist in legacy rows and older payloads. They name no
 * transport, so they are refused rather than treated as a configured value.
 * Kept identical to the delivery module's `concreteId` rejection set.
 */
const PLACEHOLDER_CONNECTION_IDS: readonly string[] = ['legacy', 'telegram-default']

/**
 * The configured Driver Bot API transport id.
 *
 * Accepts only a concrete, already-trimmed, non-empty, non-placeholder string.
 * The canonical production value is supplied by configuration and is never
 * hardcoded here, so this function carries no product policy.
 *
 * @throws Error `TELEGRAM_BOT_CONNECTION_CONFIG_UNPROVEN` when unconfigured.
 */
export function canonicalTelegramBotConnectionIdV1(
    environment: Record<string, string | undefined> = process.env,
): string {
    const configured = environment[TELEGRAM_BOT_CONNECTION_ENV_NAME]
    if (
        typeof configured !== 'string'
        || configured.length === 0
        || configured !== configured.trim()
        || PLACEHOLDER_CONNECTION_IDS.includes(configured)
    ) {
        throw new Error('TELEGRAM_BOT_CONNECTION_CONFIG_UNPROVEN')
    }
    return configured
}
