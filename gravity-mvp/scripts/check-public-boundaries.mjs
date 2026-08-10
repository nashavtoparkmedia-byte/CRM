#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(appRoot, '..')
const requireBuild = process.argv.includes('--require-build')

const removedRoute = join(appRoot, 'src/app/api/debug-db/list-connections/route.ts')
assert.equal(existsSync(removedRoute), false, 'credential-leaking list-connections route must be absent')

const removedCleanupRoute = join(appRoot, 'src/app/api/debug-db/cleanup-chats/route.ts')
assert.equal(existsSync(removedCleanupRoute), false, 'foreign-writing cleanup-chats route must be absent')

const proxySource = readFileSync(join(appRoot, 'src/proxy.ts'), 'utf8')
assert.match(proxySource, /matcher:\s*\[\s*['"]\/api\/debug-db\/:path\*['"]\s*\]/)
assert.match(proxySource, /status:\s*404/)

const nginxSource = readFileSync(join(repositoryRoot, 'deploy/nginx/templates/crm.conf.template'), 'utf8')
const nginxDenials = nginxSource.match(/location\s+\^~\s+\/api\/debug-db\s*\{[\s\S]*?return\s+404\s*;/g) ?? []
assert.equal(nginxDenials.length, 2, 'both public CRM TLS virtual hosts must deny /api/debug-db')

const cookieImporter = readFileSync(
    join(repositoryRoot, 'yandex-fleet-scraper/src/scripts/import-chrome-cookies.ts'),
    'utf8',
)
assert.doesNotMatch(
    cookieImporter,
    /(?:console\.|sample[\s\S]{0,240})[^\n]*(?:\.value\b|value\s*[:=]).*(?:slice|substring|substr|console)/i,
    'Chrome cookie diagnostics must not emit decrypted value bytes or prefixes',
)
assert.match(
    cookieImporter,
    /imported cookie metadata \(values redacted\)/,
    'Chrome cookie diagnostics must explicitly identify their redacted metadata output',
)

function walk(directory) {
    if (!existsSync(directory)) return []
    return readdirSync(directory).flatMap(name => {
        const path = join(directory, name)
        return statSync(path).isDirectory() ? walk(path) : [path]
    })
}

const builtAppRoot = join(appRoot, '.next/server/app')
const builtRoutes = walk(builtAppRoot)
    .map(path => relative(builtAppRoot, path).replaceAll('\\', '/'))
if (requireBuild) {
    const leakedBuiltRoute = builtRoutes.find(path => path.startsWith('api/debug-db/list-connections/'))
    assert.equal(leakedBuiltRoute, undefined, 'removed debug connection route must not exist in built app output')
    const leakedCleanupRoute = builtRoutes.find(path => path.startsWith('api/debug-db/cleanup-chats/'))
    assert.equal(leakedCleanupRoute, undefined, 'removed debug cleanup route must not exist in built app output')
}

const routingManifestPaths = [
    join(appRoot, '.next/server/middleware-manifest.json'),
    join(appRoot, '.next/server/functions-config-manifest.json'),
].filter(existsSync)
if (requireBuild) {
    assert.ok(routingManifestPaths.length > 0, 'Next middleware/proxy manifest is required after build')
}

if (routingManifestPaths.length > 0) {
    const regexps = []
    const visit = value => {
        if (Array.isArray(value)) return value.forEach(visit)
        if (value === null || typeof value !== 'object') return
        for (const [key, entry] of Object.entries(value)) {
            if (key === 'regexp' && typeof entry === 'string') regexps.push(entry)
            else visit(entry)
        }
    }
    for (const manifestPath of routingManifestPaths) {
        visit(JSON.parse(readFileSync(manifestPath, 'utf8')))
    }
    const isBlockedByBuiltProxy = regexps.some(regexp => {
        try {
            const matcher = new RegExp(regexp)
            return matcher.test('/api/debug-db') && matcher.test('/api/debug-db/list-connections')
        } catch {
            return false
        }
    })
    assert.ok(isBlockedByBuiltProxy, 'built proxy manifest must cover the complete /api/debug-db prefix')
}

console.log(`public-boundary-check: PASS (${requireBuild ? 'source+build' : 'source'})`)
