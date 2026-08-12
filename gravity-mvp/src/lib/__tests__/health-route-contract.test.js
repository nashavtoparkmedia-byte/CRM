'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const route = fs.readFileSync(path.join(__dirname, '../../app/api/health/route.ts'), 'utf8')

test('stuck-message health predicate matches recovery exclusions', () => {
    assert.match(
        route,
        /status = 'sent' AND "externalId" IS NULL AND type <> 'call' AND "sentAt" < \$\{cutoffStuck\}/,
    )
})
