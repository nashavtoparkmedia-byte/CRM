import { analyzePrismaWriteSites } from './write-analyzer.mjs'
import { javascriptDatabaseCommandSites } from './analyze.mjs'

// Reply once, then disconnect only after the reply has been handed to the IPC
// channel. The task is always queued before this listener exists, so Node
// delivers it from its pending-message replay; disconnecting synchronously
// inside that replay nulls the channel under it and crashes the worker
// (TypeError ... kPendingMessages, Node 20.20.2) after a valid reply.
function send(message) {
  if (typeof process.send !== 'function') return
  process.send(message, () => {
    if (process.connected) process.disconnect()
  })
}

process.once('message', (task) => {
  try {
    const analysis = analyzePrismaWriteSites(task.source_text, {
      fileName: task.file_name,
      knownModels: task.known_models,
      relationFields: task.relation_fields,
    })
    send({
      ok: true,
      task_id: task.task_id,
      file: task.file_name,
      sites: [
        ...analysis.sites,
        ...javascriptDatabaseCommandSites({ path: task.file_name }, task.source_text),
      ],
      diagnostics: analysis.diagnostics,
      source_sha256: analysis.source_sha256,
    })
  } catch (error) {
    send({
      ok: false,
      task_id: task?.task_id ?? null,
      file: task?.file_name ?? null,
      error: error?.stack ?? error?.message ?? String(error),
    })
    process.exitCode = 1
  }
})
