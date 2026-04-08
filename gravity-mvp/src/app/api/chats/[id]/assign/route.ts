import { NextRequest, NextResponse } from 'next/server'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let body: { userId?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  if (!body.userId || typeof body.userId !== 'string') {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  try {
    await ConversationWorkflowService.assignChat(id, body.userId)
    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[API assign]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
