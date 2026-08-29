#!/usr/bin/env node

// Runs one of the two required clean local acceptance reproductions.  The
// caller supplies a genuinely fresh checkout and a distinct, empty replay
// schema; this script refuses to treat generated dependencies, prior proof
// files, or a dirty checkout as evidence.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AUTHORITATIVE_BLAST_BASE,
  assertAuthoritativeRuntimeContract,
  assertCleanWorktree,
} from './run-authoritative-ci.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const KINDS = new Set(['LOCAL_CLEAN_CHECKOUT', 'FRESH_CLEAN_CHECKOUT'])
const REPLAY_SCHEMA = /^yoko_migration_authority_replay_[a-z0-9_]+$/u
const PACKAGE_BUILD_PRODUCTS = Object.freeze(['node_modules', '.next', 'out', 'dist', 'build', '.turbo'])

function usage() {
  throw new Error('usage: run-local-clean-acceptance.mjs --kind LOCAL_CLEAN_CHECKOUT|FRESH_CLEAN_CHECKOUT --evidence-dir /absolute/path/outside/repository')
}

function parseArguments(argumentsList) {
  const values = new Map()
  for (let index = 0; index < argumentsList.length; index += 1) {
    const option = argumentsList[index]
    if (!['--kind', '--evidence-dir'].includes(option)) usage()
    const value = argumentsList[index + 1]
    if (!value || values.has(option)) usage()
    values.set(option, value)
    index += 1
  }
  const kind = values.get('--kind')
  const evidenceDirectory = values.get('--evidence-dir')
  if (!KINDS.has(kind) || !evidenceDirectory || !path.isAbsolute(evidenceDirectory)) usage()
  const relative = path.relative(root, evidenceDirectory)
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) {
    throw new Error('evidence directory must be outside the repository')
  }
  return { kind, evidenceDirectory: path.resolve(evidenceDirectory) }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: 'inherit',
    env: options.env ?? process.env,
  })
  if (result.status !== 0) {
    throw new Error(`local clean acceptance command failed: ${command} ${args.join(' ')} (exit ${result.status ?? 'signal'})`)
  }
}

function gitIdentity(expression) {
  const result = spawnSync('git', ['rev-parse', expression], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`unable to resolve source identity ${expression}`)
  return result.stdout.trim()
}

function gitStatusCount(filter) {
  const result = spawnSync('git', ['status', '--porcelain=v1', filter], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('unable to inspect clean acceptance checkout state')
  return result.stdout.split(/\r?\n/u).filter(Boolean).length
}

function replaySchema(environment) {
  const raw = environment.DATABASE_URL
  if (!raw) throw new Error('DATABASE_URL is required for isolated local migration replay')
  const schema = new URL(raw).searchParams.get('schema')
  if (!schema || !REPLAY_SCHEMA.test(schema)) {
    throw new Error('DATABASE_URL must use a unique yoko_migration_authority_replay_* schema')
  }
  return schema
}

function trackedPackageRoots(repository) {
  const result = spawnSync('git', ['ls-files', '-z', '--', 'package.json', ':(glob)**/package.json'], {
    cwd: repository,
    encoding: 'buffer',
  })
  if (result.status !== 0) throw new Error('unable to enumerate tracked package roots for local clean acceptance')
  return [...new Set(result.stdout.toString('utf8').split('\0').filter(Boolean).map((entry) => path.posix.dirname(entry)))].sort()
}

function nestedDependencyProducts(repository) {
  const found = []
  const visit = (absolute, relative = '') => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name
      const childAbsolute = path.join(absolute, entry.name)
      if (entry.name === 'node_modules' || entry.name === '.next') {
        found.push(childRelative)
        continue
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      visit(childAbsolute, childRelative)
    }
  }
  visit(repository)
  return found.sort()
}

export function inheritedGeneratedProducts(repository = root) {
  const packageOutputs = trackedPackageRoots(repository).flatMap((packageRoot) => PACKAGE_BUILD_PRODUCTS
    .map((name) => packageRoot === '.' ? name : `${packageRoot}/${name}`)
    .filter((relative) => existsSync(path.join(repository, relative))))
  return [...new Set([...packageOutputs, ...nestedDependencyProducts(repository)])].sort()
}

export function assertNoInheritedGeneratedProducts(repository = root) {
  const inherited = inheritedGeneratedProducts(repository)
  if (inherited.length > 0) {
    throw new Error(`local clean acceptance requires no inherited node_modules or build products; found: ${inherited.join(', ')}`)
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function cleanCheckoutEnvironmentIdSha256(repository = root) {
  const checkoutRealpath = realpathSync(repository)
  const gitDirectoryResult = spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: checkoutRealpath,
    encoding: 'utf8',
  })
  if (gitDirectoryResult.status !== 0) {
    throw new Error('unable to resolve immutable clean-checkout git directory identity')
  }
  const gitDirectoryRealpath = realpathSync(gitDirectoryResult.stdout.trim())
  const checkoutStat = lstatSync(checkoutRealpath)
  const gitDirectoryStat = lstatSync(gitDirectoryRealpath)
  return sha256(JSON.stringify({
    checkout_realpath: checkoutRealpath,
    checkout_device: checkoutStat.dev.toString(),
    checkout_inode: checkoutStat.ino.toString(),
    git_directory_realpath: gitDirectoryRealpath,
    git_directory_device: gitDirectoryStat.dev.toString(),
    git_directory_inode: gitDirectoryStat.ino.toString(),
  }))
}

function utcSecond() {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z')
}

function assertSourceIdentity(source, stage) {
  const current = { commit: gitIdentity('HEAD^{commit}'), tree: gitIdentity('HEAD^{tree}') }
  if (current.commit !== source.commit || current.tree !== source.tree) {
    throw new Error(`local clean acceptance source identity drift ${stage}`)
  }
}

function postgresClientIdentity(environment) {
  const container = environment.YOKO_POSTGRES_CLIENT_CONTAINER?.trim()
  const command = container ? ['docker', 'exec', container] : []
  const version = (program) => {
    const result = spawnSync(command[0] ?? program, command.length > 0 ? [...command.slice(1), program, '--version'] : ['--version'], {
      cwd: root,
      encoding: 'utf8',
    })
    if (result.status !== 0) {
      throw new Error(`unable to verify ${program} identity for local replay: ${result.stderr || result.error?.message || `exit ${result.status}`}`)
    }
    const identity = result.stdout.trim()
    if (!identity.includes('16.14')) throw new Error(`local replay requires PostgreSQL client 16.14; received ${identity}`)
    return identity
  }
  return {
    transport: container ? `docker-exec:${container}` : 'local-path',
    psql: version(environment.PSQL_BIN?.trim() || 'psql'),
    pg_dump: version(environment.PG_DUMP_BIN?.trim() || 'pg_dump'),
  }
}

function dockerBuildEvidence(environment, source) {
  const available = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { cwd: root, encoding: 'utf8' })
  if (available.status !== 0) {
    return {
      status: 'NOT_AVAILABLE',
      limitation: 'A usable Docker daemon is unavailable to this local acceptance environment; hosted gravity-artifact remains required for the immutable OCI artifact.',
    }
  }
  const image = `yoko/crm-gravity-mvp:${source.commit}-local-clean-v1`
  const profile = `crm-${source.commit.slice(0, 12)}-gravity-source-v1`
  run('docker', [
    'buildx', 'build', '--platform', 'linux/amd64', '--pull', '--no-cache',
    '--provenance=false', '--sbom=false',
    '--build-arg', 'NEXT_PUBLIC_AVITO_LEADS_URL=',
    '--build-arg', 'NEXT_PUBLIC_MAX_SCRAPER_PHONE=+79221853150',
    '--build-arg', 'NEXT_PUBLIC_FORCE_SHOW_ALL_CHANNELS=true',
    '--label', `org.opencontainers.image.revision=${source.commit}`,
    '--label', `yoko.activation.profile=${profile}`,
    '--tag', image, '--load', '--file', 'gravity-mvp/Dockerfile', 'gravity-mvp',
  ], { env: environment })
  const identity = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { cwd: root, encoding: 'utf8' })
  if (identity.status !== 0 || !/^sha256:[0-9a-f]{64}$/u.test(identity.stdout.trim())) {
    throw new Error('local Docker build did not produce an immutable image identity')
  }
  return { status: 'PASS', image, image_id: identity.stdout.trim() }
}

function main() {
  const { kind, evidenceDirectory } = parseArguments(process.argv.slice(2))
  assertAuthoritativeRuntimeContract()
  assertCleanWorktree(root, 'before local clean acceptance prerequisites')
  assertNoInheritedGeneratedProducts()
  const schema = replaySchema(process.env)
  const postgresClients = postgresClientIdentity(process.env)
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 })
  const proofPath = path.join(evidenceDirectory, 'authoritative-ci-execution.json')
  const closurePath = path.join(evidenceDirectory, 'clean-checkout-ci-reproduction.json')
  const auxiliaryPath = path.join(evidenceDirectory, 'local-clean-acceptance-auxiliary.json')
  if (existsSync(proofPath) || existsSync(`${proofPath}.new`) || existsSync(closurePath) || existsSync(auxiliaryPath)) {
    throw new Error('local clean acceptance evidence paths must not pre-exist')
  }
  const source = { commit: gitIdentity('HEAD^{commit}'), tree: gitIdentity('HEAD^{tree}') }
  const acceptanceEnvironment = {
    ...process.env,
    YOKO_BLAST_BASE: AUTHORITATIVE_BLAST_BASE,
    YOKO_CI_ATTESTATION_OUTPUT: proofPath,
    NEXT_PUBLIC_AVITO_LEADS_URL: '',
    NEXT_PUBLIC_MAX_SCRAPER_PHONE: '+79221853150',
    NEXT_PUBLIC_FORCE_SHOW_ALL_CHANNELS: 'true',
    NEXT_TELEMETRY_DISABLED: '1',
  }

  run('npm', ['ci', '--prefix', 'gravity-mvp', '--ignore-scripts', '--no-audit', '--no-fund'], { env: acceptanceEnvironment })
  run('npm', ['ci', '--prefix', 'tg-bot', '--ignore-scripts', '--no-audit', '--no-fund'], { env: acceptanceEnvironment })
  run('npm', ['run', '--prefix', 'gravity-mvp', 'gen'], { env: acceptanceEnvironment })
  run('npm', ['run', '--prefix', 'tg-bot', 'gen'], { env: acceptanceEnvironment })
  assertCleanWorktree(root, 'after generated prerequisites')
  assertSourceIdentity(source, 'before the exact 52-control runner')
  run(process.execPath, ['tools/architecture/run-authoritative-ci.mjs'], { env: acceptanceEnvironment })
  assertCleanWorktree(root, 'after the exact 52-control runner')
  assertSourceIdentity(source, 'after the exact 52-control runner')
  run('npm', ['run', '--prefix', 'gravity-mvp', 'build'], { env: acceptanceEnvironment })
  assertCleanWorktree(root, 'after production application build')

  const docker = dockerBuildEvidence(acceptanceEnvironment, source)
  assertCleanWorktree(root, 'after local production image attempt')
  assertSourceIdentity(source, 'after local production image attempt')
  const executionProof = JSON.parse(readFileSync(proofPath, 'utf8'))
  const checkout = {
    head: gitIdentity('HEAD^{commit}'),
    tree: gitIdentity('HEAD^{tree}'),
    tracked_changes: gitStatusCount('--untracked-files=no'),
    untracked_changes: gitStatusCount('--untracked-files=all'),
    environment_id_sha256: cleanCheckoutEnvironmentIdSha256(root),
  }
  if (checkout.tracked_changes !== 0 || checkout.untracked_changes !== 0) {
    throw new Error('local clean acceptance produced a dirty source checkout')
  }
  const closureEvidence = {
    schema: 'yoko.crm.clean-checkout-ci-reproduction.v1',
    status: 'PASS',
    kind,
    executed_at: utcSecond(),
    source,
    checkout,
    generated_prerequisites: [
      'npm ci --prefix gravity-mvp --ignore-scripts',
      'npm ci --prefix tg-bot --ignore-scripts',
      'npm run --prefix gravity-mvp gen',
      'npm run --prefix tg-bot gen',
    ],
    execution_proof: executionProof,
  }
  const auxiliaryEvidence = {
    schema: 'yoko.crm.local-clean-acceptance-auxiliary.v1',
    status: 'PASS',
    closure_evidence_path: closurePath,
    source,
    node: process.versions.node,
    blast_base: AUTHORITATIVE_BLAST_BASE,
    replay_schema: schema,
    postgres_clients: postgresClients,
    production_application_build: {
      status: 'PASS',
      command: 'npm run --prefix gravity-mvp build',
      exact_hosted_build_args: {
        NEXT_PUBLIC_AVITO_LEADS_URL: '',
        NEXT_PUBLIC_MAX_SCRAPER_PHONE: '+79221853150',
        NEXT_PUBLIC_FORCE_SHOW_ALL_CHANNELS: 'true',
      },
    },
    local_docker_build: docker,
  }
  writeFileSync(closurePath, `${JSON.stringify(closureEvidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  writeFileSync(auxiliaryPath, `${JSON.stringify(auxiliaryEvidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  process.stdout.write(`local clean acceptance: PASS (${kind}; closure=${closurePath}; auxiliary=${auxiliaryPath})\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  }
}
