import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

const entry = readFileSync('gravity-mvp/src/instrumentation.ts', 'utf8')
const runtime = readFileSync('gravity-mvp/src/instrumentation.node.ts', 'utf8')

// Execute the real transpiled entry and runtime in a sealed VM. All provider
// imports and timers are fakes; no database, network, signals or polling run.
async function execute(dispatcher, nodeSource, nextRuntime = 'nodejs') {
    const timeouts = []
    const intervals = []
    let starts = 0
    const token = Object.freeze({ outbox: true })
    const noop = () => undefined
    const generic = new Proxy({}, { get: (_, key) => key === '__esModule' ? true : key === 'then' ? undefined : noop })
    const modules = {
        '@/modules/platform-shell/public/v1': { prepareOutboundConversationV1: noop, startDomainOutboxPublisherV1: () => { starts++; return token } },
        '@/modules/operations-observability/public/v1/operational-job-registry': { registerOperationalIntervalV1: (value) => intervals.push(value), runOperationalJobV1: noop },
        '@/infrastructure/operations/operational-log': { operationalLogV1: noop },
        '@/lib/prisma': { prisma: { $queryRaw: noop, whatsAppConnection: { findMany: async () => [] } } },
    }
    const context = vm.createContext({
        process: { env: { NEXT_RUNTIME: nextRuntime, NODE_ENV: 'test' }, on: noop, stderr: { write: noop }, exit: noop },
        console: { log: noop, warn: noop, error: noop },
        setTimeout: (fn, delay) => { timeouts.push({ fn, delay }); return { unref: noop } },
        setInterval: () => ({ unref: noop }), clearTimeout: noop, clearInterval: noop,
    })
    function load(source) {
        const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
        const module = { exports: {} }
        const require = (id) => id === './instrumentation.node' ? load(nodeSource) : (modules[id] ?? generic)
        vm.runInContext('(function(require,module,exports){' + js + '\n})', context)(require, module, module.exports)
        return module.exports
    }
    await load(dispatcher).register()
    const boot = timeouts.filter((item) => item.delay === 5000)
    assert.equal(boot.length, 1, 'Node startup must schedule exactly one boot callback')
    await boot[0].fn()
    assert.equal(starts, 1, 'outbox publisher must start exactly once')
    assert.equal(intervals.filter((value) => value === token).length, 1, 'outbox interval must be registered once')
}

await execute(entry, runtime)
await assert.rejects(() => execute(entry.replace('await registerNodeRuntime()', 'return'), runtime))
await assert.rejects(() => execute(entry, runtime.replace('const outboxInterval = startDomainOutboxPublisherV1()', 'const outboxInterval = setInterval(() => {}, 2000)')))
await assert.rejects(() => execute(entry, runtime.replace('const outboxInterval = startDomainOutboxPublisherV1()', 'const outboxInterval = startDomainOutboxPublisherV1(); startDomainOutboxPublisherV1()')))
console.log('production outbox startup contract: PASS (positive and 3 negative cases)')
