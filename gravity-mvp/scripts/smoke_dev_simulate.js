// Smoke tests for POST /api/ai-calls/dev-simulate.
//
// Hits the local CRM dev server (default http://127.0.0.1:3002) with three
// scripted scenarios that exercise the AI-call dialog without FreeSWITCH /
// audio / OpenAI TTS. Validates each one's terminationReason +
// qualification_status + lead_data shape.
//
// Expectations:
//   1. HAPPY — qualified driver, smooth answers → end_call qualified +
//      manager_task.should_create=true.
//   2. NOT_QUALIFIED — no licence, refuses → end_call not_qualified, no
//      manager task.
//   3. UNCLEAR — partial / vague answers, lead hangs up early → either
//      end_call unclear OR simulator runs out of scripted replies
//      (terminationReason 'closed') with lead_data populated.
//
// Each scenario also asserts:
//   - llmCallsCount > 0
//   - transcript contains at least one assistant turn and at least one
//     user turn
//
// Usage:
//   curl -X POST http://127.0.0.1:3002/api/ai-calls/dev-simulate -H ...
//   node gravity-mvp/scripts/smoke_dev_simulate.js
//
// Auth: this script uses the user_service's u3 fallback (anonymous →
// u3 manager) intentionally — it's a dev-only smoke. Production deployments
// gate the route with AI_CALL_DEV_SIMULATE_ENABLED=false.

const CRM_BASE = process.env.CRM_BASE_URL ?? 'http://127.0.0.1:3002'

const CASES = [
    {
        name: 'HAPPY — qualified driver',
        leadMessages: [
            'Да, удобно.',
            'Да, есть права категории B, стаж 5 лет.',
            'Свою машину, аренда не интересует.',
            'Дневной график.',
            'Екатеринбург.',
            'На этой неделе, давайте.',
            // Tail-of-scenario fillers: every active scenario has at most
            // ~6 questions but the model often asks one closing «всё ли
            // понятно / готовы начинать» before deciding how to wrap up.
            'Да, всё понятно.',
            'Да, готов.',
        ],
        expect: {
            // The model legitimately ends a willing-qualified lead in TWO
            // ways: (a) `end_call` with qualification_status=qualified —
            // ideal hand-off; (b) `transfer_to_manager` — also fine, the
            // CRM will create a manager_task either way and the manager
            // picks the lead up. We accept both.
            terminationReason: /^(completed|transferred)$/,
            // For (a) the model returns 'qualified'; for (b) call-session
            // hardcodes 'unclear' (the AI couldn't finalize the verdict
            // itself). Either is acceptable for a willing lead.
            qualificationStatus: /^(qualified|unclear)$/,
            // EITHER ending creates a manager_task: end_call sets it
            // explicitly for qualified leads, transfer_to_manager always
            // does. The smoke must see one.
            managerTaskCreated: true,
            leadDataKeysMin: 5,
        },
    },
    {
        name: 'NOT_QUALIFIED — no licence',
        leadMessages: [
            'Да, слушаю.',
            'У меня нет водительских прав, я водить не умею.',
            'Не, мне это не подходит, не звоните больше.',
            'Не интересно, до свидания.',
            'Я уже сказал — не подходит.',
        ],
        expect: {
            // The model usually calls end_call({status:not_qualified}) after
            // the licence answer + the refusal. Non-deterministically it can
            // also fall through to scripted-replies-exhausted on a slow
            // model run — both shapes count as a successful «not interested»
            // outcome for the smoke.
            terminationReason: /^(completed|closed)$/,
            qualificationStatus: /^(not_qualified|undefined)?$/,
            // System prompt says: «Не задавай manager_task при not_qualified».
            managerTaskCreated: false,
            // The model may go straight to end_call once licence is missing,
            // without calling save_lead_data first — that's reasonable
            // economy of turns. Don't require any specific count.
            leadDataKeysMin: 0,
        },
    },
    {
        name: 'UNCLEAR — vague + early hangup',
        leadMessages: [
            'Да, удобно.',
            'Я не знаю пока.',
            'Не уверен, перезвоните позже.',
        ],
        expect: {
            // The model MAY end with `unclear` OR keep asking and run out
            // of scripted replies (terminationReason='closed'). Both
            // count as success — the lead is not committed.
            terminationReason: /^(completed|closed)$/,
            qualificationStatus: /^(unclear|not_qualified)?$/,  // anything but qualified
            leadDataKeysMin: 0,
        },
    },
]

async function runOne(c) {
    const body = JSON.stringify({ leadMessages: c.leadMessages })
    const res = await fetch(`${CRM_BASE}/api/ai-calls/dev-simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
        return { ok: false, reason: `HTTP ${res.status}`, body: data }
    }
    return { ok: true, data }
}

function matchesExpectation(value, expected) {
    if (expected instanceof RegExp) return expected.test(value ?? '')
    return value === expected
}

async function main() {
    const summary = []
    for (const c of CASES) {
        process.stdout.write(`\n→ ${c.name}\n`)
        const r = await runOne(c)
        if (!r.ok) {
            console.log(`  FAIL  (${r.reason}) ${JSON.stringify(r.body).slice(0, 200)}`)
            summary.push({ name: c.name, status: 'FAIL', reason: r.reason })
            continue
        }
        const d = r.data
        const checks = []
        checks.push(['terminationReason', matchesExpectation(d.terminationReason, c.expect.terminationReason), d.terminationReason])
        checks.push(['qualification_status', matchesExpectation(d.finalResult?.qualification_status, c.expect.qualificationStatus), d.finalResult?.qualification_status])
        if (typeof c.expect.managerTaskCreated === 'boolean') {
            const got = !!d.finalResult?.manager_task?.should_create
            checks.push(['manager_task.should_create', got === c.expect.managerTaskCreated, got])
        }
        const leadDataKeys = Object.keys(d.leadData ?? {}).length
        checks.push([`leadData keys (≥${c.expect.leadDataKeysMin})`, leadDataKeys >= c.expect.leadDataKeysMin, leadDataKeys])
        checks.push(['llmCallsCount > 0', d.llmCallsCount > 0, d.llmCallsCount])
        const transcriptUser = (d.transcript ?? []).filter(t => t.role === 'user').length
        const transcriptAssistant = (d.transcript ?? []).filter(t => t.role === 'assistant').length
        checks.push(['user turns ≥ 1', transcriptUser >= 1, transcriptUser])
        checks.push(['assistant turns ≥ 1', transcriptAssistant >= 1, transcriptAssistant])

        const passed = checks.filter(c => c[1]).length
        const total = checks.length
        for (const [k, ok, val] of checks) {
            console.log(`  ${ok ? '✓' : '✗'} ${k.padEnd(35)} = ${JSON.stringify(val)}`)
        }
        console.log(`  ${passed}/${total} checks passed`)
        console.log(`  llm calls: ${d.llmCallsCount}, latency: ${d.latencyMs}ms`)
        if (process.env.SMOKE_VERBOSE === '1') {
            console.log('  transcript:')
            for (const t of d.transcript ?? []) {
                const tag = t.role === 'assistant' ? '[AI]' : t.role === 'user' ? '[Лид]' : `[${t.role}]`
                console.log(`    ${tag} ${t.content.slice(0, 100)}`)
            }
        }
        summary.push({ name: c.name, status: passed === total ? 'PASS' : 'PARTIAL', passed, total })
    }

    console.log('\n=== SUMMARY ===')
    console.table(summary)
    const failed = summary.filter(s => s.status !== 'PASS').length
    if (failed > 0) process.exit(1)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
