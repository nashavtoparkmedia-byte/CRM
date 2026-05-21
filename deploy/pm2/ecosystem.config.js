// PM2 ecosystem config for the AI-call platform.
//
// Usage:
//   npm install -g pm2
//   pm2 install pm2-logrotate         # optional but recommended
//   pm2 start deploy/pm2/ecosystem.config.js
//   pm2 save                          # persist apps list across reboot
//   pm2 startup                       # emit init-system hook
//
// Paths assume the repo lives at /srv/crm/CRM/. Adjust per host.

module.exports = {
    apps: [
        // ───────────────────────────────────────────────────────────
        // CRM — Next.js production server.
        // Boot time is dominated by Prisma client init + analyze
        // worker registration (instrumentation.ts). ~3–5 s on a
        // healthy box.
        // ───────────────────────────────────────────────────────────
        {
            name: 'crm',
            cwd: '/srv/crm/CRM/gravity-mvp',
            script: 'npm',
            args: 'start',

            // Restart policy mirrors systemd / NSSM: limited retries,
            // operator must intervene on persistent failures.
            restart_delay: 5000,
            max_restarts: 5,
            min_uptime: '60s',

            // Catch a memory leak before the OOMKiller does. 1 GB is
            // generous for the CRM's WA/TG/Puppeteer surface; tune
            // down to 768 MB if the host is small.
            max_memory_restart: '1G',

            // Graceful shutdown — PM2 sends SIGINT, then SIGKILL after
            // kill_timeout. instrumentation.ts's own 10 s timer fires
            // inside this window.
            kill_timeout: 15000,

            // Logs. pm2-logrotate (if installed) handles rotation per
            // its own config (`pm2 set pm2-logrotate:max_size 10M`).
            error_file: '/var/log/crm/crm.err.log',
            out_file:   '/var/log/crm/crm.out.log',
            merge_logs: true,
            time: true,                 // prepend ISO timestamp to each line

            env: {
                NODE_ENV: 'production',
                // Real secrets belong in a sibling .env file referenced
                // by next-env, NOT inline here. Keep this map env-shape
                // only (paths, flags), no API keys.
            },
        },

        // ───────────────────────────────────────────────────────────
        // AudioBridge — Node, mod_audio_fork ↔ STT/LLM/TTS.
        // Boot time ~1 s. Lighter memory profile than CRM.
        // ───────────────────────────────────────────────────────────
        {
            name: 'audio-bridge',
            cwd: '/srv/crm/CRM/tools/audio-bridge-day1',
            script: 'server.js',
            interpreter: 'node',

            restart_delay: 5000,
            max_restarts: 5,
            min_uptime: '60s',

            max_memory_restart: '512M',

            // Bridge has its own SIGTERM/SIGINT handlers (server.js:850-851).
            // The bridge's in-memory `sessions` Map dies with the process —
            // intentional, documented in deployment.md §6.
            kill_timeout: 10000,

            error_file: '/var/log/crm/audio-bridge.err.log',
            out_file:   '/var/log/crm/audio-bridge.out.log',
            merge_logs: true,
            time: true,

            env: {
                NODE_ENV: 'production',
                // Per-host overrides go here (CRM_BASE_URL, proxy
                // settings, YANDEX_STT_TIMEOUT_MS, etc.).
            },
        },
    ],
}
