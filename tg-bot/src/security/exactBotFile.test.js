'use strict';

/**
 * The file endpoint the CRM reads support screenshots through.
 *
 * A Telegram file id means something only to the bot token that received it,
 * and that token lives in this process. So this endpoint is the whole boundary:
 * it must authenticate every caller, accept nothing but a file id, never hand
 * back or log the token or the download URL it derives, and never serve
 * anything a browser would run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createExactCrmBotFileHandler } = require('../services/exactCrmBotFile');

const TOKEN = '123456:AA-secret-bot-token';
const FILE_ID = 'AgACAgIAAxkBAAIB_2abc123DEF456ghi';

function responseRecorder() {
    return {
        statusCode: null,
        body: null,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
        end(body) { this.body = body; return this; },
    };
}

const NO_HEADER = Symbol('absent');

function request(body, signature = 'shared-secret') {
    return {
        body,
        get: name => (name === 'x-bot-signature' && signature !== NO_HEADER ? signature : undefined),
    };
}

function fixture(overrides = {}) {
    const logged = [];
    const logger = {
        info: message => logged.push(String(message)),
        warn: message => logged.push(String(message)),
        error: message => logged.push(String(message)),
    };
    const bot = {
        telegram: {
            getFileLink: overrides.getFileLink
                ?? (async () => new URL(`https://api.telegram.org/file/bot${TOKEN}/photos/file_1.jpg`)),
        },
    };
    return {
        logged,
        handler: createExactCrmBotFileHandler({
            bot,
            logger,
            environment: { BOT_CRM_SECRET: 'shared-secret', BOT_TOKEN: TOKEN },
            ...(overrides.maxBytes === undefined ? {} : { maxBytes: overrides.maxBytes }),
        }),
    };
}

/** A downloaded file, without reaching the network. */
function stubFetch(reply) {
    const original = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, options) => {
        seen.push(String(url));
        if (reply.throws) throw Object.assign(new Error('boom'), { name: reply.throws });
        return {
            ok: reply.status === undefined || reply.status === 200,
            status: reply.status ?? 200,
            headers: { get: name => (name === 'content-length' ? reply.contentLength ?? null : null) },
            arrayBuffer: async () => {
                const bytes = reply.bytes ?? Buffer.from('image-bytes');
                return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            },
            __options: options,
        };
    };
    return { seen, restore: () => { globalThis.fetch = original; } };
}

test('refuses a caller with no signature, a wrong one, or no configured secret', async () => {
    for (const signature of [NO_HEADER, '', 'not-the-secret']) {
        const { handler } = fixture();
        const response = responseRecorder();
        await handler(request({ fileId: FILE_ID }, signature), response);
        assert.equal(response.statusCode, 401);
        assert.equal(response.body.error, 'TELEGRAM_BOT_TRANSPORT_UNAUTHORIZED');
    }

    const unconfigured = createExactCrmBotFileHandler({
        bot: { telegram: { getFileLink: async () => { throw new Error('must not be called'); } } },
        logger: { warn() {} },
        environment: {},
    });
    const response = responseRecorder();
    await unconfigured(request({ fileId: FILE_ID }, 'shared-secret'), response);
    assert.equal(response.statusCode, 401);
});

test('accepts a file id and nothing else', async () => {
    for (const fileId of [undefined, '', 'short', '../../etc/passwd', 'has spaces', 'a'.repeat(300), { evil: true }]) {
        const { handler } = fixture();
        const response = responseRecorder();
        await handler(request({ fileId }), response);
        assert.equal(response.statusCode, 400, `accepted ${JSON.stringify(fileId)}`);
        assert.equal(response.body.error, 'TELEGRAM_FILE_ID_INVALID');
    }
});

test('ignores anything else the caller sends, including a url of its own', async () => {
    const { handler } = fixture();
    const stub = stubFetch({});
    try {
        const response = responseRecorder();
        await handler(request({
            fileId: FILE_ID,
            url: 'https://attacker.example/steal',
            chatId: '42',
        }), response);
        assert.equal(response.statusCode, 200);
        // The only URL fetched is the one the bot derived from the file id.
        assert.equal(stub.seen.length, 1);
        assert.ok(stub.seen[0].startsWith('https://api.telegram.org/file/bot'));
    } finally {
        stub.restore();
    }
});

test('serves the bytes as an inert private response', async () => {
    const { handler } = fixture();
    const stub = stubFetch({ bytes: Buffer.from('image-bytes') });
    try {
        const response = responseRecorder();
        await handler(request({ fileId: FILE_ID }), response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-type'], 'image/jpeg');
        assert.equal(response.headers['cache-control'], 'private, no-store');
        assert.equal(response.headers['x-content-type-options'], 'nosniff');
        assert.equal(response.headers['content-length'], String(Buffer.from('image-bytes').byteLength));
    } finally {
        stub.restore();
    }
});

test('takes the content type from the path Telegram chose, never from the caller', async () => {
    const cases = [
        ['photos/file_1.png', 'image/png'],
        ['documents/file_2.pdf', 'application/pdf'],
        ['animations/file_3.gif', 'image/gif'],
    ];
    for (const [path, expected] of cases) {
        const { handler } = fixture({
            getFileLink: async () => new URL(`https://api.telegram.org/file/bot${TOKEN}/${path}`),
        });
        const stub = stubFetch({});
        try {
            const response = responseRecorder();
            await handler(request({ fileId: FILE_ID, contentType: 'text/html' }), response);
            assert.equal(response.statusCode, 200);
            assert.equal(response.headers['content-type'], expected);
        } finally {
            stub.restore();
        }
    }
});

test('refuses a media type the CRM will not display', async () => {
    for (const path of ['voice/file_4.ogg', 'documents/file_5.exe', 'documents/file_6']) {
        const { handler } = fixture({
            getFileLink: async () => new URL(`https://api.telegram.org/file/bot${TOKEN}/${path}`),
        });
        const response = responseRecorder();
        await handler(request({ fileId: FILE_ID }), response);
        assert.equal(response.statusCode, 415);
        assert.equal(response.body.error, 'TELEGRAM_FILE_UNSUPPORTED_MEDIA');
    }
});

test('answers a file id the bot cannot resolve as not found, echoing nothing', async () => {
    const { handler, logged } = fixture({
        getFileLink: async () => {
            throw Object.assign(new Error('Bad Request'), { description: `wrong file_id for bot${TOKEN}` });
        },
    });
    const response = responseRecorder();
    await handler(request({ fileId: FILE_ID }), response);
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.error, 'TELEGRAM_FILE_NOT_FOUND');
    assert.equal(JSON.stringify(response.body).includes(TOKEN), false);
    // Telegram echoes the token back inside its own error text; the log must
    // not carry it onwards.
    for (const line of logged) assert.equal(line.includes(TOKEN), false);
});

test('caps the download both by what is declared and by what arrives', async () => {
    const declared = fixture({ maxBytes: 10 });
    let stub = stubFetch({ contentLength: '5000' });
    try {
        const response = responseRecorder();
        await declared.handler(request({ fileId: FILE_ID }), response);
        assert.equal(response.statusCode, 413);
        assert.equal(response.body.error, 'TELEGRAM_FILE_TOO_LARGE');
    } finally {
        stub.restore();
    }

    // A lying content-length is not the last word: the body is measured too.
    const arrived = fixture({ maxBytes: 4 });
    stub = stubFetch({ bytes: Buffer.from('much longer than four bytes') });
    try {
        const response = responseRecorder();
        await arrived.handler(request({ fileId: FILE_ID }), response);
        assert.equal(response.statusCode, 413);
    } finally {
        stub.restore();
    }
});

test('reports a failed download without leaking where it failed', async () => {
    for (const [reply, status, error] of [
        [{ throws: 'TimeoutError' }, 502, 'TELEGRAM_FILE_DOWNLOAD_FAILED'],
        [{ status: 404 }, 404, 'TELEGRAM_FILE_NOT_FOUND'],
        [{ status: 500 }, 502, 'TELEGRAM_FILE_DOWNLOAD_FAILED'],
    ]) {
        const { handler, logged } = fixture();
        const stub = stubFetch(reply);
        try {
            const response = responseRecorder();
            await handler(request({ fileId: FILE_ID }), response);
            assert.equal(response.statusCode, status);
            assert.equal(response.body.error, error);
            for (const line of logged) {
                assert.equal(line.includes(TOKEN), false);
                assert.equal(line.includes('api.telegram.org'), false);
            }
        } finally {
            stub.restore();
        }
    }
});

test('never returns or logs the token or the download url on the happy path', async () => {
    const { handler, logged } = fixture();
    const stub = stubFetch({});
    try {
        const response = responseRecorder();
        await handler(request({ fileId: FILE_ID }), response);
        const serialised = `${JSON.stringify(response.headers)}${String(response.body)}`;
        assert.equal(serialised.includes(TOKEN), false);
        assert.equal(serialised.includes('api.telegram.org'), false);
        assert.deepEqual(logged, []);
    } finally {
        stub.restore();
    }
});
