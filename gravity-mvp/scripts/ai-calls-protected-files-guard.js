'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const DEFAULT_BASE = '8a95307d19a22a086794328496630962eae1b113'
const base = process.argv[2] || DEFAULT_BASE
const repoRoot = path.resolve(__dirname, '..', '..')

const allowedPrefixes = [
    'gravity-mvp/src/app/ai-calls/',
    'gravity-mvp/src/components/ai-calls/',
    'gravity-mvp/src/app/api/ai-calls/',
    'gravity-mvp/src/lib/ai-call/',
    'gravity-mvp/src/app/api/settings/ai-call-',
    'gravity-mvp/src/app/api/internal/ai-call-keys/',
    'gravity-mvp/src/app/settings/integrations/ai-call-',
    'tools/audio-bridge-day1/',
]

const allowedExact = new Set([
    'gravity-mvp/scripts/ai-calls-protected-files-guard.js',
])

function git(args) {
    return execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
}

function lines(output) {
    return output ? output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : []
}

function isAllowed(file) {
    const normalized = file.replaceAll('\\', '/')
    return allowedExact.has(normalized) || allowedPrefixes.some((prefix) => normalized.startsWith(prefix))
}

console.log(`AI Calls guard: verifying base ${base}`)
git(['cat-file', '-e', `${base}^{commit}`])

const changed = new Set([
    ...lines(git(['diff', '--name-only', base, '--'])),
    ...lines(git(['diff', '--cached', '--name-only', '--'])),
    ...lines(git(['ls-files', '--others', '--exclude-standard'])),
])

const violations = [...changed].filter((file) => !isAllowed(file)).sort()
console.log(`AI Calls guard: inspected ${changed.size} changed path(s)`)

if (violations.length) {
    console.error('AI Calls guard: BLOCKED — changes outside the approved AI Calls scope:')
    for (const file of violations) console.error(`- ${file}`)
    process.exitCode = 1
} else {
    console.log('AI Calls guard: PASS — protected/shared files are untouched')
}
