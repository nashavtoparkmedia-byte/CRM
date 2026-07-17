import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const roots = [
  path.join(projectRoot, 'scripts'),
  path.join(projectRoot, 'src'),
]

function collectNodeTests(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue

    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      collectNodeTests(absolutePath, output)
      continue
    }

    if (!entry.isFile() || !entry.name.endsWith('.test.js')) continue

    const source = readFileSync(absolutePath, 'utf8')
    const isVitest = /from\s+['"]vitest['"]|require\(['"]vitest['"]\)/.test(source)
    if (!isVitest) {
      output.push(path.relative(projectRoot, absolutePath))
    }
  }

  return output
}

const tests = roots.flatMap((root) => collectNodeTests(root)).sort()
if (tests.length === 0) {
  console.error('No Node test files found.')
  process.exit(1)
}

console.log(`Running ${tests.length} Node test files.`)
const result = spawnSync(process.execPath, ['--test', ...tests], {
  cwd: projectRoot,
  stdio: 'inherit',
})

process.exit(result.status ?? 1)
