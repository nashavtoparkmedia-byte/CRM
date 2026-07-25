'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { runLoopbackSuite } = require('../scripts/dev-loopback/harness')

test('real child-process WebSocket bridge passes DEV loopback scenarios A-J', async () => {
    const report = await runLoopbackSuite({ quiet: true })

    assert.equal(report.status, 'REAL-TIME AUDIO LOOPBACK PASS')
    assert.deepEqual(report.scenarios.map(scenario => scenario.id), [
        'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J',
    ])
    assert.ok(report.scenarios.every(scenario => scenario.status === 'PASS'))
    assert.ok(report.scenarios.every(scenario => scenario.cleanup === 'released'))
    assert.equal(report.devRuntime.bindAddress, '127.0.0.1')
    assert.equal(report.devRuntime.productionSecretsUsed, false)
    assert.equal(report.devRuntime.productionBridgeTrafficUsed, false)
    assert.equal(report.devRuntime.portReleased, true)
    assert.equal(report.devRuntime.orphanProcessCount, 0)
    assert.equal(report.devRuntime.maxOldSpaceMiB, 64)
    assert.ok(report.devRuntime.rssBytesAtMetrics <= report.devRuntime.maxRssBytes)
    assert.equal(report.aggregateMetrics.missingFrames, 0)
    assert.equal(report.aggregateMetrics.scope, 'A-J only; authentication preflight excluded')
    assert.equal(
        report.aggregateMetrics.latency.samples,
        report.aggregateMetrics.framesSent,
    )
    assert.ok(report.aggregateMetrics.reconnects >= 1)
    assert.ok(report.aggregateMetrics.timeouts >= 1)
    assert.equal(report.runtimeTotals.sessions, report.aggregateMetrics.sessions + 1)
    assert.ok(report.runtimeTotals.reconnects >= 2)
    assert.ok(report.scenarios.every(scenario => scenario.sessionMetrics.length >= 1))
    assert.ok(
        report.scenarios.find(scenario => scenario.id === 'B').droppedOnCleanup > 0,
    )
    assert.ok(report.securityEvidence.authFailures >= 1)
    assert.ok(report.securityEvidence.sessionConflicts >= 2)
    assert.equal(report.securityEvidence.tokenPersisted, false)
    assert.equal(report.securityEvidence.tokenLogged, false)
})
