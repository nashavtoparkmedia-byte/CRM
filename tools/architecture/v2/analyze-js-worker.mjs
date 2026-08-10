import { analyzePrismaWriteSites } from './write-analyzer.mjs'

function send(message) {
  if (typeof process.send === 'function') process.send(message)
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
      sites: analysis.sites,
      diagnostics: analysis.diagnostics,
      source_sha256: analysis.source_sha256,
    })
    process.disconnect?.()
  } catch (error) {
    send({
      ok: false,
      task_id: task?.task_id ?? null,
      file: task?.file_name ?? null,
      error: error?.stack ?? error?.message ?? String(error),
    })
    process.exitCode = 1
    process.disconnect?.()
  }
})
