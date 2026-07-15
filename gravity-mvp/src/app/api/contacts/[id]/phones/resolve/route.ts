import { NextRequest, NextResponse } from 'next/server'

import {
  auditMergeReviewOpened,
  confirmContactPhone,
  ContactPhoneResolutionError,
  preflightContactPhone,
} from '@/lib/contacts/contact-phone-resolution'

export const dynamic = 'force-dynamic'

function operatorFrom(request: NextRequest): string {
  return request.cookies.get('crm_user_id')?.value || 'operator'
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: contactId } = await params
    const body = await request.json().catch(() => ({}))
    const operator = operatorFrom(request)

    if (body.mode === 'preflight') {
      const result = await preflightContactPhone({ contactId, rawPhone: body.phone, operator })
      return NextResponse.json(result)
    }
    if (body.mode === 'confirm') {
      if (typeof body.confirmationToken !== 'string') {
        return NextResponse.json({ error: 'CONFIRMATION_TOKEN_REQUIRED', message: 'Сначала проверьте номер' }, { status: 400 })
      }
      const result = await confirmContactPhone({ contactId, confirmationToken: body.confirmationToken, operator })
      return NextResponse.json(result, { status: result.ok ? 200 : 409 })
    }
    if (body.mode === 'audit' && body.action === 'merge_review_opened') {
      const result = auditMergeReviewOpened({
        contactId,
        confirmationToken: body.confirmationToken,
        operator,
      })
      return NextResponse.json(result)
    }

    return NextResponse.json({ error: 'INVALID_MODE', message: 'Неизвестный режим проверки номера' }, { status: 400 })
  } catch (error: unknown) {
    if (error instanceof ContactPhoneResolutionError) {
      const status = error.code === 'CONTACT_NOT_FOUND' ? 404 : error.code === 'CONTACT_NOT_ACTIVE' ? 409 : 400
      return NextResponse.json({ error: error.code, message: error.message }, { status })
    }
    const message = error instanceof Error ? error.message : String(error)
    console.error('[contacts/:id/phones/resolve] POST Error:', message)
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Не удалось проверить номер' }, { status: 500 })
  }
}
