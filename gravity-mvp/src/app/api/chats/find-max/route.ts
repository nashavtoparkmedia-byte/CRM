import { NextResponse } from 'next/server'

/**
 * Retired: a forwarded sender label is not authority to select or create a
 * MAX conversation. Only an already-admitted conversation ID may be opened.
 */
export async function GET() {
  return NextResponse.json(
    { chatId: null, error: 'CONTACT_CONVERSATION_IDENTITY_REQUIRED' },
    { status: 409 },
  )
}
