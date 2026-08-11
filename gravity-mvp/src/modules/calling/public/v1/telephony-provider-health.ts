import { getEslConnection } from '@/lib/freeswitch/EslClient'

export interface MegafonTelephonyHealthV1 {
  eslConnected: boolean
  megafonRegistrationState: string | null
}
/**
 * Read the fixed FreeSWITCH/Megafon health projection used by Settings.
 * The raw ESL connection and arbitrary API command capability never escape.
 */
export async function readMegafonTelephonyHealthV1(): Promise<MegafonTelephonyHealthV1> {
  const connection = getEslConnection()
  if (!connection) return { eslConnected: false, megafonRegistrationState: null }

  const raw = await new Promise<string>((resolve) => {
    connection.api('sofia status gateway megafon', (response: unknown) => {
      const candidate = response as { getBody?: () => unknown } | null
      const body = typeof candidate?.getBody === 'function' ? candidate.getBody() : String(response)
      resolve(String(body))
    })
  })
  const stateLine = /^\s*State\s+(.+?)\s*$/m.exec(raw)
  if (stateLine) return { eslConnected: true, megafonRegistrationState: stateLine[1].trim() }
  const statusLine = /^\s*Status\s+(.+?)\s*$/m.exec(raw)
  return {
    eslConnected: true,
    megafonRegistrationState: statusLine ? statusLine[1].trim() : null,
  }
}
