#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { validateContractRegistry } from './validate-contract-registry.mjs'

const index = JSON.parse(await readFile('architecture/contexts/v1/context-index.json', 'utf8'))
const registry = JSON.parse(await readFile('architecture/contracts/v1/registry.json', 'utf8'))
const manifests = await Promise.all(index.contexts.map((entry) => readFile(entry.path, 'utf8').then(JSON.parse)))
assert.equal(validateContractRegistry(registry, manifests).status, 'PASS')

const missingSurface = structuredClone(registry)
missingSurface.context_surfaces.pop()
assert.throws(() => validateContractRegistry(missingSurface, manifests), /coverage mismatch/)

const missingInteraction = structuredClone(registry)
missingInteraction.interactions.pop()
assert.throws(() => validateContractRegistry(missingInteraction, manifests), /interaction coverage mismatch/)

const widenedCapability = structuredClone(registry)
widenedCapability.context_surfaces[0].capabilities.push('GenericInternalAccess.v1')
assert.throws(() => validateContractRegistry(widenedCapability, manifests), /public capability drift/)

const providerLeak = structuredClone(registry)
providerLeak.context_surfaces[0].source_roots.push('WhatsAppService')
assert.throws(() => validateContractRegistry(providerLeak, manifests), /provider implementation leaked/)

process.stdout.write('contract registry: PASS (4 negative properties)\n')
