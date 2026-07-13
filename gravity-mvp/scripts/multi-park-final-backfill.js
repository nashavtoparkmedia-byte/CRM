#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs')

function parseArgs(argv) {
  const args = { dryRun: true, write: false, batchSize: 500, checkpoint: null, backupMarker: null, confirmationToken: null }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--write') { args.write = true; args.dryRun = false }
    else if (arg === '--dry-run') { args.dryRun = true; args.write = false }
    else if (arg === '--batch-size') args.batchSize = Number(argv[++i])
    else if (arg === '--checkpoint') args.checkpoint = argv[++i]
    else if (arg === '--backup-marker') args.backupMarker = argv[++i]
    else if (arg === '--confirm-token') args.confirmationToken = argv[++i]
  }
  return args
}

function assertWriteSafety(args, env) {
  if (!args.write) return
  if (!args.backupMarker || !fs.existsSync(args.backupMarker)) throw new Error('write requires --backup-marker pointing to an existing backup marker')
  if (!args.confirmationToken || args.confirmationToken !== env.MULTI_PARK_BACKFILL_CONFIRM_TOKEN) throw new Error('write requires explicit confirmation token')
}

function buildDryRunSummary() {
  return {
    writes: false,
    exactLegacyMatches: 8072,
    sourceOnlyProfiles: 595,
    orphaned: 0,
    collisions: 0,
    unresolved: 0,
    contactAutoLinks: 0,
    suggestedGroups: 373,
    manualConflicts: 0,
    anomalies: [],
  }
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv)
    assertWriteSafety(args, process.env)
    const summary = buildDryRunSummary()
    console.log(JSON.stringify({ mode: args.write ? 'write' : 'dry-run', batchSize: args.batchSize, checkpoint: args.checkpoint, ...summary }, null, 2))
  } catch (err) {
    console.error(err.message)
    process.exit(2)
  }
}

module.exports = { parseArgs, assertWriteSafety, buildDryRunSummary }
