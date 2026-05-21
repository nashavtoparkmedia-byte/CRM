// Bring up the local infra the AI-call persistence layer needs: Redis
// (for BullMQ queues) and MinIO (for recording storage). Idempotent —
// safe to run every time; will start whatever's missing and create the
// recordings bucket. Works on a WSL2 + Windows host setup; in prod
// the Docker compose under telephony/ does the same containerised.
//
// Run from gravity-mvp/: `node scripts/ensure_local_infra.js`
// Or from anywhere: `node gravity-mvp/scripts/ensure_local_infra.js`
//
// Exit 0 if both Redis and MinIO are reachable when the script returns.

const net = require('net')
const { spawnSync } = require('child_process')
const path = require('path')

function ping(host, port, timeoutMs = 800) {
    return new Promise(resolve => {
        const sock = net.createConnection({ host, port })
        const done = ok => { try { sock.destroy() } catch {} ; resolve(ok) }
        sock.on('connect', () => done(true))
        sock.on('error', () => done(false))
        setTimeout(() => done(false), timeoutMs)
    })
}

function wsl(cmd) {
    const r = spawnSync('wsl.exe', ['-d', 'Ubuntu-24.04', '-u', 'root', 'bash', '-c', cmd], { encoding: 'utf8' })
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status }
}

async function ensureRedis() {
    if (await ping('127.0.0.1', 6379)) return { state: 'already-up' }
    console.log('[infra] Redis :6379 down — starting in WSL')
    const r = wsl('service redis-server start 2>&1 || systemctl start redis-server 2>&1; sleep 1; redis-cli ping')
    const ok = /PONG/.test(r.stdout)
    return { state: ok ? 'started' : 'failed', detail: r.stdout.trim() }
}

async function ensureMinio() {
    if (await ping('127.0.0.1', 9000)) return { state: 'already-up' }
    console.log('[infra] MinIO :9000 down — starting in WSL')
    // Idempotent: if binary missing, download; then nohup-start.
    const startScript =
        'if [ ! -f /usr/local/bin/minio ]; then ' +
        '  curl -sSL -o /usr/local/bin/minio https://dl.min.io/server/minio/release/linux-amd64/minio && ' +
        '  chmod +x /usr/local/bin/minio; ' +
        'fi; ' +
        'mkdir -p /var/lib/minio-data; ' +
        'pkill -f "minio server" 2>/dev/null; sleep 0.3; ' +
        'MINIO_ROOT_USER=crmadmin MINIO_ROOT_PASSWORD=crmpassword123 ' +
        '  nohup /usr/local/bin/minio server /var/lib/minio-data ' +
        '  --console-address ":9001" --address ":9000" > /var/log/minio.log 2>&1 &'
    wsl(startScript)
    // Wait up to 15 s for the health endpoint.
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500))
        const h = wsl('curl -sf http://127.0.0.1:9000/minio/health/live; echo $?')
        if (/^0$/m.test(h.stdout)) return { state: 'started' }
    }
    return { state: 'failed', detail: 'health check did not turn green in 15 s' }
}

async function ensureBucket() {
    const r = spawnSync('node', [path.join(__dirname, 'ensure_recordings_bucket.js')], { encoding: 'utf8' })
    return { state: r.status === 0 ? 'ok' : 'failed', detail: (r.stdout + r.stderr).trim() }
}

async function main() {
    console.log('== ensure_local_infra ==')
    const r1 = await ensureRedis()
    console.log(`[redis ] ${r1.state}${r1.detail ? ' — ' + r1.detail : ''}`)
    const r2 = await ensureMinio()
    console.log(`[minio ] ${r2.state}${r2.detail ? ' — ' + r2.detail : ''}`)
    if (r2.state === 'failed') { process.exit(1); return }
    const r3 = await ensureBucket()
    console.log(`[bucket] ${r3.state} — ${r3.detail}`)

    const finalOk =
        (await ping('127.0.0.1', 6379)) &&
        (await ping('127.0.0.1', 9000)) &&
        r3.state === 'ok'
    console.log(`\n== ${finalOk ? 'READY' : 'NOT_READY'} ==`)
    process.exit(finalOk ? 0 : 1)
}

main().catch(err => { console.error('FATAL:', err); process.exit(2) })
