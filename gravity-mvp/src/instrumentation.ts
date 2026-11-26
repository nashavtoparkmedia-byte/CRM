/** Runtime dispatcher for Next.js instrumentation. Keep Node-only APIs out of Edge bundles. */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNodeRuntime } = await import('./instrumentation.node')
    await registerNodeRuntime()
  }
}
