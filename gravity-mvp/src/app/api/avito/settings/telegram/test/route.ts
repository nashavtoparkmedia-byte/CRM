import { NextResponse } from 'next/server'

/**
 * Retired: a public test-send endpoint cannot establish an admitted
 * conversation, exact provider account, or current recipient authority.
 */
export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: 'Тестовая отправка отключена; используйте подтверждённый диалог.',
      code: 'CONTACT_CONVERSATION_IDENTITY_REQUIRED',
    },
    { status: 409 },
  )
}
