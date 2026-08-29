import { spawnSync } from 'node:child_process'

export const GIT_DIFF_FILTER = 'ACMRD'

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' })
}

export function resolveGitDiffBase(root, preferred = process.env.YOKO_BLAST_BASE) {
  const eventBase = preferred?.trim()
  if (eventBase && !/^0+$/u.test(eventBase)) {
    const result = git(root, ['rev-parse', '--verify', '--quiet', `${eventBase}^{commit}`])
    if (result.status === 0) return eventBase
    throw new Error(`configured Git change-set base is not resolvable: ${JSON.stringify(eventBase)}`)
  }
  const fallback = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^^{commit}'])
  if (fallback.status === 0) return 'HEAD^'
  throw new Error('unable to resolve a Git change-set base: event base is empty/zero and HEAD has no parent')
}

export function gitChangedPaths(root, preferred = process.env.YOKO_BLAST_BASE) {
  const base = resolveGitDiffBase(root, preferred)
  const result = git(root, ['diff', '--name-only', `--diff-filter=${GIT_DIFF_FILTER}`, `${base}...HEAD`])
  if (result.status !== 0) {
    throw new Error(result.stderr || `unable to compute the Git change set from ${base}`)
  }
  return result.stdout.split(/\r?\n/u).filter(Boolean)
}
