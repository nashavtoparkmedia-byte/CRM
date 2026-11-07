import { NextRequest, NextResponse } from 'next/server'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'
import { resolveRequestOperatorV1 } from '@/modules/identity-access/public/v1/mobile-session-operator'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let body: { userId?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  if (!body.userId || typeof body.userId !== 'string') {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  // BR-4. Every caller of this route assigns the conversation to its own
  // operator («Взять себе», auto-assign on the first reply). Under a mobile
  // session that operator is the signed one, so a client-supplied userId may
  // only name it. The browser lane without a mobile session is unchanged.
  const operator = await resolveRequestOperatorV1()
  if (operator.kind === 'mobile_session_refused') {
    return NextResponse.json({ error: 'mobile_session_required' }, { status: 401 })
  }
  if (operator.kind === 'mobile_session' && body.userId !== operator.operatorId) {
    return NextResponse.json({ error: 'assignee_is_not_the_signed_operator' }, { status: 403 })
  }

  try {
    await ConversationWorkflowService.assignChat(id, body.userId)
    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[API assign]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
