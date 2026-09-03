import { NextRequest, NextResponse } from 'next/server'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await params
  try {
    await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  return NextResponse.json(
    {
      error: 'Driver attachment requires canonical all-park person confirmation',
      code: 'DRIVER_PERSON_CONFIRMATION_REQUIRED',
    },
    { status: 409 },
  )
}
