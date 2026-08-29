import assert from 'node:assert/strict'
import { compileArchitecture, classifySite } from './analyze.mjs'

const architecture = compileArchitecture({modules:[]}, [{context:{id:'telegram_channel'},owned_data:[],technical_modules:['telegram_bot']},{context:{id:'fleet_operations'},owned_data:[],technical_modules:[]}], {rules:{}}, {rules:[
  {id:'actions',source:'tg-bot/src/database.js',table:'actions',owner_context:'telegram_channel',allowed_operations:['CREATE_TABLE','INSERT','SELECT']},
  {id:'connection',source:'tg-bot/src/database.js',table:'connection_requests',owner_context:'fleet_operations',allowed_operations:[]},
]})
const surface = {path:'tg-bot/src/database.js',lifecycle:'APPLICATION_RUNTIME',disposition:null}
const source = {context:'telegram_channel'}
const site = (table, operation='INSERT') => ({kind:'raw',tables:[table],operations:[{table,operation}],ambiguous:false})
assert.equal(classifySite(site('actions'), surface, source, architecture).classification, 'OWNER')
assert.equal(classifySite(site('connection_requests'), surface, source, architecture).classification, 'FOREIGN')
assert.equal(classifySite(site('actions'), {...surface,path:'other/actions.js'}, source, architecture).classification, 'AMBIGUOUS')
assert.notEqual(classifySite(site('actions','DELETE'), surface, source, architecture).classification, 'OWNER')

const reviewedOwner = compileArchitecture(
  { modules: [] },
  [
    {
      context: { id: 'messaging' },
      owned_data: [],
      technical_modules: ['messages'],
    },
    {
      context: { id: 'fleet_operations' },
      owned_data: [{ model: 'CommunicationEvent', mapped_table: null }],
      technical_modules: ['drivers'],
    },
  ],
  { rules: { CommunicationEvent: 'messages' } },
)
assert.equal(
  classifySite(
    { kind: 'model', model: 'communicationEvent', candidate_models: [], ambiguous: false },
    { path: 'gravity-mvp/src/modules/fleet-operations/public/v1/adapter.ts', lifecycle: 'APPLICATION_RUNTIME', disposition: null },
    { context: 'fleet_operations' },
    reviewedOwner,
  ).classification,
  'OWNER',
  'reviewed manifest ownership must override a historical technical candidate',
)
process.stdout.write('scoped data ownership: PASS\n')
