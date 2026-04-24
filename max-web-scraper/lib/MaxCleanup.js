'use strict'

/**
 * MAX session cleanup — reclaims state from zombie Playwright sessions.
 *
 * Problem: when the scraper exits uncleanly (taskkill, power loss,
 * Windows sleep, uncaughtException), Playwright-controlled Chromium
 * processes may remain alive holding file locks on user_data/. Next
 * startup then fails with:
 *    Error: The browser is already running for <userDataDir>.
 *    Use a different `userDataDir` or stop the running browser first.
 *
 * Mirrors gravity-mvp/src/lib/whatsapp/WhatsAppCleanup.ts — same idea,
 * different targets (user_data vs .wwebjs_auth).
 *
 * Called from index.js at startup BEFORE chromium.launchPersistentContext.
 */

const { execFile } = require('child_process')
const { promisify } = require('util')
const fs = require('fs/promises')
const path = require('path')

const execFileAsync = promisify(execFile)

const USER_DATA_DIR = path.join(__dirname, '..', 'user_data')

// Chrome's per-profile sentinels. Anything left after an unclean exit
// tells the next Chrome "profile already in use" — remove after killing.
const LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']

/**
 * Kill zombie Chrome processes belonging to max-web-scraper Playwright
 * sessions. Identified by --user-data-dir= pointing inside our
 * user_data folder. User's personal Chrome is never touched.
 * Windows-only (no-op on other OS — Linux/macOS don't have this issue).
 */
async function killZombieMaxChromes() {
    if (process.platform !== 'win32') return 0

    let pids = []
    try {
        // PowerShell CIM — works in NonInteractive mode, no elevation.
        // Filter by CommandLine containing our user_data path marker.
        // max-web-scraper is an unusual name; scanning for it in cmdline
        // avoids hitting the user's personal Chrome.
        const psCommand =
            "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
            "Where-Object { $_.CommandLine -match 'max-web-scraper' -and $_.CommandLine -match 'user_data' } | " +
            "Select-Object -ExpandProperty ProcessId"

        const { stdout } = await execFileAsync(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command', psCommand],
            { timeout: 15_000, windowsHide: true }
        )

        pids = stdout
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(s => s.length > 0)
            .map(s => parseInt(s, 10))
            .filter(n => Number.isFinite(n) && n > 0)
    } catch (err) {
        console.warn(`[MAX-CLEANUP] Failed to list chrome processes: ${err.message}`)
        return 0
    }

    if (pids.length === 0) return 0

    let killed = 0
    for (const pid of pids) {
        try {
            // process.kill on Windows calls TerminateProcess — works
            // without admin rights if we launched the process.
            process.kill(pid, 'SIGTERM')
            killed++
        } catch (err) {
            if (err.code !== 'ESRCH') {
                console.warn(`[MAX-CLEANUP] Failed to kill pid ${pid}: ${err.message}`)
            }
        }
    }

    if (killed > 0) {
        console.log(`[MAX-CLEANUP] Killed ${killed} zombie chrome processes (of ${pids.length} candidates)`)
    }
    return killed
}

/**
 * Remove stale lock files from user_data/.
 * Chrome regenerates them on next launch — safe to delete.
 */
async function removeSessionLocks() {
    let removed = 0

    // Top-level user_data
    for (const lockFile of LOCK_FILES) {
        const fullPath = path.join(USER_DATA_DIR, lockFile)
        try {
            await fs.unlink(fullPath)
            removed++
        } catch { /* ignore — missing is fine */ }
    }

    // Default profile subdirectory — Chrome keeps its own locks there too
    const defaultDir = path.join(USER_DATA_DIR, 'Default')
    for (const lockFile of LOCK_FILES) {
        const fullPath = path.join(defaultDir, lockFile)
        try {
            await fs.unlink(fullPath)
            removed++
        } catch { /* ignore */ }
    }

    if (removed > 0) {
        console.log(`[MAX-CLEANUP] Removed ${removed} stale lock files`)
    }
    return removed
}

/**
 * Full cleanup: kill zombies + remove stale locks.
 * Call from index.js before chromium.launchPersistentContext.
 */
async function cleanupStaleMaxSession() {
    const t0 = Date.now()
    const killedChromeCount = await killZombieMaxChromes()

    // Give Windows a beat to release file handles after kill.
    if (killedChromeCount > 0) {
        await new Promise(resolve => setTimeout(resolve, 1500))
    }

    const removedLockCount = await removeSessionLocks()
    const elapsed = Date.now() - t0
    console.log(`[MAX-CLEANUP] Done in ${elapsed}ms — killed=${killedChromeCount}, removedLocks=${removedLockCount}`)
    return { killedChromeCount, removedLockCount }
}

module.exports = {
    cleanupStaleMaxSession,
    killZombieMaxChromes,
    removeSessionLocks,
}
