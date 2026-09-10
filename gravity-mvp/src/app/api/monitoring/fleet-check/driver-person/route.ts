import { NextRequest, NextResponse } from 'next/server'

import { RECONCILE_YANDEX_FLEET_COMMAND_V1 } from '@/contracts/fleet-operations/v1'
import {
  searchYandexParksByDriverQueryV1,
} from '@/modules/fleet-operations/public/v1'
import {
  getIntegrationAdminPrincipal,
  isExactSameOriginMutationRequest,
} from '@/modules/identity-access/public/v1'
import { reconcileYandexFleetWithAutomaticMergeV1 } from '@/modules/platform-shell/public/v1'

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get('query')?.trim() || ''
  if (query.length < 3) {
    return NextResponse.json({ error: 'FIO, phone or VU query must contain at least 3 characters' }, { status: 400 })
  }
  const result = await searchYandexParksByDriverQueryV1(query)
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  if (!isExactSameOriginMutationRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (!await getIntegrationAdminPrincipal()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const body = await req.json() as { query?: string }
  const query = body.query?.trim() || ''
  if (query.length < 3) {
    return NextResponse.json({ error: 'FIO, phone or VU query must contain at least 3 characters' }, { status: 400 })
  }
  const reconciliation = await reconcileYandexFleetWithAutomaticMergeV1({
    contract: RECONCILE_YANDEX_FLEET_COMMAND_V1,
    mode: 'confirmation_followup',
    query,
  })
  return NextResponse.json({ reconciliation })
}
