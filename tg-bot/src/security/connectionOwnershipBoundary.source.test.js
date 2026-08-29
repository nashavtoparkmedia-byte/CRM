'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const database = fs.readFileSync(path.join(root, 'database.js'), 'utf8')
const handler = fs.readFileSync(path.join(root, 'handlers', 'connection.js'), 'utf8')
const userService = fs.readFileSync(path.join(root, 'services', 'userService.js'), 'utf8')
assert.doesNotMatch(database, /connection_requests/)
assert.doesNotMatch(database, /upsertConnectionLocal/)
assert.doesNotMatch(handler, /upsertConnectionLocal/)
assert.doesNotMatch(userService, /upsertConnectionLocal/)
assert.match(handler, /upsertConnectionRow/)
assert.match(handler, /Данные сохранены в Google Sheets/)
process.stdout.write('connection ownership boundary: PASS\n')
