/**
 * Service to handle native Telegram API calls.
 * Implements exponential backoff for 429 Too Many Requests errors.
 */

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function callTelegramAPI(botToken, method, payload, retryCount = 0) {
    const url = `https://api.telegram.org/bot${botToken}/${method}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (response.status === 429) {
            if (retryCount >= MAX_RETRIES) {
                throw new Error(`Telegram API Error 429: Max retries reached for ${method}`);
            }

            const retryAfter = response.headers.get('retry-after');
            const delayMs = retryAfter ? parseInt(retryAfter) * 1000 : BASE_DELAY_MS * Math.pow(2, retryCount);

            console.warn(`[Telegram API] 429 Too Many Requests. Retrying in ${delayMs}ms (Attempt ${retryCount + 1}/${MAX_RETRIES})`);
            await sleep(delayMs);

            return callTelegramAPI(botToken, method, payload, retryCount + 1);
        }

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Telegram API] Error ${response.status} on ${method}:`, errorText);
            throw new Error(`Telegram API Error: ${response.status} ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        if (retryCount < MAX_RETRIES && error.message.includes('fetch')) { // Network errors
            const delayMs = BASE_DELAY_MS * Math.pow(2, retryCount);
            console.warn(`[Telegram API] Network Error. Retrying in ${delayMs}ms (Attempt ${retryCount + 1}/${MAX_RETRIES})`);
            await sleep(delayMs);
            return callTelegramAPI(botToken, method, payload, retryCount + 1);
        }
        throw error;
    }
}

/**
 * Sends a text message, optionally with an inline keyboard.
 */
async function sendMessage(botToken, chatId, text, options = {}) {
    const payload = {
        chat_id: chatId,
        text: text,
    };

    if (options.reply_markup) {
        payload.reply_markup = options.reply_markup;
    }

    return callTelegramAPI(botToken, 'sendMessage', payload);
}

/**
 * Formats options array from DB into generic Telegram InlineKeyboardMarkup
 */
function formatInlineKeyboard(optionsArray) {
    if (!optionsArray || !Array.isArray(optionsArray)) return null;

    // Assuming optionsArray is an array of strings for simplicity MVP
    const inline_keyboard = optionsArray.map(opt => {
        return [{ text: opt.toString(), callback_data: opt.toString() }];
    });

    return { inline_keyboard };
}

module.exports = {
    sendMessage,
    formatInlineKeyboard,
};
