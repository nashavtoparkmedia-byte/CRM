#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createModuleScaffold, validateModuleManifestCandidate, validateModuleSource } from './create-module-scaffold.mjs'

const run = promisify(execFile)
const root = await mkdtemp(path.join(os.tmpdir(), 'yoko-module-scaffold-'))
const node = process.execPath
async function invoke(relative) {
  return run(node, [relative], {
    cwd: root,
    env: { ...process.env, YOKO_ARCHITECTURE_TOOL_ROOT: process.cwd() },
  })
}
async function expectEntrypointFailure(relative, pattern) {
  await assert.rejects(() => invoke(relative), pattern)
}

try {
  const created = await createModuleScaffold(root, { id: 'sample_context', name: 'SampleContext' })
  const publicPath = path.join(created.moduleRoot, 'public/v1/index.ts')
  const internalPath = path.join(created.moduleRoot, 'internal/owner-operation.ts')
  const manifestPath = path.join(root, created.manifestPath)
  const publicSource = await readFile(publicPath, 'utf8')
  const internalSource = await readFile(internalPath, 'utf8')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const schema = JSON.parse(await readFile('architecture/contexts/v1/module-manifest.schema.json', 'utf8'))
  const integration = JSON.parse(await readFile(path.join(root, created.integrationPath), 'utf8'))

  assert.match(publicSource, /SampleContextOperationV1/)
  assert.deepEqual(manifest.owned_paths, ['gravity-mvp/src/contracts/sample-context', 'gravity-mvp/src/modules/sample-context'])
  assert.equal(manifest.evidence.integration_status, 'CANDIDATE_NOT_IN_CONTEXT_INDEX')
  assert.deepEqual(integration.entrypoints, [
    'tools/architecture/generated/sample-context-module-test.mjs',
    'tools/architecture/generated/sample-context-contract-test.mjs',
    'tools/architecture/generated/sample-context-architecture-check.mjs',
    'tools/architecture/generated/sample-context-build-check.mjs',
  ])
  assert.equal(integration.status, 'CANDIDATE_NOT_INTEGRATED')
  assert.match(await readFile(path.join(root, integration.instructions), 'utf8'), /context-index\.json/)
  validateModuleManifestCandidate(manifest, schema)
  validateModuleSource('gravity-mvp/src/modules/sample-context/public/v1/index.ts', publicSource)

  for (const command of manifest.verification.module_tests.concat(manifest.verification.contract_tests, [
    'node tools/architecture/generated/sample-context-architecture-check.mjs',
    'node tools/architecture/generated/sample-context-build-check.mjs',
  ])) {
    const relative = command.replace(/^node /, '')
    const result = await invoke(relative)
    assert.match(result.stdout, /PASS|"ok":true/)
  }

  await writeFile(publicPath, "export { privateOwner } from '../../internal/owner-operation'\n")
  await expectEntrypointFailure('tools/architecture/generated/sample-context-architecture-check.mjs', /public facade imports private internal code/)
  await writeFile(publicPath, publicSource)

  await writeFile(publicPath, "export { privateOwner } from '@/modules/sample-context/internal/owner-operation'\n")
  await expectEntrypointFailure('tools/architecture/generated/sample-context-architecture-check.mjs', /public facade imports private internal code/)
  await writeFile(publicPath, publicSource)

  const publicTsxPath = path.join(created.moduleRoot, 'public/v1/tsx-escape.tsx')
  await writeFile(publicTsxPath, "export { privateOwner } from '../../internal/owner-operation'\n")
  await expectEntrypointFailure('tools/architecture/generated/sample-context-architecture-check.mjs', /public facade imports private internal code/)
  await rm(publicTsxPath)

  const publicJsPath = path.join(created.moduleRoot, 'public/v1/js-escape.js')
  await writeFile(publicJsPath, 'await prisma.foreignRecord.deleteMany({})\n')
  await expectEntrypointFailure('tools/architecture/generated/sample-context-architecture-check.mjs', /public facade performs persistence write/)
  await rm(publicJsPath)

  await writeFile(internalPath, `${internalSource}\nimport { foreignOperation } from '@/modules/contacts/public/v1'\nvoid foreignOperation\n`)
  await expectEntrypointFailure('tools/architecture/generated/sample-context-architecture-check.mjs', /foreign module dependency is not declared by candidate/)
  await writeFile(internalPath, internalSource)

  await writeFile(internalPath, `${internalSource}\nimport { foreignOperation } from '../../contacts/public/v1'\nvoid foreignOperation\n`)
  await expectEntrypointFailure('tools/architecture/generated/sample-context-architecture-check.mjs', /foreign module dependency is not declared by candidate/)
  await writeFile(internalPath, internalSource)

  manifest.allowed_dependencies = [{ context: 'contacts', surface: 'contacts.public' }]
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(internalPath, `${internalSource}\nimport { foreignOperation } from '@/modules/contacts/public/v1'\nvoid foreignOperation\n`)
  assert.match((await invoke('tools/architecture/generated/sample-context-architecture-check.mjs')).stdout, /"ok":true/)
  await writeFile(internalPath, `${internalSource}\nimport { privateOwner } from '@/modules/contacts/internal/owner-operation'\nvoid privateOwner\n`)
  await expectEntrypointFailure('tools/architecture/generated/sample-context-architecture-check.mjs', /foreign module dependency must use a versioned public surface/)
  await writeFile(internalPath, internalSource)
  await writeFile(internalPath, `${internalSource}\nimport { foreignOperation } from '../../contacts/public/v1'\nvoid foreignOperation\n`)
  assert.match((await invoke('tools/architecture/generated/sample-context-architecture-check.mjs')).stdout, /"ok":true/)
  await writeFile(internalPath, `${internalSource}\nimport { privateOwner } from '../../contacts/internal/owner-operation'\nvoid privateOwner\n`)
  await expectEntrypointFailure('tools/architecture/generated/sample-context-architecture-check.mjs', /foreign module dependency must use a versioned public surface/)
  await writeFile(internalPath, internalSource)
  manifest.allowed_dependencies = []
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  await writeFile(internalPath, `${internalSource}\nawait prisma.foreignRecord.create({ data: {} })\n`)
  await expectEntrypointFailure('tools/architecture/generated/sample-context-architecture-check.mjs', /foreign persistence write is not owned by candidate/)
  await writeFile(internalPath, internalSource)

  await writeFile(internalPath, `${internalSource}\nconst hiddenDb = prisma\nawait hiddenDb.foreignRecord.deleteMany({})\n`)
  await expectEntrypointFailure('tools/architecture/generated/sample-context-architecture-check.mjs', /foreign persistence write is not owned by candidate/)
  await writeFile(internalPath, internalSource)

  await writeFile(internalPath, `${internalSource}\nawait prisma['foreignRecord']['deleteMany']({})\n`)
  await expectEntrypointFailure('tools/architecture/generated/sample-context-architecture-check.mjs', /unresolved persistence write is not authorized by candidate/)
  await writeFile(internalPath, internalSource)

  await writeFile(internalPath, `${internalSource}\nimport OpenAI from 'openai'\n`)
  await expectEntrypointFailure('tools/architecture/generated/sample-context-architecture-check.mjs', /provider import is not authorized by candidate relationship/)
  await writeFile(internalPath, internalSource)

  await writeFile(internalPath, `${internalSource}\nconst providerPackage = 'openai'\nconst provider = await import(providerPackage)\nvoid provider\n`)
  await expectEntrypointFailure('tools/architecture/generated/sample-context-architecture-check.mjs', /nonliteral module load is not authorized by candidate/)
  await writeFile(internalPath, internalSource)

  await writeFile(internalPath, `${internalSource}\nconst secret = process.env.UNDECLARED_SECRET\n`)
  await expectEntrypointFailure('tools/architecture/generated/sample-context-architecture-check.mjs', /credential environment is not declared by candidate relationship/)
  await writeFile(internalPath, internalSource)

  await writeFile(internalPath, `${internalSource}\nconst secret = process.env['UNDECLARED_SECRET']\n`)
  await expectEntrypointFailure('tools/architecture/generated/sample-context-architecture-check.mjs', /credential environment is not declared by candidate relationship/)
  await writeFile(internalPath, internalSource)

  assert.throws(() => validateModuleSource(
    'gravity-mvp/src/modules/sample-context/public/v1/index.ts',
    "export { privateOwner } from '../../internal/owner-operation'",
  ), /public facade imports internal code/)
  assert.throws(() => validateModuleSource(
    'gravity-mvp/src/modules/sample-context/public/v1/index.ts',
    "export { privateOwner } from '@/modules/sample-context/internal/owner-operation'",
  ), /public facade imports internal code/)
  assert.throws(() => validateModuleSource(
    'gravity-mvp/src/modules/sample-context/public/v1/index.ts',
    'await prisma.sampleContextRecord.create({ data: {} })',
  ), /public facade performs persistence write/)
  process.stdout.write('module scaffold: PASS\n')
} finally {
  await rm(root, { recursive: true, force: true })
}
