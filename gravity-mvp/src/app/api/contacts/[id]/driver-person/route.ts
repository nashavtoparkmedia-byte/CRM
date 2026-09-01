import { NextRequest, NextResponse } from 'next/server'

import {
  confirmDriverPersonV1,
} from '@/modules/contacts/public/v1'
import {
  CONFIRM_DRIVER_PERSON_COMMAND_V1,
  type DriverClusterProfileEvidenceV1,
} from '@/contracts/contacts/v1'

function actorFrom(req: NextRequest, bodyActor?: unknown): string {
  const value = req.headers.get('x-crm-user-id') || (typeof bodyActor === 'string' ? bodyActor : '')
  return value.trim() || 'operator:unknown'
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: contactId } = await params
  const body = await req.json() as {
    profileClusterKey?: string
    representativeDriverId?: string
    confirmationBasis?: 'fio' | 'phone' | 'vu'
    searchInput?: string
    profiles?: DriverClusterProfileEvidenceV1[]
    warnings?: string[]
    confirmedBy?: string
  }
  if (!body.profileClusterKey || !body.representativeDriverId || !body.confirmationBasis || !body.searchInput) {
    return NextResponse.json({ error: 'Incomplete confirmation evidence' }, { status: 400 })
  }
  const confirmed = await confirmDriverPersonV1({
    contract: CONFIRM_DRIVER_PERSON_COMMAND_V1,
    contactId,
    profileClusterKey: body.profileClusterKey,
    representativeDriverId: body.representativeDriverId,
    confirmedBy: actorFrom(req, body.confirmedBy),
    confirmationBasis: body.confirmationBasis,
    searchInput: body.searchInput,
    evidenceSnapshot: {
      profiles: Array.isArray(body.profiles) ? body.profiles : [],
      warnings: Array.isArray(body.warnings) ? body.warnings.map(String) : [],
    },
  })
  if (confirmed.status === 'contradiction') {
    return NextResponse.json(confirmed, { status: 409 })
  }
  return NextResponse.json({ confirmation: confirmed })
}
