import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputRoot = path.join(repoRoot, 'architecture/evidence/v1');
const rulesPath = path.join(outputRoot, 'module-rules.json');
const ownershipPath = path.join(outputRoot, 'ownership-rules.json');
const baselinePath = path.join(repoRoot, 'architecture/baseline/v1/authoritative-baseline.json');

const codeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const textExtensions = new Set([
  ...codeExtensions,
  '.prisma', '.sql', '.toml', '.json', '.yml', '.yaml', '.xml', '.conf', '.css', '.sh', '.py', '.properties',
]);
const readMethods = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);
const writeMethods = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);
const rawReadMethods = new Set(['$queryRaw', '$queryRawUnsafe']);
const rawWriteMethods = new Set(['$executeRaw', '$executeRawUnsafe']);
const credentialName = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|SESSION|COOKIE|DATABASE_URL|DSN|AUTH|SIP_)/i;
const credentialModel = /(Connection|ProviderSetting|AgentConfig|TelephonyAiConfig|avito_auth|Account$)/i;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

async function writeJson(name, value) {
  await writeFile(path.join(outputRoot, name), `${JSON.stringify(stable(value), null, 2)}\n`);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function lineAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text.charCodeAt(cursor) === 10) line += 1;
  return line;
}

function maskComments(text) {
  const output = [...text];
  let state = 'code';
  let escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const current = output[index];
    const next = output[index + 1];
    if (state === 'line_comment') {
      if (current === '\n') state = 'code';
      else output[index] = ' ';
      continue;
    }
    if (state === 'block_comment') {
      if (current === '*' && next === '/') {
        output[index] = ' ';
        output[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (current !== '\n') output[index] = ' ';
      continue;
    }
    if (state !== 'code') {
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if ((state === 'single' && current === "'") || (state === 'double' && current === '"') || (state === 'template' && current === '`')) state = 'code';
      continue;
    }
    if (current === '/' && next === '/') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      state = 'line_comment';
    } else if (current === '/' && next === '*') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      state = 'block_comment';
    } else if (current === "'") state = 'single';
    else if (current === '"') state = 'double';
    else if (current === '`') state = 'template';
  }
  return output.join('');
}

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory, excludes, result = []) {
  if (!(await exists(directory))) return result;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (excludes.has(entry.name) || entry.name === '.git') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute, excludes, result);
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name)) && entry.name !== 'package-lock.json') result.push(absolute);
  }
  return result;
}

function sourceRole(relative, rules) {
  if (rules.test_path_patterns.some((pattern) => relative.includes(pattern))) return 'test';
  if (rules.legacy_path_patterns.some((pattern) => relative.includes(pattern))) return 'legacy';
  if (relative.includes('/scripts/') || relative.endsWith('.sh') || relative.endsWith('.py')) return 'script';
  if (!codeExtensions.has(path.extname(relative))) return 'configuration';
  return 'production';
}

function moduleFor(relative, compiledRules) {
  return compiledRules.find((rule) => rule.regex.test(relative))?.id ?? 'unclassified';
}

function extractImports(text) {
  const found = [];
  const patterns = [
    { kind: 'static', regex: /\bimport\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g },
    { kind: 'export', regex: /\bexport\s+[^'";]*?\s+from\s+['"]([^'"]+)['"]/g },
    { kind: 'require', regex: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
    { kind: 'dynamic', regex: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
  ];
  const seen = new Set();
  for (const { kind, regex } of patterns) {
    for (const match of text.matchAll(regex)) {
      const key = `${match.index}:${match[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ kind, specifier: match[1], index: match.index });
    }
  }
  return found.sort((a, b) => a.index - b.index || a.specifier.localeCompare(b.specifier));
}

function resolveImport(source, specifier, fileSet) {
  let base;
  if (specifier.startsWith('.')) base = path.resolve(path.dirname(path.join(repoRoot, source)), specifier);
  else if (specifier.startsWith('@/') && source.startsWith('gravity-mvp/')) base = path.join(repoRoot, 'gravity-mvp/src', specifier.slice(2));
  else return { relationship: 'external', target: specifier };

  const candidates = [base];
  if (/\.[cm]?js$/.test(base)) {
    const withoutJs = base.replace(/\.[cm]?js$/, '');
    for (const extension of ['.ts', '.tsx', '.mts', '.cts']) candidates.push(`${withoutJs}${extension}`);
  }
  for (const extension of codeExtensions) candidates.push(`${base}${extension}`);
  for (const extension of codeExtensions) candidates.push(path.join(base, `index${extension}`));
  for (const candidate of candidates) {
    const relative = path.relative(repoRoot, candidate).split(path.sep).join('/');
    if (fileSet.has(relative)) return { relationship: 'internal', target: relative };
  }
  return { relationship: 'unresolved_internal', target: path.relative(repoRoot, base).split(path.sep).join('/') };
}

function extractPrismaSites(file, module, role, text, schema, modelLookup, ownerRules, legacyPatterns) {
  const records = [];
  const methods = uniqueSorted([...readMethods, ...writeMethods]).join('|');
  const callPattern = new RegExp(`\\b(?:req\\.)?(?:prisma|prismaClient|tx|db)|this\\.prisma`, 'g');
  for (const clientMatch of text.matchAll(callPattern)) {
    const tail = text.slice(clientMatch.index + clientMatch[0].length);
    const operation = tail.match(new RegExp(`^\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\.\\s*(${methods})\\b`));
    if (!operation) continue;
    const modelToken = operation[1];
    const model = modelLookup.get(modelToken.toLowerCase()) ?? modelToken;
    const method = operation[2];
    const access = writeMethods.has(method) ? 'WRITE' : 'READ';
    const owner = ownerRules.rules[model] ?? 'UNRESOLVED';
    let classification = 'READ_ONLY';
    if (access === 'WRITE') {
      if (role === 'legacy' || legacyPatterns.some((pattern) => file.includes(pattern))) classification = 'LEGACY';
      else if (owner === 'UNRESOLVED' || ownerRules.shared_or_ambiguous.includes(model)) classification = 'SHARED_AMBIGUOUS';
      else if (owner === module) classification = 'OWNER';
      else classification = 'FOREIGN';
    }
    records.push({
      access,
      classification,
      file,
      line: lineAt(text, clientMatch.index),
      method,
      model,
      module,
      owner_candidate: owner,
      role,
      schema,
      style: 'PRISMA_MODEL_API',
    });
  }

  const rawPattern = /\b(?:prisma|prismaClient|tx|db)\s*\.\s*(\$(?:queryRaw|queryRawUnsafe|executeRaw|executeRawUnsafe))\b/g;
  for (const match of text.matchAll(rawPattern)) {
    const method = match[1];
    const callTail = text.slice(match.index + match[0].length, match.index + match[0].length + 2400);
    const firstTick = callTail.indexOf('`');
    const closingTick = firstTick >= 0 ? callTail.indexOf('`', firstTick + 1) : -1;
    const snippet = firstTick >= 0 && closingTick > firstTick
      ? callTail.slice(firstTick + 1, closingTick)
      : callTail.slice(0, 900);
    const tableMatches = [
      ...[...snippet.matchAll(/(?:FROM|JOIN|UPDATE|INTO|DELETE\s+FROM)\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi)].map((item) => item[1]),
      ...[...snippet.matchAll(/TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi)].map((item) => item[1]),
    ];
    const models = uniqueSorted(tableMatches.map((token) => modelLookup.get(token.toLowerCase())).filter(Boolean));
    const unresolvedTableTokens = uniqueSorted(tableMatches.filter((token) => !modelLookup.has(token.toLowerCase())));
    const owners = uniqueSorted(models.map((model) => ownerRules.rules[model] ?? 'UNRESOLVED'));
    const access = rawWriteMethods.has(method) ? 'WRITE' : 'READ';
    let classification = 'READ_ONLY';
    if (access === 'WRITE') {
      if (role === 'legacy' || legacyPatterns.some((pattern) => file.includes(pattern))) classification = 'LEGACY';
      else if (owners.length !== 1 || owners[0] === 'UNRESOLVED') classification = 'SHARED_AMBIGUOUS';
      else if (owners[0] === module) classification = 'OWNER';
      else classification = 'FOREIGN';
    }
    records.push({
      access,
      classification,
      file,
      line: lineAt(text, match.index),
      method,
      models,
      module,
      owner_candidates: owners,
      unresolved_table_tokens: unresolvedTableTokens,
      role,
      schema,
      style: 'PRISMA_RAW_SQL',
    });
  }
  return records;
}

function extractEnvironment(file, module, role, text) {
  const records = [];
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
    /\benv\(['"]([A-Z][A-Z0-9_]*)['"]\)/g,
  ];
  const seen = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const key = `${match.index}:${match[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ file, line: lineAt(text, match.index), module, name: match[1], role, sensitive_name: credentialName.test(match[1]) });
    }
  }
  return records;
}

function extractApiRoutes(file, module, role, text) {
  const records = [];
  if (/gravity-mvp\/src\/app\/api\/.+\/route\.(?:ts|js)$/.test(file)) {
    const route = `/${file.replace(/^gravity-mvp\/src\/app\/api\//, '').replace(/\/route\.(?:ts|js)$/, '').replace(/\[([^\]]+)\]/g, ':$1')}`;
    const methods = uniqueSorted([...text.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)].map((match) => match[1]));
    records.push({ file, framework: 'next', methods, module, role, route: `/api${route === '/route.ts' ? '' : route}` });
  }
  if (/^tg-bot\/tg-bot-frontend\/pages\/api\/.+\.js$/.test(file)) {
    records.push({
      file,
      framework: 'next-pages',
      methods: ['DYNAMIC_HANDLER'],
      module,
      role,
      route: `/${file.replace(/^tg-bot\/tg-bot-frontend\/pages\//, '').replace(/\.js$/, '').replace(/\/index$/, '')}`,
    });
  }
  const expressPattern = /\b(?:app|router)\s*\.\s*(get|post|put|patch|delete|use)\s*\(\s*['"]([^'"]+)['"]/gi;
  for (const match of text.matchAll(expressPattern)) {
    records.push({ file, framework: 'express', line: lineAt(text, match.index), methods: [match[1].toUpperCase()], module, role, route: match[2] });
  }
  return records;
}

function extractRuntimeInteractions(file, module, role, text, globalStringConstants) {
  const background = [];
  const queueEvents = [];
  const coupling = [];
  const stringConstants = new Map([
    ...globalStringConstants,
    ...[...text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*['"]([^'"]+)['"]/g)].map((match) => [match[1], match[2]]),
  ]);
  const backgroundPatterns = [
    ['interval', /\bsetInterval\s*\(/g],
    ['timeout', /\bsetTimeout\s*\(/g],
    ['bullmq_worker', /\bnew\s+Worker(?:<[^>]+>)?\s*\(/g],
  ];
  for (const [kind, pattern] of backgroundPatterns) {
    for (const match of text.matchAll(pattern)) background.push({ file, kind, line: lineAt(text, match.index), module, role });
  }
  if (file.includes('/api/cron/')) background.push({ file, kind: 'cron_route', line: 1, module, role });
  if (/(?:^|\/)worker\.(?:ts|js)$/.test(file)) background.push({ file, kind: 'worker_entrypoint', line: 1, module, role });
  const queueDeclaration = /(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*new\s+Queue(?:<[^>]+>)?\s*\(\s*([A-Z][A-Z0-9_]*|['"]([^'"]+)['"])/g;
  for (const match of text.matchAll(queueDeclaration)) {
    const identifier = match[2].replace(/^['"]|['"]$/g, '');
    queueEvents.push({ file, kind: 'queue_declaration', line: lineAt(text, match.index), module, name: stringConstants.get(identifier) ?? match[3] ?? identifier, reference: match[1], role });
  }
  const workerDeclaration = /\bnew\s+Worker(?:<[^>]+>)?\s*\(\s*([A-Z][A-Z0-9_]*|['"]([^'"]+)['"])/g;
  for (const match of text.matchAll(workerDeclaration)) {
    const identifier = match[1].replace(/^['"]|['"]$/g, '');
    queueEvents.push({ file, kind: 'queue_consumer', line: lineAt(text, match.index), module, name: stringConstants.get(identifier) ?? match[2] ?? identifier, role });
  }
  const emitterDeclaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+EventEmitter\s*\(/g;
  for (const match of text.matchAll(emitterDeclaration)) {
    queueEvents.push({ file, kind: 'event_emitter', line: lineAt(text, match.index), module, name: match[1], role });
  }
  const namedEventPatterns = [
    ['queue_add', /\b([A-Za-z_$][\w$]*(?:\(\))?)\.add\s*\(\s*['"]([^'"]+)['"]/g, 2],
    ['event_emit', /\.emit\s*\(\s*['"]([^'"]+)['"]/g, 1],
    ['event_subscribe', /\.(?:on|once)\s*\(\s*['"]([^'"]+)['"]/g, 1],
  ];
  for (const [kind, pattern, group] of namedEventPatterns) {
    for (const match of text.matchAll(pattern)) {
      queueEvents.push({ file, kind, line: lineAt(text, match.index), module, name: match[group], reference: kind === 'queue_add' ? match[1].replace(/\(\)$/, '') : null, role });
    }
  }
  const urlPattern = /https?:\/\/([A-Za-z0-9._-]+)(?::(\d+))?/g;
  for (const match of text.matchAll(urlPattern)) {
    coupling.push({ file, host: match[1], line: lineAt(text, match.index), module, port: match[2] ?? null, role, type: 'literal_url_host' });
  }
  const servicePattern = /\b(crm-(?:gravity-mvp|tg-bot|tg-bot-frontend|max-scraper|max-personal-gateway|yfs-api|yfs-worker|audio-bridge|freeswitch|nginx))\b/g;
  for (const match of text.matchAll(servicePattern)) {
    coupling.push({ file, line: lineAt(text, match.index), module, role, service: match[1], type: 'container_name_literal' });
  }
  const proxyPattern = /proxy_pass\s+http:\/\/([A-Za-z0-9._-]+)(?::(\d+))?/g;
  for (const match of text.matchAll(proxyPattern)) {
    coupling.push({ file, host: match[1], line: lineAt(text, match.index), module, port: match[2] ?? null, role, type: 'nginx_proxy_pass' });
  }
  return { background, queueEvents, coupling };
}

function stronglyConnected(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node, []]));
  for (const [source, target] of edges) if (adjacency.has(source) && adjacency.has(target)) adjacency.get(source).push(target);
  for (const targets of adjacency.values()) targets.sort();
  let index = 0;
  const stack = [];
  const indices = new Map();
  const low = new Map();
  const onStack = new Set();
  const components = [];
  function visit(node) {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of adjacency.get(node)) {
      if (!indices.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node), low.get(target)));
      } else if (onStack.has(target)) low.set(node, Math.min(low.get(node), indices.get(target)));
    }
    if (low.get(node) === indices.get(node)) {
      const component = [];
      let current;
      do {
        current = stack.pop();
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      component.sort();
      if (component.length > 1) components.push(component);
    }
  }
  for (const node of [...nodes].sort()) if (!indices.has(node)) visit(node);
  return components.sort((a, b) => a[0].localeCompare(b[0]));
}

async function main() {
  const [rulesBytes, ownershipBytes, baselineBytes, analyzerBytes] = await Promise.all([
    readFile(rulesPath), readFile(ownershipPath), readFile(baselinePath), readFile(fileURLToPath(import.meta.url)),
  ]);
  const rules = JSON.parse(rulesBytes);
  const ownerRules = JSON.parse(ownershipBytes);
  const baseline = JSON.parse(baselineBytes);
  const compiledRules = rules.modules.map((rule) => ({ ...rule, regex: new RegExp(rule.match) }));
  const excludes = new Set(rules.exclude_segments);
  const absoluteFiles = [];
  for (const root of rules.source_roots) await walk(path.join(repoRoot, root), excludes, absoluteFiles);
  const files = uniqueSorted(absoluteFiles.map((file) => path.relative(repoRoot, file).split(path.sep).join('/')));
  const fileSet = new Set(files);
  const contents = new Map();
  const inputs = [];
  for (const file of files) {
    const bytes = await readFile(path.join(repoRoot, file));
    const text = bytes.toString('utf8');
    contents.set(file, text);
    const metadata = await stat(path.join(repoRoot, file));
    inputs.push({ bytes: metadata.size, file, sha256: sha256(bytes) });
  }
  const sourceSnapshotSha = sha256(inputs.map((entry) => `${entry.sha256}  ${entry.file}\n`).join(''));

  const schemaFiles = ['gravity-mvp/prisma/schema.prisma', 'tg-bot/prisma/schema.prisma', 'yandex-fleet-scraper/prisma/schema.prisma'];
  const models = [];
  const modelLookup = new Map();
  for (const schemaFile of schemaFiles) {
    const schemaText = await readFile(path.join(repoRoot, schemaFile), 'utf8');
    for (const match of schemaText.matchAll(/^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\}/gm)) {
      const mappedTable = match[2].match(/@@map\(["']([^"']+)["']\)/)?.[1] ?? null;
      models.push({ mapped_table: mappedTable, model: match[1], owner_candidate: ownerRules.rules[match[1]] ?? 'UNRESOLVED', schema: schemaFile });
      modelLookup.set(match[1].toLowerCase(), match[1]);
      if (mappedTable) modelLookup.set(mappedTable.toLowerCase(), match[1]);
    }
  }
  for (const model of Object.keys(ownerRules.rules)) {
    if (!modelLookup.has(model.toLowerCase())) modelLookup.set(model.toLowerCase(), model);
  }

  const inventoryMap = new Map();
  const imports = [];
  const prismaSites = [];
  const environment = [];
  const apiRoutes = [];
  const background = [];
  const queueEvents = [];
  const coupling = [];
  const providerEvidence = new Map(Object.keys(rules.provider_patterns).map((provider) => [provider, []]));
  const globalStringConstants = new Map();
  for (const text of contents.values()) {
    for (const match of text.matchAll(/\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*['"]([^'"]+)['"]/g)) globalStringConstants.set(match[1], match[2]);
  }

  for (const file of files) {
    const text = contents.get(file);
    const codeText = codeExtensions.has(path.extname(file)) ? maskComments(text) : text;
    const module = moduleFor(file, compiledRules);
    const role = sourceRole(file, rules);
    const prismaSchema = file.startsWith('tg-bot/')
      ? 'tg-bot/prisma/schema.prisma'
      : file.startsWith('yandex-fleet-scraper/')
        ? 'yandex-fleet-scraper/prisma/schema.prisma'
        : 'gravity-mvp/prisma/schema.prisma';
    const moduleRule = compiledRules.find((rule) => rule.id === module);
    const current = inventoryMap.get(module) ?? { contexts: new Set(), extensions: new Map(), files: 0, lines: 0, roles: new Map(), roots: new Set() };
    current.files += 1;
    current.lines += text.split('\n').length;
    current.contexts.add(moduleRule?.context ?? 'unclassified');
    current.extensions.set(path.extname(file) || '(none)', (current.extensions.get(path.extname(file) || '(none)') ?? 0) + 1);
    current.roles.set(role, (current.roles.get(role) ?? 0) + 1);
    current.roots.add(rules.source_roots.find((root) => file === root || file.startsWith(`${root}/`)) ?? 'unresolved');
    inventoryMap.set(module, current);

    if (codeExtensions.has(path.extname(file))) {
      for (const entry of extractImports(codeText)) {
        const resolved = resolveImport(file, entry.specifier, fileSet);
        imports.push({
          file,
          kind: entry.kind,
          line: lineAt(codeText, entry.index),
          module,
          relationship: resolved.relationship,
          role,
          specifier: entry.specifier,
          target: resolved.target,
          target_module: resolved.relationship === 'internal' ? moduleFor(resolved.target, compiledRules) : null,
        });
      }
      prismaSites.push(...extractPrismaSites(file, module, role, codeText, prismaSchema, modelLookup, ownerRules, rules.legacy_path_patterns));
      apiRoutes.push(...extractApiRoutes(file, module, role, codeText));
    }
    environment.push(...extractEnvironment(file, module, role, codeText));
    const runtime = extractRuntimeInteractions(file, module, role, codeText, globalStringConstants);
    background.push(...runtime.background);
    queueEvents.push(...runtime.queueEvents);
    coupling.push(...runtime.coupling);
    for (const [provider, patterns] of Object.entries(rules.provider_patterns)) {
      for (const pattern of patterns) {
        const regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
        if (regex.test(codeText) || file.toLowerCase().includes(pattern.toLowerCase())) {
          providerEvidence.get(provider).push({
            file,
            indicator: pattern,
            match_kind: file.toLowerCase().includes(pattern.toLowerCase()) ? 'path' : 'content',
            module,
            role,
          });
        }
      }
    }
  }

  const moduleInventory = [...inventoryMap.entries()].map(([id, value]) => ({
    contexts: [...value.contexts].sort(),
    extensions: Object.fromEntries([...value.extensions.entries()].sort()),
    files: value.files,
    id,
    lines: value.lines,
    roles: Object.fromEntries([...value.roles.entries()].sort()),
    source_roots: [...value.roots].sort(),
  })).sort((a, b) => a.id.localeCompare(b.id));

  const moduleEdgeMap = new Map();
  for (const entry of imports.filter((item) => item.relationship === 'internal' && item.module !== item.target_module)) {
    const key = `${entry.module}\0${entry.target_module}`;
    const edge = moduleEdgeMap.get(key) ?? { count: 0, source: entry.module, source_files: new Set(), target: entry.target_module, target_files: new Set() };
    edge.count += 1;
    edge.source_files.add(entry.file);
    edge.target_files.add(entry.target);
    moduleEdgeMap.set(key, edge);
  }
  const moduleEdges = [...moduleEdgeMap.values()].map((edge) => ({ ...edge, source_files: [...edge.source_files].sort(), target_files: [...edge.target_files].sort() }))
    .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  const internalImports = imports.filter((entry) => entry.relationship === 'internal');
  const fileCycles = stronglyConnected(files, internalImports.map((entry) => [entry.file, entry.target]));
  const moduleIds = moduleInventory.map((entry) => entry.id);
  const moduleCycles = stronglyConnected(moduleIds, moduleEdges.map((edge) => [edge.source, edge.target]));

  const writeSites = prismaSites.filter((site) => site.access === 'WRITE');
  const readSites = prismaSites.filter((site) => site.access === 'READ');
  const declaredModelNames = new Set(models.map((model) => model.model));
  for (const rawModel of uniqueSorted(prismaSites.filter((site) => site.style === 'PRISMA_RAW_SQL').flatMap((site) => site.models ?? []))) {
    if (!declaredModelNames.has(rawModel)) {
      models.push({ mapped_table: rawModel, model: rawModel, owner_candidate: ownerRules.rules[rawModel] ?? 'UNRESOLVED', schema: 'runtime_raw_sql' });
      declaredModelNames.add(rawModel);
    }
  }
  const ownershipActual = [];
  for (const model of models) {
    const sites = prismaSites.filter((site) => (
      model.schema === 'runtime_raw_sql'
        ? site.style === 'PRISMA_RAW_SQL' && site.models?.includes(model.model)
        : site.schema === model.schema && (site.model === model.model || site.models?.includes(model.model))
    ));
    ownershipActual.push({
      ...model,
      id: `${model.schema}:${model.model}`,
      classifications: uniqueSorted(sites.filter((site) => site.access === 'WRITE').map((site) => site.classification)),
      reader_modules: uniqueSorted(sites.filter((site) => site.access === 'READ').map((site) => site.module)),
      writer_modules: uniqueSorted(sites.filter((site) => site.access === 'WRITE').map((site) => site.module)),
      write_sites: sites.filter((site) => site.access === 'WRITE').length,
    });
  }

  const inbound = new Map();
  for (const entry of internalImports) {
    const value = inbound.get(entry.target) ?? { importers: new Set(), modules: new Set() };
    value.importers.add(entry.file);
    value.modules.add(entry.module);
    inbound.set(entry.target, value);
  }
  const utilityHotspots = [...inbound.entries()].map(([file, value]) => ({
    file,
    importer_count: value.importers.size,
    importer_modules: [...value.modules].sort(),
    module: moduleFor(file, compiledRules),
  })).filter((item) => item.importer_count >= 5 || item.importer_modules.length >= 3)
    .sort((a, b) => b.importer_count - a.importer_count || a.file.localeCompare(b.file));
  const dataHotspots = ownershipActual.filter((item) => item.writer_modules.length > 1 || item.classifications.includes('SHARED_AMBIGUOUS') || item.classifications.includes('FOREIGN'))
    .sort((a, b) => b.writer_modules.length - a.writer_modules.length || a.model.localeCompare(b.model));

  const credentialDbAccess = prismaSites.filter((site) => {
    const names = site.model ? [site.model] : (site.models ?? []);
    return names.some((name) => credentialModel.test(name));
  });
  coupling.push(...environment.filter((entry) => /(?:HOST|URL|PORT)$/.test(entry.name)).map((entry) => ({
    file: entry.file,
    line: entry.line,
    module: entry.module,
    name: entry.name,
    role: entry.role,
    type: 'runtime_environment_reference',
  })));
  const routeRelationships = apiRoutes.map((route) => {
    const importsForRoute = imports.filter((entry) => entry.file === route.file && entry.relationship === 'internal');
    const dataForRoute = prismaSites.filter((site) => site.file === route.file);
    return {
      ...route,
      data_models: uniqueSorted(dataForRoute.flatMap((site) => site.model ? [site.model] : (site.models ?? []))),
      dependency_modules: uniqueSorted(importsForRoute.map((entry) => entry.target_module).filter(Boolean)),
      has_write: dataForRoute.some((site) => site.access === 'WRITE'),
    };
  });
  const queueNames = uniqueSorted(queueEvents.filter((entry) => ['queue_declaration', 'queue_consumer'].includes(entry.kind)).map((entry) => entry.name));
  const queueTopology = queueNames.map((name) => ({
    consumers: queueEvents.filter((entry) => entry.kind === 'queue_consumer' && entry.name === name).map((entry) => ({ file: entry.file, module: entry.module })),
    declarations: queueEvents.filter((entry) => entry.kind === 'queue_declaration' && entry.name === name).map((entry) => ({ file: entry.file, module: entry.module })),
    name,
    producers: queueEvents.filter((entry) => entry.kind === 'queue_add' && (
      entry.name === name
      || name.includes(entry.name)
      || queueEvents.some((declaration) => declaration.kind === 'queue_declaration' && declaration.name === name && declaration.reference === entry.reference)
    )).map((entry) => ({ file: entry.file, module: entry.module, operation: entry.name })),
  }));

  const common = {
    baseline_schema: baseline.schema,
    baseline_milestone: baseline.milestone,
    generated_from: 'CRM-ARCH-001 accepted composite baseline',
    schema_version: 1,
    source_snapshot_sha256: sourceSnapshotSha,
  };
  await mkdir(outputRoot, { recursive: true });
  await writeJson('module-inventory.json', { ...common, modules: moduleInventory, totals: { files: files.length, lines: moduleInventory.reduce((sum, item) => sum + item.lines, 0), modules: moduleInventory.length } });
  await writeJson('dependency-graph.json', {
    ...common,
    circular_dependencies: { file_components: fileCycles, module_components: moduleCycles },
    direct_imports: imports,
    module_edges: moduleEdges,
    totals: {
      circular_file_components: fileCycles.length,
      circular_module_components: moduleCycles.length,
      direct_imports: imports.length,
      external_imports: imports.filter((item) => item.relationship === 'external').length,
      internal_cross_module_imports: moduleEdges.reduce((sum, edge) => sum + edge.count, 0),
      internal_imports: internalImports.length,
      unresolved_internal_imports: imports.filter((item) => item.relationship === 'unresolved_internal').length,
    },
  });
  await writeJson('write-sites.json', {
    ...common,
    classification_policy: {
      FOREIGN: 'write from a module other than the model owner candidate',
      LEGACY: 'write from an explicitly legacy/debug path',
      OWNER: 'write from the model owner candidate',
      SHARED_AMBIGUOUS: 'raw/multi-owner or unresolved-owner write',
    },
    read_sites: readSites,
    totals: {
      by_classification: Object.fromEntries(['OWNER', 'FOREIGN', 'LEGACY', 'SHARED_AMBIGUOUS'].map((kind) => [kind, writeSites.filter((site) => site.classification === kind).length])),
      prisma_read_sites: readSites.length,
      prisma_write_sites: writeSites.length,
    },
    write_sites: writeSites,
  });
  await writeJson('data-ownership-candidates.json', { ...common, models: ownershipActual, notes: ownerRules.notes, totals: { models: ownershipActual.length, unresolved_owners: ownershipActual.filter((item) => item.owner_candidate === 'UNRESOLVED').length } });
  await writeJson('provider-dependencies.json', {
    ...common,
    providers: [...providerEvidence.entries()].map(([provider, evidence]) => ({
      evidence: evidence.sort((a, b) => a.file.localeCompare(b.file) || a.indicator.localeCompare(b.indicator)),
      files: uniqueSorted(evidence.map((entry) => entry.file)),
      modules: uniqueSorted(evidence.map((entry) => entry.module)),
      provider,
    })).sort((a, b) => a.provider.localeCompare(b.provider)),
  });
  await writeJson('credential-access.json', {
    ...common,
    database_credential_model_access: credentialDbAccess,
    environment_access: environment,
    safety: 'variable names and access sites only; values are never read or emitted',
    totals: { database_access_sites: credentialDbAccess.length, environment_access_sites: environment.length, sensitive_name_sites: environment.filter((entry) => entry.sensitive_name).length },
  });
  await writeJson('runtime-interactions.json', {
    ...common,
    api_route_relationships: routeRelationships,
    background_interactions: background,
    critical_runtime_coupling: coupling,
    queue_event_relationships: queueEvents,
    queue_topology: queueTopology,
    totals: { api_routes: routeRelationships.length, background_interactions: background.length, critical_runtime_couplings: coupling.length, queue_event_relationships: queueEvents.length, queues: queueTopology.length },
  });
  await writeJson('shared-hotspots.json', { ...common, shared_data_hotspots: dataHotspots, shared_utility_hotspots: utilityHotspots, totals: { shared_data_hotspots: dataHotspots.length, shared_utility_hotspots: utilityHotspots.length } });
  await writeJson('analysis-manifest.json', {
    ...common,
    analyzer: 'tools/architecture/analyze-architecture.mjs',
    input_files: inputs,
    inputs: {
      baseline: { path: 'architecture/baseline/v1/authoritative-baseline.json', sha256: sha256(baselineBytes) },
      analyzer: { path: 'tools/architecture/analyze-architecture.mjs', sha256: sha256(analyzerBytes) },
      module_rules: { path: 'architecture/evidence/v1/module-rules.json', sha256: sha256(rulesBytes) },
      ownership_rules: { path: 'architecture/evidence/v1/ownership-rules.json', sha256: sha256(ownershipBytes) },
    },
    outputs: ['module-inventory.json', 'dependency-graph.json', 'write-sites.json', 'data-ownership-candidates.json', 'provider-dependencies.json', 'credential-access.json', 'runtime-interactions.json', 'shared-hotspots.json'],
    totals: { files: inputs.length, input_bytes: inputs.reduce((sum, input) => sum + input.bytes, 0) },
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    files: files.length,
    modules: moduleInventory.length,
    prismaWrites: writeSites.length,
    sourceSnapshotSha256: sourceSnapshotSha,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
