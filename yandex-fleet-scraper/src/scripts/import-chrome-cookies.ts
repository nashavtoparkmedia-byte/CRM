/**
 * Imports cookies for *.yandex.ru from the user's real Chrome profile
 * (Default by default) into the scraper's .bot_profile/ persistent context.
 *
 * This lets the headless scraper inherit the user's already-authenticated
 * Yandex session without them having to log in again — useful when the
 * user's Chrome is enrolled in Chrome Browser Cloud Management and CDP
 * (--remote-debugging-port) is silently disabled.
 *
 * Mechanics (Windows-specific):
 *   1) Read User Data/Local State (JSON) → os_crypt.encrypted_key (base64).
 *   2) Strip "DPAPI" prefix (5 bytes), DPAPI-Unprotect the rest (via PowerShell
 *      child process) → 32-byte AES-256-GCM master key.
 *   3) Copy User Data/<Profile>/Network/Cookies SQLite to temp (file is locked
 *      while Chrome runs — Chrome must be closed before running this).
 *   4) SELECT host_key, name, encrypted_value, path, expires_utc, is_secure,
 *      is_httponly, samesite WHERE host_key LIKE '%yandex%'.
 *   5) For each row: bytes[0:3] = "v10"/"v11", IV = bytes[3:15],
 *      ciphertext+tag = bytes[15:]. AES-256-GCM decrypt with master key.
 *      "v20" prefix means Chrome's new App-Bound Encryption (Chrome 127+) —
 *      we cannot decrypt those here and skip them with a warning.
 *   6) Launch chromium.launchPersistentContext('.bot_profile/') and
 *      addCookies(...) — Playwright persists them in its own SQLite.
 *
 * Run AFTER closing all Chrome windows. The script will error if Chrome is
 * still running and the SQLite copy is locked.
 *
 *   npm run import:chrome-cookies
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(stealthPlugin());

const USER_DATA = process.env.CHROME_USER_DATA_DIR ||
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const PROFILE = process.env.CHROME_PROFILE_DIR || 'Default';
const DOMAIN_FILTER = '%yandex%';
const BOT_PROFILE_DIR = path.join(process.cwd(), '.bot_profile');

function dpapiUnprotect(encrypted: Buffer): Buffer {
    // Use PowerShell to call System.Security.Cryptography.ProtectedData.Unprotect
    // because Node.js lacks native DPAPI bindings out of the box.
    const b64in = encrypted.toString('base64');
    const ps = `
        Add-Type -AssemblyName System.Security
        $enc = [Convert]::FromBase64String('${b64in}')
        $dec = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        [Convert]::ToBase64String($dec)
    `;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error(`DPAPI Unprotect failed: ${r.stderr || r.stdout}`);
    }
    return Buffer.from(r.stdout.trim(), 'base64');
}

function chromeTimeToUnix(chromeTimeUs: bigint | number): number {
    // Chrome stores expires_utc as microseconds since 1601-01-01 UTC.
    // Unix epoch (1970-01-01) is 11644473600 seconds later.
    const us = typeof chromeTimeUs === 'bigint' ? chromeTimeUs : BigInt(chromeTimeUs);
    if (us === 0n) return -1; // session cookie
    const seconds = Number(us / 1000000n) - 11644473600;
    return seconds;
}

function samesiteFromInt(v: number): 'Strict' | 'Lax' | 'None' {
    // Chromium: -1 unspecified, 0 NoRestriction (None), 1 Lax, 2 Strict
    if (v === 2) return 'Strict';
    if (v === 1) return 'Lax';
    return 'None';
}

async function main() {
    console.log('🍪 Chrome → .bot_profile cookie importer');
    console.log(`   User Data : ${USER_DATA}`);
    console.log(`   Profile   : ${PROFILE}`);
    console.log(`   Target    : ${BOT_PROFILE_DIR}`);
    console.log('');

    // ── 1) Master key ──
    const localStatePath = path.join(USER_DATA, 'Local State');
    if (!fs.existsSync(localStatePath)) throw new Error(`Local State not found: ${localStatePath}`);
    const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
    const encKeyB64 = localState?.os_crypt?.encrypted_key;
    if (!encKeyB64) throw new Error('os_crypt.encrypted_key missing in Local State');
    const encKey = Buffer.from(encKeyB64, 'base64');
    if (encKey.slice(0, 5).toString('utf8') !== 'DPAPI') throw new Error('expected DPAPI prefix on encrypted_key');
    const masterKey = dpapiUnprotect(encKey.slice(5));
    if (masterKey.length !== 32) throw new Error(`master key length ${masterKey.length}, expected 32`);
    console.log(`✅ master AES key recovered (${masterKey.length} bytes)`);

    // ── 2) Copy Cookies db to temp ──
    const cookiesPath = path.join(USER_DATA, PROFILE, 'Network', 'Cookies');
    if (!fs.existsSync(cookiesPath)) throw new Error(`Cookies db not found: ${cookiesPath}`);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-cookies-'));
    const tempDb = path.join(tempDir, 'Cookies');
    fs.copyFileSync(cookiesPath, tempDb);
    console.log(`✅ copied Cookies db to ${tempDb}`);

    // ── 3) Query cookies ──
    const db = new Database(tempDb, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`
        SELECT host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite
        FROM cookies
        WHERE host_key LIKE @filter
    `).all({ filter: DOMAIN_FILTER }) as any[];
    db.close();
    console.log(`📦 found ${rows.length} cookie row(s) for *yandex*`);

    // ── 4) Decrypt each ──
    const playwrightCookies: any[] = [];
    let v20Skipped = 0;
    let failed = 0;
    for (const r of rows) {
        const enc: Buffer = r.encrypted_value;
        if (!enc || enc.length < 32) { failed++; continue; }
        const prefix = enc.slice(0, 3).toString('utf8');
        if (prefix !== 'v10' && prefix !== 'v11') {
            if (prefix === 'v20') { v20Skipped++; continue; }
            failed++; continue;
        }
        try {
            const iv = enc.slice(3, 15);
            const ciphertext = enc.slice(15, enc.length - 16);
            const authTag = enc.slice(enc.length - 16);
            const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
            decipher.setAuthTag(authTag);
            let value = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
            // Chrome 110+ prepends 32-byte SHA256 hash of (host_key + name) before the value
            // in some installs — strip if it looks like binary noise.
            // Empirically: if first 32 bytes look non-printable, skip.
            if (value.length > 32 && /[\x00-\x08\x0E-\x1F]/.test(value.slice(0, 32))) {
                value = value.slice(32);
            }

            const expires = chromeTimeToUnix(r.expires_utc);
            // Playwright expects domain WITH leading dot for host-only-=false cookies; Chrome
            // already stores it that way (host_key like ".yandex.ru").
            playwrightCookies.push({
                name: r.name,
                value,
                domain: r.host_key,
                path: r.path || '/',
                expires: expires > 0 ? expires : -1,
                httpOnly: !!r.is_httponly,
                secure: !!r.is_secure,
                sameSite: samesiteFromInt(r.samesite),
            });
        } catch (e: any) {
            failed++;
        }
    }
    console.log(`🔓 decrypted ${playwrightCookies.length}, skipped v20 (App-Bound): ${v20Skipped}, failed: ${failed}`);
    if (v20Skipped > 0) {
        console.warn(`⚠️ ${v20Skipped} cookie(s) use Chrome 127+ App-Bound Encryption and cannot be decrypted here.`);
        console.warn(`   These are usually critical session cookies (Session_id, sessionid2 for Yandex).`);
        console.warn(`   If decrypted count is low and Yandex session doesn't carry — fall back to npm run login.`);
    }
    if (playwrightCookies.length === 0) throw new Error('no cookies extracted, aborting');

    // Cookie values are session credentials. Diagnostics may identify the
    // imported records, but must never print value bytes or prefixes.
    const sample = playwrightCookies.slice(0, 6).map(c => ({
        domain: c.domain,
        name: c.name,
        httpOnly: c.httpOnly,
        secure: c.secure,
    }));
    console.log('   imported cookie metadata (values redacted):', sample);

    // ── 5) Push into .bot_profile ──
    if (!fs.existsSync(BOT_PROFILE_DIR)) fs.mkdirSync(BOT_PROFILE_DIR, { recursive: true });
    console.log(`\n🚀 launching playwright with .bot_profile/ to persist cookies…`);
    const ctx = await chromium.launchPersistentContext(BOT_PROFILE_DIR, {
        headless: true,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--lang=ru-RU',
        ],
        locale: 'ru-RU',
    });
    await ctx.addCookies(playwrightCookies);
    await ctx.close();
    console.log(`✅ cookies persisted to ${BOT_PROFILE_DIR}`);

    // cleanup temp
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

main().catch((e) => {
    console.error('💥 import failed:', e);
    process.exit(1);
});
