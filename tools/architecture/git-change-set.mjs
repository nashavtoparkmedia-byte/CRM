import { spawnSync } from 'node:child_process'

export const GIT_DIFF_FILTER = 'ACMRD'

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' })
}

export function resolveGitDiffBase(root, preferred = process.env.YOKO_BLAST_BASE) {
  const candidates = [preferred, 'HEAD^']
    .map((candidate) => candidate?.trim())
    .filter((candidate) => candidate && !/^0+$/u.test(candidate))
  for (const candidate of [...new Set(candidates)]) {
    const result = git(root, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])
    if (result.status === 0) return candidate
  }
  throw new Error(`unable to resolve a Git change-set base from ${JSON.stringify(candidates)}`)
}

export function gitChangedPaths(root, preferred = process.env.YOKO_BLAST_BASE) {
  const base = resolveGitDiffBase(root, preferred)
  const result = git(root, ['diff', '--name-only', `--diff-filter=${GIT_DIFF_FILTER}`, `${base}...HEAD`])
  if (result.status !== 0) {
    throw new Error(result.stderr || `unable to compute the Git change set from ${base}`)
  }
  return result.stdout.split(/\r?\n/u).filter(Boolean)
}
