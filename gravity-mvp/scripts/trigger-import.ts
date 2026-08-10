import http from 'node:http'
import { QUEUE_HISTORY_IMPORT_JOB_COMMAND_V1 } from '../src/contracts/messaging/v1'
import { queueHistoryImportJobV1 } from '../src/modules/messaging/public/v1'

async function launchImport(jobId: string, crmApiUrl: string, mode: 'available_history') {
  const body = JSON.stringify({ jobId, crmApiUrl, mode, daysBack: null })
  await new Promise<void>((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: 3005, path: '/import-history', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => { console.log('Scraper response:', data); resolve() })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function main() {
  const jobId = `job_${Date.now()}`
  const mode = 'available_history' as const
  const crmApiUrl = 'http://localhost:3002'
  await queueHistoryImportJobV1({ contract: QUEUE_HISTORY_IMPORT_JOB_COMMAND_V1, jobId, channels: ['max'], mode, daysBack: null, connectionId: null })
  console.log('Job создан:', jobId)
  await launchImport(jobId, crmApiUrl, mode)
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) })
