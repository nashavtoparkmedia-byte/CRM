#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanArchitecture } from './enforce-architecture.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function stable(value) {
    if (Array.isArray(value)) return value.map(stable)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

function digest(value) {
    return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

async function loadJson(relative) {
    return JSON.parse(await readFile(path.join(repositoryRoot, relative), 'utf8'))
}

function dependencyReferences(finding, transitions) {
    if (!finding.target_context) return []
    const matches = transitions.current_relationships.filter((relationship) => (
        relationship.source_context === finding.source_context
        && relationship.target_context === finding.target_context
    ))
    return matches.map((relationship) => (
        `dependency:${relationship.source_context}/${relationship.source_module}`
        + `>${relationship.target_context}/${relationship.target_module}`
    )).sort()
}

function writeReferences(finding, plan) {
    const model = finding.details?.model
    const method = finding.details?.method
    return plan.plans.filter((candidate) => {
        if (!candidate.sites.some((site) => site.file === finding.file && (!method || site.method === method))) return false
        return !model || candidate.models.includes(model)
    }).map((candidate) => candidate.id).sort()
}

const exceptionTemplates = {
    direct_foreign_prisma_write: {
        rationale: 'Pre-existing foreign or ambiguous persistence write inventoried before enforcement; no new site is permitted.',
        retirement: 'Replace this exact site with the owning context public command, verify parity, then delete this exception in the same change.',
    },
    direct_provider_transport_access: {
        rationale: 'Pre-existing provider transport access outside the provider-owning context; frozen as migration debt.',
        retirement: 'Move transport access behind the provider-owning context public adapter, verify behavior parity, then delete this exception.',
    },
    internal_module_import: {
        rationale: 'Pre-existing cross-context import of owner-internal implementation; frozen as migration debt.',
        retirement: 'Replace this exact import with a versioned owner public surface or relocate orchestration, then delete this exception.',
    },
    non_public_cross_context_import: {
        rationale: 'Pre-existing cross-context import that bypasses a versioned public surface; frozen as migration debt.',
        retirement: 'Route this exact dependency through a versioned target-context public surface, then delete this exception.',
    },
    undeclared_dependency: {
        rationale: 'Pre-existing dependency not authorized by the source context manifest; frozen pending architectural transition.',
        retirement: 'Remove the dependency or approve a versioned public dependency through manifest review, then delete this exception.',
    },
    disallowed_credential_access: {
        rationale: 'Pre-existing sensitive configuration access outside declared context credential ownership; frozen for isolation.',
        retirement: 'Move credential access into the declared owning adapter and pass only a secret-free result, then delete this exception.',
    },
}

async function main() {
    const outputFlag = process.argv.indexOf('--output')
    if (outputFlag === -1 || !process.argv[outputFlag + 1]) {
        throw new Error('usage: generate-architecture-exceptions.mjs --output <repository-relative-path>')
    }
    const output = process.argv[outputFlag + 1]
    if (path.isAbsolute(output) || output.startsWith('../') || output.includes('/../')) {
        throw new Error('output must be a repository-relative path')
    }

    const [scan, writePlan, transitions] = await Promise.all([
        scanArchitecture(repositoryRoot),
        loadJson('architecture/contexts/v1/foreign-write-migration-plan.json'),
        loadJson('architecture/contexts/v1/dependency-transition-plan.json'),
    ])
    const forbidden = new Set(scan.policy.unexceptionable_rules)
    const unexceptionable = scan.findings.filter((finding) => forbidden.has(finding.rule))
    if (unexceptionable.length > 0) {
        throw new Error(`refusing to baseline ${unexceptionable.length} unexceptionable violation(s)`)
    }

    const exceptions = scan.findings.map((finding) => {
        const template = exceptionTemplates[finding.rule]
        if (!template) throw new Error(`no reviewed exception policy for ${finding.rule}`)
        const references = finding.rule === 'direct_foreign_prisma_write'
            ? writeReferences(finding, writePlan)
            : dependencyReferences(finding, transitions)
        if (finding.rule === 'direct_foreign_prisma_write' && references.length === 0) {
            references.push(`CRM-ARCH-006-supplement:${finding.fingerprint}`)
        }
        if (finding.rule === 'direct_provider_transport_access') {
            references.push(`provider-boundary:${finding.details.provider}`)
        }
        return {
            fingerprint: finding.fingerprint,
            rule: finding.rule,
            file: finding.file,
            line_at_baseline: finding.line,
            ordinal: finding.ordinal,
            owner_context: finding.source_context,
            target_context: finding.target_context,
            subject: finding.subject,
            rationale: template.rationale,
            retirement: template.retirement,
            expires_on: scan.policy.exception_review_deadline,
            migration_references: [...new Set(references)].sort(),
        }
    })

    const registry = {
        schema: 'yoko.crm.architecture-exception-registry.v1',
        version: 1,
        milestone: scan.policy.registry_milestone,
        base_commit: scan.policy.registry_base_commit,
        generated_from: 'current source tree bound by finding_digest',
        finding_digest: digest(scan.findings),
        policy: {
            exact_fingerprint_only: true,
            stale_exceptions_fail: true,
            expired_exceptions_fail: true,
            uncovered_violations_fail: true,
            deadline: scan.policy.exception_review_deadline,
        },
        summary: Object.fromEntries([...new Set(exceptions.map((item) => item.rule))].sort().map((rule) => [
            rule,
            exceptions.filter((item) => item.rule === rule).length,
        ])),
        exceptions,
    }
    await writeFile(path.join(repositoryRoot, output), `${JSON.stringify(registry, null, 2)}\n`, { flag: 'w' })
    process.stdout.write(`${JSON.stringify({ output, exceptions: exceptions.length, finding_digest: registry.finding_digest, summary: registry.summary }, null, 2)}\n`)
}

main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
})
