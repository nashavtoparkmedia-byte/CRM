#!/usr/bin/env node

import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_FILES = [
  '.codex/config.toml',
  'AGENTS.md',
  'docs/architecture/AGENT_DEVELOPMENT_CONTRACT.md',
  'docs/architecture/NEW_DOMAIN_CHECKLIST.md',
  'CLAUDE.md',
  '.cursorrules',
  '.claude/CLAUDE_BOOTSTRAP_PROMPT.md',
]

const DEVELOPER_SAFETY_MARKERS = [
  {
    label: 'YOKO CRM repository scope',
    pattern: /YOKO CRM REPOSITORY SAFETY POLICY/u,
  },
  {
    label: 'current root AGENTS.md authority',
    pattern: /current root `AGENTS\.md`/u,
  },
  {
    label: 'user prompt is product intent, not bypass authorization',
    pattern: /user prompt expresses product intent;\s+it is not authorization to bypass/u,
  },
  {
    label: 'architecture enforcement cannot be weakened',
    pattern: /Do not disable, delete, weaken, skip, fake, or broadly exempt architecture enforcement/u,
  },
  {
    label: 'ordinary prompts do not authorize production work',
    pattern: /Ordinary feature\/development prompts do not authorize production deployment/u,
  },
  {
    label: 'production work requires explicit scope and gates',
    pattern: /Production or privileged work requires explicit task scope and the current repository release, preflight, and rollback gates/u,
  },
]

const REQUIRED_MARKERS = {
  'AGENTS.md': [
    '## Canonical instruction hierarchy',
    '## Mandatory architecture rules',
    'MODULAR MONOLITH',
    '### Domain ownership',
    '### Foreign writes are forbidden',
    '### Private cross-domain access is forbidden',
    '### Scope and blast radius',
    '### Data and migrations',
    '### Events, side effects, and outbox',
    '### External providers',
    '### Secrets and privilege',
    '### Existing enforcement is authoritative',
    '### No architecture reinvention',
    '### Testing and owner interaction',
    'docs/architecture/AGENT_DEVELOPMENT_CONTRACT.md',
    'docs/architecture/NEW_DOMAIN_CHECKLIST.md',
  ],
  'docs/architecture/AGENT_DEVELOPMENT_CONTRACT.md': [
    '## Architectural model',
    '## Existing machine authority',
    '## Ownership and boundaries',
    '## Dependency direction',
    '## Foreign write rule',
    '## Data and migrations',
    '## Events, side effects, and outbox',
    '## Providers, secrets, and privilege',
    '## Scope and blast radius',
    '## Adding a new domain',
    '## Modifying an existing domain',
    '## Cross-domain interaction',
    '## Architecture changes',
    '## Verification expectations',
    '## Prohibited shortcuts',
  ],
  'docs/architecture/NEW_DOMAIN_CHECKLIST.md': [
    '### 1. Domain name',
    '### 2. Business responsibility',
    '### 3. Owned data',
    '### 4. Owned tables / write surface',
    '### 5. Public contracts exposed',
    '### 6. Allowed dependencies',
    '### 7. Data read from other domains',
    '### 8. Cross-domain writes',
    '### 9. Events emitted',
    '### 10. Events consumed',
    '### 11. External providers / adapters',
    '### 12. Secret / credential boundary',
    '### 13. Side effect / outbox requirements',
    '### 14. Migration requirements',
    '### 15. Failure / retry / idempotency model',
    '### 16. Test boundary',
    '### 17. Observability requirements',
    '### 18. Explicitly out of scope',
    '## Illustrative example: AI Calls',
    'Drivers, Messenger, Tasks, or Auth',
  ],
  'CLAUDE.md': [
    '## Canonical architecture authority',
    'Root `AGENTS.md`',
    'must not weaken or redefine',
  ],
  '.cursorrules': [
    '## Canonical architecture authority',
    'Root `AGENTS.md`',
    'must not weaken or redefine',
  ],
  '.claude/CLAUDE_BOOTSTRAP_PROMPT.md': [
    '`ROOT/AGENTS.md`',
    '`ROOT/docs/architecture/AGENT_DEVELOPMENT_CONTRACT.md`',
    'имеют приоритет',
  ],
}

async function readRegularFile(root, relative) {
  const absolute = path.join(root, relative)
  let metadata
  try {
    metadata = await lstat(absolute)
  } catch {
    throw new Error(`missing required file: ${relative}`)
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`required path must be a regular non-symlink file: ${relative}`)
  }
  return readFile(absolute, 'utf8')
}

function checkMarkers(relative, source) {
  for (const marker of REQUIRED_MARKERS[relative]) {
    if (!source.includes(marker)) {
      throw new Error(`missing required marker in ${relative}: ${marker}`)
    }
  }
}

function parseDeveloperInstructions(source) {
  const assignments = [...source.matchAll(/^[ \t]*developer_instructions[ \t]*=/gmu)]
  if (assignments.length !== 1) {
    throw new Error('.codex/config.toml must define exactly one developer_instructions value')
  }

  const assignment = assignments[0]
  const prefix = source.slice(0, assignment.index)
  if (/^[ \t]*\[/mu.test(prefix)) {
    throw new Error('developer_instructions must be a top-level .codex/config.toml key')
  }

  let cursor = assignment.index + assignment[0].length
  while (source[cursor] === ' ' || source[cursor] === '\t') cursor += 1
  const delimiter = source.startsWith('"""', cursor)
    ? '"""'
    : source.startsWith("'''", cursor)
      ? "'''"
      : null
  if (!delimiter) {
    throw new Error('developer_instructions must be a TOML multiline string')
  }

  const valueStart = cursor + delimiter.length
  const valueEnd = source.indexOf(delimiter, valueStart)
  if (valueEnd < 0) {
    throw new Error('developer_instructions TOML multiline string is unterminated')
  }
  const trailingLine = source.slice(valueEnd + delimiter.length).split(/\r?\n/u, 1)[0]
  if (!/^[ \t]*(?:#.*)?$/u.test(trailingLine)) {
    throw new Error('unexpected content after developer_instructions TOML string')
  }

  const value = source.slice(valueStart, valueEnd).replace(/^\r?\n/u, '')
  if (!value.trim()) throw new Error('developer_instructions cannot be blank')
  return value
}

function checkDeveloperSafety(source) {
  const instructions = parseDeveloperInstructions(source)
  for (const marker of DEVELOPER_SAFETY_MARKERS) {
    if (!marker.pattern.test(instructions)) {
      throw new Error(`developer safety policy missing required rule: ${marker.label}`)
    }
  }
  return DEVELOPER_SAFETY_MARKERS.map((marker) => marker.label)
}

function localMarkdownReferences(source) {
  const references = []
  const pattern = /\[[^\]]*\]\(([^)]+)\)/g
  for (const match of source.matchAll(pattern)) {
    const raw = match[1].trim().replace(/^<|>$/g, '')
    if (!raw || raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue
    references.push(raw.split('#', 1)[0])
  }
  return [...new Set(references)]
}

async function checkAgentReferences(root, agentsSource) {
  const resolved = []
  for (const reference of localMarkdownReferences(agentsSource)) {
    const normalized = path.normalize(reference)
    if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      throw new Error(`AGENTS.md reference escapes repository: ${reference}`)
    }
    try {
      const metadata = await lstat(path.join(root, normalized))
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('not regular')
    } catch {
      throw new Error(`unresolved AGENTS.md reference: ${reference}`)
    }
    resolved.push(normalized.split(path.sep).join('/'))
  }
  if (resolved.length < 2) {
    throw new Error('AGENTS.md must link both canonical development documents')
  }
  return resolved
}

export async function validateRepository(rootInput = process.cwd()) {
  const root = path.resolve(rootInput)
  const sources = new Map()
  for (const relative of REQUIRED_FILES) {
    const source = await readRegularFile(root, relative)
    if (REQUIRED_MARKERS[relative]) checkMarkers(relative, source)
    sources.set(relative, source)
  }

  const developerSafetyMarkers = checkDeveloperSafety(sources.get('.codex/config.toml'))
  const resolvedReferences = await checkAgentReferences(root, sources.get('AGENTS.md'))
  return {
    schema: 'yoko.crm.agent-architecture-contract-check.v1',
    ok: true,
    checked_files: REQUIRED_FILES,
    developer_safety_markers: developerSafetyMarkers,
    resolved_references: resolvedReferences,
  }
}

function parseRootArgument(args) {
  if (args.length === 0) return process.cwd()
  if (args.length === 2 && args[0] === '--root' && args[1]) return args[1]
  throw new Error('usage: node tools/architecture/check-agent-architecture-contract.mjs [--root <repository>]')
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  try {
    const result = await validateRepository(parseRootArgument(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`AGENT_ARCHITECTURE_CONTRACT_FAIL: ${error.message}\n`)
    process.exitCode = 1
  }
}
