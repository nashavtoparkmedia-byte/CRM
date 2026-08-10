#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = process.cwd()
const require = createRequire(import.meta.url)
const ts = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const consumerRoot = path.join(root, 'gravity-mvp/src')
const consumers = {
  'gravity-mvp/src/app/messages/link-chat-actions.ts': {
    count: 1,
    chatIds: ['chat.id'],
    catchProfiles: { '[linkChatToDriverManually] ContactService failed (non-blocking)': 1 },
  },
  'gravity-mvp/src/lib/whatsapp/WhatsAppService.ts': {
    count: 5,
    chatIds: ['unifiedSyncChat.id', 'unifiedSyncChat.id', 'unifiedChat.id', 'unifiedChat.id', 'unifiedChat.id'],
    catchProfiles: {
      '[WA-SERVICE] syncHistory contact resolve failed': 2,
      '[WA-SERVICE] ContactService error (non-blocking)': 1,
      '<empty>': 2,
    },
  },
  'gravity-mvp/src/app/api/messages/start-chat/route.ts': {
    count: 1,
    chatIds: ['chat.id'],
    catchProfiles: { '[API-START-CHAT] ContactService error (non-blocking)': 1 },
  },
  'gravity-mvp/src/app/api/webhook/telegram/route.ts': {
    count: 1,
    chatIds: ['unifiedChat.id'],
    catchProfiles: { '[WEBHOOK-TG] ContactService error (non-blocking)': 1 },
  },
  'gravity-mvp/src/app/tg-actions.ts': {
    count: 1,
    chatIds: ['unifiedChat.id'],
    catchProfiles: { 'ContactService error (non-blocking)': 1 },
  },
  'gravity-mvp/src/app/api/webhook/max/route.ts': {
    count: 2,
    chatIds: ['unifiedChat.id', 'unifiedChat.id'],
    catchProfiles: { '[WEBHOOK-MAX] ContactService error (non-blocking)': 2 },
  },
  'gravity-mvp/src/app/api/webhooks/max/route.ts': {
    count: 1,
    chatIds: ['chat.id'],
    catchProfiles: { '[MAX Webhook] ContactService error (non-blocking)': 1 },
  },
}

const checks = []
const check = (name, fn) => { fn(); checks.push(name) }
const normalize = (value) => value.replace(/\s+/g, '')

function sourceFile(file, source) {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function visit(node, visitor) {
  visitor(node)
  ts.forEachChild(node, (child) => visit(child, visitor))
}

function ancestor(node, predicate) {
  for (let current = node.parent; current; current = current.parent) {
    if (predicate(current)) return current
  }
  return undefined
}

function propertyName(property) {
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text
  return undefined
}

function namedImportCount(ast, moduleName, importedName) {
  let count = 0
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== moduleName) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text
      if (imported === importedName && element.name.text === importedName) count += 1
    }
  }
  return count
}

function enclosingTryBody(node) {
  return ancestor(node, (candidate) =>
    ts.isTryStatement(candidate)
    && candidate.tryBlock.pos <= node.pos
    && candidate.tryBlock.end >= node.end)
}

function precedingLegacyResolve(node, ast) {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isBlock(current)) continue
    const matches = []
    visit(current, (candidate) => {
      if (
        candidate.end < node.pos
        && ts.isCallExpression(candidate)
        && normalize(candidate.expression.getText(ast)) === 'ContactService.resolveContact'
      ) matches.push(candidate)
    })
    if (matches.length > 0) return matches.at(-1)
  }
  return undefined
}

function profileCatch(catchText, profiles) {
  if (normalize(catchText) === '{}') return '<empty>'
  return Object.keys(profiles).find((marker) => marker !== '<empty>' && catchText.includes(marker))
}

function allSourceFiles(directory) {
  const results = []
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry)
    if (statSync(absolute).isDirectory()) results.push(...allSourceFiles(absolute))
    else if (/\.tsx?$/.test(entry)) results.push(absolute)
  }
  return results
}

const analyses = new Map()
for (const [relative, expected] of Object.entries(consumers)) {
  const source = readFileSync(path.join(root, relative), 'utf8')
  const ast = sourceFile(relative, source)
  const calls = []
  visit(ast, (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'ensureConversationContactLinkV1'
    ) calls.push(node)
  })
  analyses.set(relative, { source, ast, calls, expected })
}

check('the exact seven accepted consumers import both public symbols once', () => {
  assert.equal(analyses.size, 7)
  for (const [relative, { ast }] of analyses) {
    assert.equal(
      namedImportCount(ast, '@/contracts/messaging/v1', 'ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1'),
      1,
      `${relative}: command import`,
    )
    assert.equal(
      namedImportCount(ast, '@/modules/messaging/public/v1', 'ensureConversationContactLinkV1'),
      1,
      `${relative}: facade import`,
    )
  }
})

check('there are exactly twelve public calls with the frozen per-consumer distribution', () => {
  let total = 0
  for (const [relative, { calls, expected }] of analyses) {
    assert.equal(calls.length, expected.count, `${relative}: call count`)
    total += calls.length
  }
  assert.equal(total, 12)
})

check('every call is awaited and its result remains intentionally unused', () => {
  for (const [relative, { calls }] of analyses) {
    for (const call of calls) {
      assert.ok(ts.isAwaitExpression(call.parent), `${relative}: call must be awaited`)
      assert.ok(ts.isExpressionStatement(call.parent.parent), `${relative}: result must remain unused`)
    }
  }
})

check('all twelve payloads have exactly the frozen public fields and owner mappings', () => {
  for (const [relative, { ast, calls, expected }] of analyses) {
    const observedChatIds = []
    for (const call of calls) {
      assert.equal(call.arguments.length, 1, `${relative}: argument count`)
      const argument = call.arguments[0]
      assert.ok(ts.isObjectLiteralExpression(argument), `${relative}: literal command`)
      assert.equal(argument.properties.length, 4, `${relative}: exact command field count`)
      assert.ok(argument.properties.every(ts.isPropertyAssignment), `${relative}: no spread or shorthand`)
      const properties = Object.fromEntries(argument.properties.map((property) => [
        propertyName(property),
        normalize(property.initializer.getText(ast)),
      ]))
      assert.deepEqual(Object.keys(properties), ['contract', 'chatId', 'contactId', 'contactIdentityId'])
      assert.equal(properties.contract, 'ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1')
      assert.equal(properties.contactId, 'contactResult.contact.id')
      assert.equal(properties.contactIdentityId, 'contactResult.identity.id')
      observedChatIds.push(properties.chatId)
    }
    assert.deepEqual(observedChatIds.sort(), [...expected.chatIds].sort(), `${relative}: chat mapping`)
  }
})

check('every link remains after ContactService.resolveContact in the same lexical flow', () => {
  for (const [relative, { ast, calls }] of analyses) {
    for (const call of calls) {
      const resolve = precedingLegacyResolve(call, ast)
      assert.ok(resolve, `${relative}:${ast.getLineAndCharacterOfPosition(call.pos).line + 1}: resolve missing`)
      assert.ok(resolve.end < call.pos, `${relative}: resolve/link order`)
      const resolveTry = enclosingTryBody(resolve)
      const linkTry = enclosingTryBody(call)
      assert.ok(linkTry, `${relative}: link must remain in a try body`)
      assert.equal(resolveTry, linkTry, `${relative}: resolve and link catch scopes diverged`)
    }
  }
})

check('the accepted catch and swallow scopes retain their exact distribution', () => {
  for (const [relative, { ast, calls, expected }] of analyses) {
    const observed = {}
    for (const call of calls) {
      const statement = enclosingTryBody(call)
      assert.ok(statement?.catchClause, `${relative}: catch missing`)
      const catchText = statement.catchClause.block.getText(ast)
      assert.doesNotMatch(catchText, /\bthrow\b/, `${relative}: catch must continue to swallow`)
      const profile = profileCatch(catchText, expected.catchProfiles)
      assert.ok(profile, `${relative}: unexpected catch scope: ${catchText.slice(0, 160)}`)
      observed[profile] = (observed[profile] ?? 0) + 1
    }
    assert.deepEqual(observed, expected.catchProfiles, `${relative}: catch distribution`)
  }
})

check('no legacy ContactService.ensureChatLinked call or definition remains', () => {
  for (const absolute of allSourceFiles(consumerRoot)) {
    const source = readFileSync(absolute, 'utf8')
    assert.doesNotMatch(source, /ContactService\s*\.\s*ensureChatLinked\b/, path.relative(root, absolute))
    assert.doesNotMatch(source, /static\s+async\s+ensureChatLinked\b/, path.relative(root, absolute))
  }
})

check('no undisclosed public caller exists outside the seven accepted consumers', () => {
  const observed = []
  for (const absolute of allSourceFiles(consumerRoot)) {
    const relative = path.relative(root, absolute)
    const source = readFileSync(absolute, 'utf8')
    const ast = sourceFile(relative, source)
    visit(ast, (node) => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'ensureConversationContactLinkV1'
      ) observed.push(relative)
    })
  }
  assert.deepEqual(observed.sort(), Object.entries(consumers)
    .flatMap(([relative, expected]) => Array(expected.count).fill(relative))
    .sort())
})

check('the Contacts owner does not import its new Messaging consumer', () => {
  const paths = [
    ...allSourceFiles(path.join(root, 'gravity-mvp/src/contracts/contacts')),
    ...allSourceFiles(path.join(root, 'gravity-mvp/src/modules/contacts')),
    path.join(root, 'gravity-mvp/src/lib/ContactService.ts'),
  ]
  for (const absolute of paths) {
    const source = readFileSync(absolute, 'utf8')
    assert.doesNotMatch(source, /from\s*['"]@\/(?:contracts|modules)\/messaging\//, path.relative(root, absolute))
  }
})

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
