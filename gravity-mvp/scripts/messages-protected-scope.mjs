import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const DEFAULT_BASE = '8a95307d19a22a086794328496630962eae1b113'
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: scriptDir,
  encoding: 'utf8',
}).trim()
const base = process.env.MESSAGES_BASE_COMMIT || DEFAULT_BASE

function gitLines(args) {
  const output = execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })

  return output
    .split(/\r?\n/)
    .map((value) => value.trim().replaceAll('\\', '/'))
    .filter(Boolean)
}

const changedFiles = new Set([
  ...gitLines(['diff', '--name-only', `${base}...HEAD`]),
  ...gitLines(['diff', '--name-only']),
  ...gitLines(['diff', '--cached', '--name-only']),
  ...gitLines(['ls-files', '--others', '--exclude-standard']),
])

const protectedScopes = [
  {
    label: 'AI Calls API',
    pattern: /^gravity-mvp\/src\/app\/api\/ai-calls\//,
  },
  {
    label: 'AI Calls library',
    pattern: /^gravity-mvp\/src\/lib\/ai-call\//,
  },
  {
    label: 'AI Calls settings API',
    pattern: /^gravity-mvp\/src\/app\/api\/settings\/ai-call-/,
  },
  {
    label: 'AI Calls key API',
    pattern: /^gravity-mvp\/src\/app\/api\/internal\/ai-call-keys\//,
  },
  {
    label: 'AI Calls settings UI',
    pattern: /^gravity-mvp\/src\/app\/settings\/integrations\/ai-call-/,
  },
  {
    label: 'Audio bridge',
    pattern: /^tools\/audio-bridge-day1\//,
  },
  {
    label: 'Production deploy configuration',
    pattern: /^deploy\//,
  },
  {
    label: 'Container build configuration',
    pattern: /(^|\/)(Dockerfile|docker-compose[^/]*\.(yml|yaml))$/,
  },
]

const violations = []
for (const file of [...changedFiles].sort()) {
  for (const scope of protectedScopes) {
    if (scope.pattern.test(file)) {
      violations.push(`${scope.label}: ${file}`)
    }
  }
}

if (violations.length > 0) {
  console.error('Messages protected-scope guard failed:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log(`Messages protected-scope guard passed (${changedFiles.size} changed files checked).`)
