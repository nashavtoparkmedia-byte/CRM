import { getEslConnection } from '@/lib/freeswitch/EslClient'

export interface MegafonTelephonyHealthV1 {
  eslConnected: boolean
  megafonRegistrationState: string | null
}

export async function readMegafonTelephonyHealth(): Promise<MegafonTelephonyHealthV1> {
  const connection = getEslConnection()
  if (!connection) return { eslConnected: false, megafonRegistrationState: null }
  const raw = await new Promise<string>((resolve) => {
    connection.api('sofia status gateway megafon', (response: unknown) => {
      const candidate = response as { getBody?: () => unknown } | null
      resolve(typeof candidate?.getBody === 'function' ? String(candidate.getBody()) : String(response))
    })
  })
  const stateLine = /^\s*State\s+(.+?)\s*$/m.exec(raw)
  if (stateLine) return { eslConnected: true, megafonRegistrationState: stateLine[1].trim() }
  const statusLine = /^\s*Status\s+(.+?)\s*$/m.exec(raw)
  return { eslConnected: true, megafonRegistrationState: statusLine ? statusLine[1].trim() : null }
}

export async function rescanMegafonTelephonyGateway(): Promise<{ ok: boolean; error?: string }> {
  try {
    const connection = getEslConnection()
    if (!connection) return { ok: false, error: 'ESL not connected' }
    await new Promise<void>((resolve) => connection.api('sofia profile external killgw megafon', () => resolve()))
    await new Promise<void>((resolve) => connection.api('sofia profile external rescan', () => resolve()))
    return { ok: true }
  } catch (error: any) { return { ok: false, error: error?.message ?? String(error) } }
}
