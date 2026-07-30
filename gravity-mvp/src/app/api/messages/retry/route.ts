import { NextRequest, NextResponse } from 'next/server'
import { MessageService } from '@/lib/MessageService'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { messageId?: unknown } | null
  if (typeof body?.messageId !== 'string' || body.messageId.length < 1 || body.messageId.length > 256) {
    return NextResponse.json({ success: false, error: 'messageId is required' }, { status: 400 })
  }
  const result = await MessageService.retrySend(body.messageId)
  return NextResponse.json(result, { status: result.success ? 200 : 409 })
}
