// Parse tcpdump text output for RTP pacing analysis.
//
// Expected input on stdin: lines from `tcpdump -tttt -nn -q -r <pcap> "src host <FS_IP>"`
//
// Each line has the absolute timestamp in the format
//   YYYY-MM-DD HH:MM:SS.uuuuuu IP <src>.<port> > <dst>.<port>: UDP, length N
//
// We extract the timestamp, compute inter-packet deltas, and report
// statistics that characterise RTP pacing:
//   - count of packets
//   - expected delta (for G.711 @ 20 ms = 20000 µs)
//   - mean / median / stddev / min / max delta
//   - distribution histogram (bucketed by delta range)
//   - count of "late" packets (delta > expected + 5 ms) — these are
//     candidates for choppy bot voice symptoms
//   - count of "bursts" (delta < expected/2) — packet groups sent back-
//     to-back, also a choppy symptom
//
// Usage:
//   wsl -d Ubuntu-24.04 -u root tcpdump -tttt -nn -q -r /dev/shm/test-23/rtp.pcap "src host 192.168.0.102" | node scripts/analyze_rtp_pacing.js

const EXPECTED_MS = 20  // G.711 packetisation interval

function main() {
    let raw = ''
    process.stdin.on('data', d => { raw += d.toString() })
    process.stdin.on('end', () => {
        const lines = raw.split('\n').filter(Boolean)
        const stamps = []
        for (const line of lines) {
            // 2026-05-18 22:58:42.123456 IP 192.168.0.102.20106 > 193.201.229.35.16384: UDP, length 172
            const m = line.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\.(\d{6})/)
            if (!m) continue
            const [, d, t, us] = m
            const dt = new Date(`${d}T${t}Z`).getTime()
            const totalUs = dt * 1000 + Number(us)
            stamps.push(totalUs)
        }
        if (stamps.length < 2) {
            console.log(`only ${stamps.length} packets parsed — not enough to analyze`)
            return
        }
        stamps.sort((a, b) => a - b)

        const deltas = []
        for (let i = 1; i < stamps.length; i++) {
            deltas.push((stamps[i] - stamps[i - 1]) / 1000)  // ms
        }

        const n = deltas.length
        const sum = deltas.reduce((a, b) => a + b, 0)
        const mean = sum / n
        const sorted = [...deltas].sort((a, b) => a - b)
        const median = sorted[Math.floor(n / 2)]
        const min = sorted[0]
        const max = sorted[n - 1]
        const variance = deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / n
        const stddev = Math.sqrt(variance)

        // Counts
        const late = deltas.filter(d => d > EXPECTED_MS + 5)
        const veryLate = deltas.filter(d => d > EXPECTED_MS * 2)
        const burst = deltas.filter(d => d < EXPECTED_MS / 2)
        const onTime = deltas.filter(d => Math.abs(d - EXPECTED_MS) <= 2)

        console.log(`packets:           ${stamps.length}`)
        console.log(`inter-packet deltas: ${n}`)
        console.log(`expected delta:    ${EXPECTED_MS} ms`)
        console.log()
        console.log(`mean:              ${mean.toFixed(3)} ms`)
        console.log(`median:            ${median.toFixed(3)} ms`)
        console.log(`stddev:            ${stddev.toFixed(3)} ms`)
        console.log(`min:               ${min.toFixed(3)} ms`)
        console.log(`max:               ${max.toFixed(3)} ms`)
        console.log()
        console.log(`on-time (Δ-20ms ≤2): ${onTime.length} (${(100 * onTime.length / n).toFixed(1)}%)`)
        console.log(`late    (Δ > 25 ms): ${late.length}     (${(100 * late.length / n).toFixed(1)}%)`)
        console.log(`v-late  (Δ > 40 ms): ${veryLate.length}     (${(100 * veryLate.length / n).toFixed(1)}%)`)
        console.log(`burst   (Δ < 10 ms): ${burst.length}     (${(100 * burst.length / n).toFixed(1)}%)`)
        console.log()
        console.log(`top 10 worst deltas (ms): ${sorted.slice(-10).map(x => x.toFixed(1)).join(', ')}`)

        // Bucket histogram (5 ms buckets up to 60 ms)
        console.log()
        console.log('delta histogram:')
        const buckets = {}
        for (const d of deltas) {
            const b = Math.floor(d / 5) * 5
            const key = b >= 60 ? '60+' : `${b}-${b + 5}`
            buckets[key] = (buckets[key] ?? 0) + 1
        }
        for (const key of Object.keys(buckets).sort((a, b) => {
            const av = a === '60+' ? 60 : Number(a.split('-')[0])
            const bv = b === '60+' ? 60 : Number(b.split('-')[0])
            return av - bv
        })) {
            const cnt = buckets[key]
            const bar = '#'.repeat(Math.min(60, Math.round(cnt * 60 / n)))
            console.log(`  ${key.padEnd(7)} ${String(cnt).padStart(5)}  ${bar}`)
        }
    })
}

main()
