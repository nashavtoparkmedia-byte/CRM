import { NextRequest, NextResponse } from 'next/server'
import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    await ConversationWorkflowService.unassignChat(id)
    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[API unassign]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
