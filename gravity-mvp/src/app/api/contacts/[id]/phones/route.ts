import { NextResponse } from 'next/server'

/**
 * Direct phone writes were unsafe because ownership was checked with
 * findFirst outside the mutation transaction. Operator UI must use the
 * canonical preflight/confirm endpoint instead.
 */
export async function POST() {
  return NextResponse.json({
    error: 'PHONE_RESOLUTION_REQUIRED',
    message: 'Сначала проверьте владельца номера',
    endpoint: 'phones/resolve',
  }, { status: 409 })
}
