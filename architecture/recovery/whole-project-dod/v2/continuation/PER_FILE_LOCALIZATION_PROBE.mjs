import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repositoryRoot = process.cwd()
const target = process.argv[2]
if (!target) throw new Error('target file is required')

const analyzerUrl = pathToFileURL(path.join(repositoryRoot, 'tools/architecture/v2/write-analyzer.mjs')).href
const { analyzePrismaWriteSites } = await import(analyzerUrl)
const prismaFiles = execFileSync('git', ['ls-files', '--', '*.prisma'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim().split('\n').filter(Boolean)
const models = new Map()
for (const prismaFile of prismaFiles) {
  const source = readFileSync(path.join(repositoryRoot, prismaFile), 'utf8')
  for (const match of source.matchAll(/^model\s+([A-Za-z_][\w]*)\s*\{([\s\S]*?)^\}/gmu)) {
    models.set(match[1], match[2])
  }
}
const knownModels = [...models.keys()]
const modelNames = new Set(knownModels)
const relationFields = []
for (const [model, body] of models) for (const line of body.split('\n')) {
  const field = /^\s*([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*)(?:\[\]|\?)?/u.exec(line)
  if (!field || !modelNames.has(field[2])) continue
  relationFields.push(`${model.replace(/_/gu, '').toLowerCase()}.${field[1].replace(/_/gu, '').toLowerCase()}`)
}

analyzePrismaWriteSites(readFileSync(path.join(repositoryRoot, target), 'utf8'), {
  fileName: target,
  knownModels,
  relationFields,
})
