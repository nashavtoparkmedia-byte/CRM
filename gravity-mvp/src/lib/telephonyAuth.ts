import crypto from 'crypto'
import { prisma } from '@/lib/prisma'
import { memLog as _flog } from '@/lib/telephonyMemLog'

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export async function authenticateDevice(
  request: Request
): Promise<{ deviceId: string } | null> {
  const auth = request.headers.get('authorization')

  if (!auth) {
    console.log('[telephony-auth] no-header')
    _flog('[telephony-auth] no-header')
    return null
  }
  if (!auth.startsWith('Bearer ')) {
    console.log('[telephony-auth] no-bearer prefix=', auth.slice(0, 20))
    _flog(`[telephony-auth] no-bearer prefix=${auth.slice(0, 20)}`)
    return null
  }

  const raw = auth.slice(7)
  console.log('[telephony-auth] token len=%d', raw.length)
  _flog(`[telephony-auth] token len=${raw.length}`)
  const hash = hashToken(raw)
  console.log('[telephony-auth] hash=%s', hash.slice(0, 12))
  _flog(`[telephony-auth] hash=${hash.slice(0, 12)}`)

  const device = await prisma.telephonyDevice.findUnique({
    where: { deviceSecret: hash },
    select: { id: true, isActive: true },
  })

  if (!device) {
    console.log('[telephony-auth] not-found hash=%s', hash.slice(0, 12))
    _flog(`[telephony-auth] not-found hash=${hash.slice(0, 12)}`)
    return null
  }
  if (!device.isActive) {
    console.log('[telephony-auth] inactive id=%s', device.id)
    _flog(`[telephony-auth] inactive id=${device.id}`)
    return null
  }

  console.log('[telephony-auth] success id=%s', device.id)
  _flog(`[telephony-auth] success id=${device.id}`)
  return { deviceId: device.id }
}
