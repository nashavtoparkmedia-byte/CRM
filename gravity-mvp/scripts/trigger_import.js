'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const entrypoint = path.join(__dirname, 'trigger-import.ts')
const runner = path.join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
const result = spawnSync(process.execPath, [runner, entrypoint, ...process.argv.slice(2)], { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
