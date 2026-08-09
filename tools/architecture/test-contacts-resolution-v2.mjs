#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const root = process.cwd(), output = mkdtempSync(path.join(tmpdir(), 'yoko-contact-v2-'))
const sources = ['gravity-mvp/src/contracts/contacts/v2/resolve-contact-command.ts','gravity-mvp/src/contracts/contacts/v2/index.ts','gravity-mvp/src/modules/contacts/public/v2/resolve-contact-handler.ts'].map(v=>path.join(root,v))
const compile=spawnSync(process.execPath,[path.join(root,'gravity-mvp/node_modules/typescript/bin/tsc'),'--target','ES2022','--module','commonjs','--moduleResolution','node','--strict','--skipLibCheck','--rootDir',path.join(root,'gravity-mvp/src'),'--outDir',output,...sources],{encoding:'utf8'})
if(compile.status!==0){process.stderr.write(compile.stdout+compile.stderr);rmSync(output,{recursive:true,force:true});process.exit(1)}
const require=createRequire(import.meta.url), c=require(path.join(output,'contracts/contacts/v2/index.js')), {createResolveContactHandlerV2}=require(path.join(output,'modules/contacts/public/v2/resolve-contact-handler.js'))
const checks=[], check=(n,f)=>{f();checks.push(n)}, checkAsync=async(n,f)=>{await f();checks.push(n)}
try {
 const command={contract:c.RESOLVE_CONTACT_COMMAND_V2,operation:c.PROMOTE_CHANNEL_DISPLAY_NAME_V2,contactId:'c1',candidateDisplayName:'@driver'}
 check('v2 identifiers explicit',()=>assert.equal(c.RESOLVE_CONTACT_COMMAND_V2,'contacts.ResolveContactCommand.v2'))
 check('valid v2 parses',()=>assert.deepEqual(c.parseResolveContactCommandV2(command),command))
 check('v1 cannot enter v2 parser',()=>assert.throws(()=>c.parseResolveContactCommandV2({...command,contract:'contacts.ResolveContactCommand.v1'}),(e)=>e.code==='UNSUPPORTED_CONTRACT_VERSION'))
 check('unknown operation fails',()=>assert.throws(()=>c.parseResolveContactCommandV2({...command,operation:'promote_placeholder_display_name'})))
 check('unknown field fails',()=>assert.throws(()=>c.parseResolveContactCommandV2({...command,provider:'telegram'})))
 const calls=[], handler=createResolveContactHandlerV2({async promoteChannelDisplayName(v){calls.push(v);return 'updated'}})
 await checkAsync('handler forwards neutral fields',async()=>{const r=await handler(command);assert.deepEqual(calls,[{contactId:'c1',candidateDisplayName:'@driver'}]);assert.equal(r.status,'updated')})
 await checkAsync('no-op statuses explicit',async()=>{for(const status of ['not_found','preserved'])assert.equal((await createResolveContactHandlerV2({async promoteChannelDisplayName(){return status}})(command)).status,status)})
 await checkAsync('invalid never reaches port',async()=>{const n=calls.length;await assert.rejects(handler({...command,contactId:''}));assert.equal(calls.length,n)})
 await checkAsync('owner failures visible',async()=>await assert.rejects(createResolveContactHandlerV2({async promoteChannelDisplayName(){throw new Error('owner unavailable')}})(command),/owner unavailable/))
} finally {rmSync(output,{recursive:true,force:true})}
process.stdout.write(`${JSON.stringify({status:'PASS',passed:checks.length,checks},null,2)}\n`)
