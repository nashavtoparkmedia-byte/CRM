#!/usr/bin/env node
import { validateProductionMigrationAuthority } from './production-migration-authority.mjs'

validateProductionMigrationAuthority(process.cwd())
  .then((result) => process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`))
  .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
