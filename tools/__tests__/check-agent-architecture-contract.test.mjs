import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const guard = path.join(repositoryRoot, 'tools/check-agent-architecture-contract.mjs')
const fixtureFiles = [
  'AGENTS.md',
  'docs/architecture/AGENT_DEVELOPMENT_CONTRACT.md',
  'docs/architecture/NEW_DOMAIN_CHECKLIST.md',
  'CLAUDE.md',
  '.cursorrules',
  '.claude/CLAUDE_BOOTSTRAP_PROMPT.md',
]

function invoke(root) {
  return spawnSync(process.execPath, [guard, '--root', root], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 10_000,
  })
}

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'yoko-agent-contract-'))
  for (const relative of fixtureFiles) {
    const destination = path.join(root, relative)
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(path.join(repositoryRoot, relative), destination)
  }
  return root
}

test('canonical agent architecture contract passes', () => {
  const result = invoke(repositoryRoot)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.schema, 'yoko.crm.agent-architecture-contract-check.v1')
  assert.deepEqual(report.resolved_references.sort(), [
    'docs/architecture/AGENT_DEVELOPMENT_CONTRACT.md',
    'docs/architecture/NEW_DOMAIN_CHECKLIST.md',
  ])
})

test('guard fails closed when an AGENTS.md reference is broken', async () => {
  const fixture = await makeFixture()
  try {
    const agentsPath = path.join(fixture, 'AGENTS.md')
    const source = await readFile(agentsPath, 'utf8')
    await writeFile(
      agentsPath,
      source.replace(
        'docs/architecture/AGENT_DEVELOPMENT_CONTRACT.md',
        'docs/architecture/MISSING_DEVELOPMENT_CONTRACT.md',
      ) + '\n<!-- retained marker for reference-resolution negative test: docs/architecture/AGENT_DEVELOPMENT_CONTRACT.md -->\n',
      'utf8',
    )

    const result = invoke(fixture)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /unresolved AGENTS\.md reference/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
