// TEMPORARY — debug endpoint to read telephony in-memory logs
// Remove after debugging
import { NextResponse } from 'next/server'
import { getMemLog, clearMemLog } from '@/lib/telephonyMemLog'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const doClear = url.searchParams.get('clear') === '1'
  const lines = getMemLog()
  if (doClear) clearMemLog()
  return NextResponse.json({ count: lines.length, lines })
}
