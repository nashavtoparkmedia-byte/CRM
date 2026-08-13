#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from '../../gravity-mvp/node_modules/typescript/lib/typescript.js'

import { extractPrismaWrites, scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const readJson = (relative) => JSON.parse(read(relative))
const checks = []
const check = (name, run) => { run(); checks.push(name) }

const actionsPath = 'gravity-mvp/src/app/settings/ai/actions.ts'
const contractPath = 'gravity-mvp/src/contracts/calling/v1/ai-agent-config-commands.ts'
const handlerPath =
  'gravity-mvp/src/modules/calling/public/v1/ai-agent-config-handler.ts'
const adapterPath =
  'gravity-mvp/src/modules/calling/public/v1/legacy-prisma-ai-agent-config-adapter.ts'
const credentialVaultPath =
  'gravity-mvp/src/modules/calling/application/ai-agent-provider-credential.ts'
const publicPath = 'gravity-mvp/src/modules/calling/public/v1/index.ts'
const applicationPath =
  'gravity-mvp/src/modules/calling/application/ai-agent-operations.ts'
const amendmentPath =
  'architecture/isolation/calling/ai-agent-config-v1/module-manifest-amendments.json'

const retiredFingerprints = [
  'arch_72b270b1fc3c03ccc58b1c9f',
  'arch_4b0b29ed845be05d5ef139df',
  'arch_e5df8b423e9cc7981de3ab1a',
  'arch_cb1d5db547da28c32be32d70',
  'arch_d4c8bd3927c6aaaf4956a4cd',
]

// The integration-admin authorization surface is intentionally exposed from
// Identity Access to these already-approved callers. That manifest dependency
// retires the corresponding stale undeclared-dependency exceptions without
// changing any runtime import to an internal module.
const identityDependencyRetirements = new Set([
  'arch_c254fdb923e70af8b8e1f296',
  'arch_de40c467ff5ed464320a41b4',
  'arch_b3e41eb2c5c3ed6dca974811',
  'arch_a6c352e279979a71d019aaa6',
  'arch_270ac7f8b720f8c37f8a161b',
  'arch_a87f41f1c4333ba308913fc6',
  'arch_a12405b62d0ef60873a794b4',
  'arch_2f87e2510d27cdf2ff0fc5c4',
  'arch_123c3aa7a015fb4115618b7b',
  'arch_89e981e31ff8f0b1c9f4d281',
  'arch_1f028f5650942942b018e9c1',
])

const commandPairs = [
  ['SAVE_AI_AGENT_CONFIG_COMMAND_V1', 'saveAiAgentConfigV1'],
  [
    'RECORD_SAVED_AI_CONNECTION_SUCCESS_COMMAND_V1',
    'recordSavedAiConnectionSuccessV1',
  ],
  ['SET_ACTIVE_AI_PROFILE_COMMAND_V1', 'setActiveAiProfileV1'],
  ['SAVE_EXTRACTION_QUALITY_TIER_COMMAND_V1', 'saveExtractionQualityTierV1'],
]

const configOperations = [
  {
    factory: 'createSaveAiAgentConfigHandlerV1',
    binding: 'saveAiAgentConfig',
    operation: 'saveAiAgentConfigV1',
  },
  {
    factory: 'createRecordSavedAiConnectionSuccessHandlerV1',
    binding: 'recordSavedAiConnectionSuccess',
    operation: 'recordSavedAiConnectionSuccessV1',
  },
  {
    factory: 'createSetActiveAiProfileHandlerV1',
    binding: 'setActiveAiProfile',
    operation: 'setActiveAiProfileV1',
  },
  {
    factory: 'createSaveExtractionQualityTierHandlerV1',
    binding: 'saveExtractionQualityTier',
    operation: 'saveExtractionQualityTierV1',
  },
]
const exactApplicationExports = [
  'createAiAgentProfileV1',
  'updateAiAgentProfileV1',
  'deleteAiAgentProfileV1',
  ...configOperations.map(({ operation }) => operation),
]
const applicationSpecifier = '../../application/ai-agent-operations'
const handlerSpecifier = '../public/v1/ai-agent-config-handler'
const adapterSpecifier = '../public/v1/legacy-prisma-ai-agent-config-adapter'
const adapterBinding = 'legacyPrismaAiAgentConfigPortV1'

function parseSource(relative, source) {
  const kind = relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, kind)
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false
}

function unwrapExpression(expression) {
  let current = expression
  while (
    ts.isAwaitExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current))
  ) current = current.expression
  return current
}

function namedImportSites(relative, source, specifier) {
  const sourceFile = parseSource(relative, source)
  return sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteralLike(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== specifier
    ) return []
    const clause = statement.importClause
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
      return [{ bindings: [['*', '*', Boolean(clause?.isTypeOnly)]] }]
    }
    return [{ bindings: clause.namedBindings.elements.map((element) => [
      (element.propertyName ?? element.name).text,
      element.name.text,
      Boolean(clause.isTypeOnly || element.isTypeOnly),
    ]) }]
  })
}

function namedExportSites(relative, source, specifier) {
  const sourceFile = parseSource(relative, source)
  return sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isExportDeclaration(statement)
      || !statement.moduleSpecifier
      || !ts.isStringLiteralLike(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== specifier
    ) return []
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      return [{ bindings: [['*', '*', Boolean(statement.isTypeOnly)]] }]
    }
    return [{ bindings: statement.exportClause.elements.map((element) => [
      (element.propertyName ?? element.name).text,
      element.name.text,
      Boolean(statement.isTypeOnly || element.isTypeOnly),
    ]) }]
  })
}

function directCallSites(relative, source) {
  const sourceFile = parseSource(relative, source)
  const calls = []
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression)
      if (ts.isIdentifier(callee)) calls.push({ kind: 'identifier', name: callee.text })
      else if (ts.isPropertyAccessExpression(callee)) {
        calls.push({ kind: 'property', name: callee.name.text })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

function bindingNames(name, sourceFile) {
  if (ts.isIdentifier(name)) return [name.text]
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap((element) => (
      ts.isBindingElement(element) ? bindingNames(element.name, sourceFile) : []
    ))
  }
  return [name.getText(sourceFile)]
}

function nonImportDeclarations(relative, source) {
  const sourceFile = parseSource(relative, source)
  const names = []
  function visit(node) {
    if (ts.isImportDeclaration(node)) return
    if (ts.isVariableDeclaration(node)) {
      names.push(...bindingNames(node.name, sourceFile))
    } else if (ts.isParameter(node)) {
      names.push(...bindingNames(node.name, sourceFile))
    } else if (
      (ts.isFunctionDeclaration(node)
        || ts.isFunctionExpression(node)
        || ts.isClassDeclaration(node)
        || ts.isClassExpression(node)
        || ts.isEnumDeclaration(node))
      && node.name
    ) names.push(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return names
}

function assertFactoryBinding(sourceFile, { factory, binding }) {
  const declarations = []
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === binding) {
        declarations.push({ statement, declaration })
      }
    }
  }
  assert.equal(declarations.length, 1, `expected one owner binding ${binding}`)
  const [{ statement, declaration }] = declarations
  assert((statement.declarationList.flags & ts.NodeFlags.Const) !== 0, `${binding} must be const`)
  assert.equal(hasModifier(statement, ts.SyntaxKind.ExportKeyword), false, `${binding} must stay private`)
  const initializer = declaration.initializer && unwrapExpression(declaration.initializer)
  assert(initializer && ts.isCallExpression(initializer), `${binding} must be a factory call`)
  assert(ts.isIdentifier(initializer.expression) && initializer.expression.text === factory)
  assert.equal(initializer.arguments.length, 1)
  assert(ts.isIdentifier(initializer.arguments[0]) && initializer.arguments[0].text === adapterBinding)
}

function assertNarrowOperationWrapper(sourceFile, { binding, operation }) {
  const declarations = sourceFile.statements.filter((statement) => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === operation
  ))
  assert.equal(declarations.length, 1, `expected one wrapper ${operation}`)
  const declaration = declarations[0]
  assert(hasModifier(declaration, ts.SyntaxKind.ExportKeyword), `${operation} must be exported`)
  assert(hasModifier(declaration, ts.SyntaxKind.AsyncKeyword), `${operation} must remain async`)
  assert.equal(declaration.parameters.length, 1, `${operation} must expose only its command`)
  const parameter = declaration.parameters[0]
  assert(ts.isIdentifier(parameter.name) && parameter.name.text === 'command')
  assert(parameter.type?.kind === ts.SyntaxKind.UnknownKeyword)
  assert(declaration.body)
  assert.equal(declaration.body.statements.length, 1, `${operation} must be a narrow one-call wrapper`)
  const statement = declaration.body.statements[0]
  assert(ts.isReturnStatement(statement) && statement.expression)
  const returned = unwrapExpression(statement.expression)
  assert(ts.isCallExpression(returned), `${operation} must return its bound handler call`)
  assert(ts.isIdentifier(returned.expression) && returned.expression.text === binding)
  assert.equal(returned.arguments.length, 1)
  assert(ts.isIdentifier(returned.arguments[0]) && returned.arguments[0].text === 'command')
}

function assertAiAgentOperationBoundary(applicationSource, publicSource) {
  assert.deepEqual(namedImportSites(applicationPath, applicationSource, handlerSpecifier), [{ bindings: [
    ['createRecordSavedAiConnectionSuccessHandlerV1', 'createRecordSavedAiConnectionSuccessHandlerV1', false],
    ['createSaveAiAgentConfigHandlerV1', 'createSaveAiAgentConfigHandlerV1', false],
    ['createSaveExtractionQualityTierHandlerV1', 'createSaveExtractionQualityTierHandlerV1', false],
    ['createSetActiveAiProfileHandlerV1', 'createSetActiveAiProfileHandlerV1', false],
  ] }])
  assert.deepEqual(namedImportSites(applicationPath, applicationSource, adapterSpecifier), [{ bindings: [
    [adapterBinding, adapterBinding, false],
  ] }])
  const sourceFile = parseSource(applicationPath, applicationSource)
  const importedOwnerBindings = [
    ...configOperations.map(({ factory }) => factory),
    adapterBinding,
  ]
  assert.deepEqual(
    nonImportDeclarations(applicationPath, applicationSource)
      .filter((name) => importedOwnerBindings.includes(name)),
    [],
    'owner composition shadows a factory or adapter import',
  )
  for (const operation of configOperations) {
    assertFactoryBinding(sourceFile, operation)
    assertNarrowOperationWrapper(sourceFile, operation)
  }
  const exportedFunctions = sourceFile.statements.filter((statement) => (
    ts.isFunctionDeclaration(statement)
    && statement.name
    && hasModifier(statement, ts.SyntaxKind.ExportKeyword)
  )).map((statement) => statement.name.text)
  assert.deepEqual(exportedFunctions, exactApplicationExports)
  assert.deepEqual(namedExportSites(publicPath, publicSource, applicationSpecifier), [{ bindings:
    exactApplicationExports.map((name) => [name, name, false]),
  }])
}

function assertCommandConsumerBoundary(source) {
  const operationNames = configOperations.map(({ operation }) => operation)
  const targetImports = namedImportSites(actionsPath, source, '@/modules/calling/public/v1')
    .flatMap((site) => site.bindings)
    .filter(([imported, local]) => operationNames.includes(imported) || operationNames.includes(local))
    .sort((left, right) => left[0].localeCompare(right[0]))
  assert.deepEqual(
    targetImports,
    operationNames.map((name) => [name, name, false]).sort((left, right) => left[0].localeCompare(right[0])),
  )
  const calls = directCallSites(actionsPath, source).filter((call) => operationNames.includes(call.name))
  assert(calls.every((call) => call.kind === 'identifier'))
  assert.deepEqual(
    nonImportDeclarations(actionsPath, source).filter((name) => operationNames.includes(name)),
    [],
    'Configuration shadows an imported Calling command operation',
  )
  for (const operation of operationNames) {
    assert.equal(calls.filter((call) => call.name === operation).length, 1)
  }
}

function rejectProbe(original, changed, validate) {
  assert.notEqual(changed, original, 'negative probe must alter its source')
  assert.throws(() => validate(changed))
}

const actions = read(actionsPath)
const contracts = read(contractPath)
const handler = read(handlerPath)
const adapter = read(adapterPath)
const credentialVault = read(credentialVaultPath)
const publicSurface = read(publicPath)
const application = read(applicationPath)

check('Configuration has exact runtime imports and invokes all four versioned Calling commands', () => {
  assertCommandConsumerBoundary(actions)
  for (const [constant, runtime] of commandPairs) {
    assert.match(actions, new RegExp(`\\b${constant}\\b`))
    assert(configOperations.some(({ operation }) => operation === runtime))
  }
})

check('public facade and owner composition have exact named bindings and narrow wrappers', () => {
  assertAiAgentOperationBoundary(application, publicSurface)
})

check('AST wiring rejects substitutions, no-op wrappers and comment-only evidence', () => {
  rejectProbe(
    application,
    application.replace(
      `const saveAiAgentConfig = createSaveAiAgentConfigHandlerV1(${adapterBinding})`,
      `const saveAiAgentConfig = createSetActiveAiProfileHandlerV1(${adapterBinding})`,
    ),
    (probe) => assertAiAgentOperationBoundary(probe, publicSurface),
  )
  rejectProbe(
    application,
    application.replace(
      'return saveAiAgentConfig(command)',
      'return undefined // saveAiAgentConfig(command)',
    ),
    (probe) => assertAiAgentOperationBoundary(probe, publicSurface),
  )
  rejectProbe(
    publicSurface,
    `${publicSurface.replace('  saveAiAgentConfigV1,\n', '')}\n// export { saveAiAgentConfigV1 } from '${applicationSpecifier}'\n`,
    (probe) => assertAiAgentOperationBoundary(application, probe),
  )
})

check('all five foreign AiAgentConfig writes are absent from the caller', () => {
  const writes = extractPrismaWrites(actions).filter((write) => (
    write.model === 'aiAgentConfig' || write.tables?.includes('AiAgentConfig')
  ))
  assert.deepEqual(writes, [])
  assert.doesNotMatch(actions, /prisma\.aiAgentConfig\.(?:create|update|updateMany|upsert|delete)/)
})

check('save caller maps the public credential input to an opaque token and rejects persistence names', () => {
  assert.match(
    actions,
    /field === 'providerCredential'[\s\S]{0,500}field: 'providerCredential'[\s\S]{0,500}captureAiAgentProviderCredentialV1\(data\[field\]\)/,
  )
  assert.match(
    actions,
    /field === 'apiKeyEncrypted'[\s\S]{0,300}field: '__unsupported_provider_credential__', value: null/,
  )
  assert.doesNotMatch(
    actions,
    /field === 'apiKeyEncrypted'[\s\S]{0,300}captureAiAgentProviderCredentialV1/,
  )
  assert.match(actions, /return \{ id: 'singleton', \.\.\.safeResult \}/)
  assert.doesNotMatch(actions, /return \{ id: 'singleton', \.\.\.data \}/)
  assert.match(actions, /includesProviderCredential[\s\S]*ошибка сохранения учётных данных/)
  assert.doesNotMatch(actions, /console\.(?:log|error)[^\n]*data/)
})

check('caller retains authorization, provider orchestration, validation and revalidation', () => {
  const save = actions.slice(actions.indexOf('export async function saveAiConfig'), actions.indexOf('/** PR9.19'))
  const savedConnection = actions.slice(
    actions.indexOf('export async function testSavedConnection'),
    actions.indexOf('export async function testAiConnection'),
  )
  const activeProfile = actions.slice(
    actions.indexOf('export async function setActiveAiProfile'),
    actions.indexOf('// ─── AI Knowledge Core'),
  )
  const tier = actions.slice(
    actions.indexOf('export async function saveExtractionQualityTier'),
    actions.indexOf('/** Текущий tier'),
  )
  assert.match(save, /await assertCanEditAi\(\)/)
  assert.match(save, /revalidatePath\('\/settings\/ai'\)/)
  assert.match(savedConnection, /await testAiConnection\(/)
  assert.match(savedConnection, /if \(result\.ok\)/)
  assert.match(savedConnection, /catch \{ \/\* silent \*\/ \}/)
  assert.match(activeProfile, /await assertCanEditAi\(\)/)
  assert.match(activeProfile, /revalidatePath\('\/settings\/ai'\)/)
  assert.match(tier, /\['economy', 'balanced', 'quality'\]\.includes\(tier\)/)
  assert.match(tier, /throw new Error\('Недопустимый tier'\)/)
  assert.match(tier, /revalidatePath\('\/settings\/ai'\)/)
})

check('public contract is a strict ordered 23-field union without a credential value', () => {
  const fieldBlock = contracts.slice(
    contracts.indexOf('AI_AGENT_CONFIG_PATCH_FIELDS_V1'),
    contracts.indexOf('] as const', contracts.indexOf('AI_AGENT_CONFIG_PATCH_FIELDS_V1')),
  )
  assert.equal((fieldBlock.match(/^  '[^']+',?$/gm) || []).length, 23)
  assert.match(contracts, /type OpaqueCredentialRefV1/)
  assert.match(contracts, /Reflect\.ownKeys\(value\)\.length === 0/)
  assert.match(contracts, /duplicate patch field:/)
  assert.match(contracts, /unsupported patch field:/)
  assert.doesNotMatch(contracts, /apiKeyEncrypted/)
  assert.doesNotMatch(contracts, /credentialValue|rawCredential|secretValue/i)
})

check('handler retains no transaction/catch and only semantic port capabilities', () => {
  assert.match(handler, /interface AiAgentConfigPersistencePortV1/)
  for (const capability of [
    'singletonExists',
    'createSingleton',
    'updateSingleton',
    'recordSavedConnectionSuccess',
    'findProfile',
    'setActiveProfile',
    'saveExtractionQualityTier',
  ]) assert.match(handler, new RegExp(`\\b${capability}\\b`))
  assert.doesNotMatch(handler, /@\/lib\/prisma|\$transaction|\bcatch\b/)
  assert.match(handler, /if \(parsed\.profileId\)/)
  assert.match(handler, /throw new Error\('Профиль не найден'\)/)
})

check('adapter has fixed SQL and the Calling credential boundary is private and one-shot', () => {
  const writes = extractPrismaWrites(adapter)
  assert.equal(writes.length, 5)
  assert.equal(writes.filter((write) => write.kind === 'raw').length, 4)
  assert.ok(writes.every((write) => write.kind !== 'raw' || write.dynamic === false))
  assert.ok(writes.every((write) => (
    write.model === 'aiAgentConfig' || write.tables?.includes('AiAgentConfig')
  )))
  assert.match(credentialVault, /new WeakMap<OpaqueCredentialRefV1, string>\(\)/)
  assert.match(credentialVault, /credentialValues\.set\(reference, value\)/)
  const readIndex = credentialVault.indexOf('credentialValues.get(reference)')
  const deleteIndex = credentialVault.indexOf('credentialValues.delete(reference)')
  const returnIndex = credentialVault.indexOf('return value', readIndex)
  assert.ok(readIndex >= 0)
  assert.ok(deleteIndex > readIndex)
  assert.ok(returnIndex > deleteIndex)
  assert.match(adapter, /from '\.\.\/\.\.\/application\/ai-agent-provider-credential'/)
  assert.match(adapter, /revealAiAgentProviderCredentialV1\(entry\.value\)/)
  assert.doesNotMatch(adapter, /export\s+(?:function|const|\{)[^\n]*(?:reveal|unseal|read)[A-Za-z]*Credential/i)
  assert.equal((adapter.match(/"updatedAt" = NOW\(\)/g) || []).length, 2)
  assert.equal((adapter.match(/NOW\(\)/g) || []).length, 4)
  assert.doesNotMatch(adapter, /\$transaction/)
})

check('public surface exports only credential capture, not retrieval', () => {
  assert.match(
    publicSurface,
    /export\s*\{\s*captureAiAgentProviderCredentialV1\s*\}\s*from\s*['"]\.\.\/\.\.\/application\/ai-agent-provider-credential['"]/,
  )
  assert.doesNotMatch(publicSurface, /(?:reveal|unseal|read)[A-Za-z]*Credential|credentialValues/i)
  for (const [, runtime] of commandPairs) assert.match(publicSurface, new RegExp(`\\b${runtime}\\b`))
})

check('Calling public surface does not import or re-export an internal adapter', () => {
  assert.doesNotMatch(publicSurface, /(?:from|export)\s+['"][^'"]*\/internal\//)
  assert.doesNotMatch(publicSurface, /createPersistRecordingReadyV1|UnitOfWork|Transaction/)
  assert.match(publicSurface, /PersistRecordingReadyV1/)
  assert.match(publicSurface, /export \{ persistRecordingReadyV1 \} from '\.\.\/\.\.\/application\/recording-ready'/)
})

check('Calling amendment adds exactly the four reviewed commands', () => {
  const amendment = readJson(amendmentPath)
  assert.equal(amendment.schema, 'yoko.crm.module-manifest-amendments.v1')
  assert.equal(amendment.version, 1)
  assert.equal(amendment.amendments.length, 1)
  assert.equal(amendment.amendments[0].context, 'calling')
  assert.deepEqual(amendment.amendments[0].add_commands, [
    'SaveAiAgentConfigCommand.v1',
    'RecordSavedAiConnectionSuccessCommand.v1',
    'SetActiveAiProfileCommand.v1',
    'SaveExtractionQualityTierCommand.v1',
  ])
})

const scan = await scanArchitecture(root)
const currentIds = new Set(scan.findings.map((finding) => finding.fingerprint))
const registry = readJson(scan.policy.exception_registry)
const registryIds = new Set(registry.exceptions.map((exception) => exception.fingerprint))

check('reviewed D4 and approved Identity dependency findings retire without replacement', () => {
  for (const fingerprint of retiredFingerprints) assert.equal(currentIds.has(fingerprint), false)
  for (const fingerprint of identityDependencyRetirements) {
    assert.equal(currentIds.has(fingerprint), false)
    assert.equal(registryIds.has(fingerprint), false)
  }
  const additions = [...currentIds].filter((fingerprint) => !registryIds.has(fingerprint))
  assert.deepEqual(additions, [])
  const registryRetirements = registry.exceptions.filter(
    (exception) => !currentIds.has(exception.fingerprint),
  )
  assert.deepEqual(registryRetirements, [])
  assert.equal(scan.findings.length, registry.exceptions.length)
  assert.ok(scan.scanned_files >= 1015)
  assert.equal(scan.findings.filter(
    (finding) => finding.rule === 'direct_foreign_prisma_write',
  ).length, 0)
})

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  passed: checks.length,
  findings: scan.findings.length,
  checks,
}, null, 2)}\n`)
