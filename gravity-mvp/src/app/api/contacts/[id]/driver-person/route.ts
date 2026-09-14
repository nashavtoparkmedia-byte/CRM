import { NextRequest, NextResponse } from 'next/server'

import {
  confirmDriverPersonV1,
} from '@/modules/contacts/public/v1'
import {
  CONFIRM_DRIVER_PERSON_COMMAND_V1,
} from '@/contracts/contacts/v1'
import { RECONCILE_YANDEX_FLEET_COMMAND_V1 } from '@/contracts/fleet-operations/v1'
import {
  normalizeDriverLicenceVuV1,
  normalizeParkPhoneDigitsV1,
  searchYandexParksByDriverQueryV1,
  type ReconciledDriverClusterV1,
} from '@/modules/fleet-operations/public/v1'
import {
  getIntegrationAdminPrincipal,
  isExactSameOriginMutationRequest,
} from '@/modules/identity-access/public/v1'
import { reconcileYandexFleetWithAutomaticMergeV1 } from '@/modules/platform-shell/public/v1'
import { attemptAutomaticContactMergeFromPlatformV1 } from '@/modules/platform-shell/internal/contact-park-merge-orchestrator'

function confirmationBasisFor(
  query: string,
  cluster: ReconciledDriverClusterV1,
): 'fio' | 'phone' | 'vu' {
  const normalizedVu = normalizeDriverLicenceVuV1(query)
  if (normalizedVu && cluster.profiles.some(profile => profile.normalizedVu === normalizedVu)) return 'vu'
  const phoneDigits = normalizeParkPhoneDigitsV1(query)
  if (phoneDigits.length >= 3 && cluster.profiles.some(profile => (
    profile.phones.some(phone => normalizeParkPhoneDigitsV1(phone).includes(phoneDigits))
  ))) return 'phone'
  return 'fio'
}

function exactFreshCluster(
  clusters: ReconciledDriverClusterV1[] | undefined,
  profileClusterKey: string,
  representativeDriverId: string,
): ReconciledDriverClusterV1 | null {
  const matches = (clusters ?? []).filter(cluster => cluster.profileClusterKey === profileClusterKey)
  if (matches.length !== 1) return null
  const [cluster] = matches
  if (cluster.profiles.length === 0
    || cluster.profiles.some(profile => profile.sourceFreshness !== 'fresh')
    || !cluster.profiles.some(profile => profile.driverId === representativeDriverId)) {
    return null
  }
  return cluster
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isExactSameOriginMutationRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const principal = await getIntegrationAdminPrincipal()
  if (!principal) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id: contactId } = await params
  const body = await req.json().catch(() => null) as {
    profileClusterKey?: string
    representativeDriverId?: string
    searchInput?: string
  } | null
  const profileClusterKey = body?.profileClusterKey?.trim() ?? ''
  const representativeDriverId = body?.representativeDriverId?.trim() ?? ''
  const searchInput = body?.searchInput?.trim() ?? ''
  if (!profileClusterKey || !representativeDriverId || searchInput.length < 3) {
    return NextResponse.json({ error: 'Incomplete confirmation evidence' }, { status: 400 })
  }

  let authority: Awaited<ReturnType<typeof searchYandexParksByDriverQueryV1>>
  try {
    authority = await searchYandexParksByDriverQueryV1(searchInput)
  } catch (error) {
    console.error('[driver-person] Authoritative Fleet confirmation check failed:', error)
    return NextResponse.json({ error: 'Fresh Fleet confirmation evidence is unavailable' }, { status: 503 })
  }
  if (authority.checkedParks === 0 || authority.errors.length > 0) {
    return NextResponse.json({ error: 'Fresh complete Fleet confirmation evidence is required' }, { status: 503 })
  }
  const cluster = exactFreshCluster(
    authority.clusters,
    profileClusterKey,
    representativeDriverId,
  )
  if (!cluster) {
    return NextResponse.json({ error: 'Confirmation candidate is stale; search again' }, { status: 409 })
  }

  const confirmed = await confirmDriverPersonV1({
    contract: CONFIRM_DRIVER_PERSON_COMMAND_V1,
    contactId,
    profileClusterKey: cluster.profileClusterKey,
    representativeDriverId,
    confirmedBy: principal.id,
    confirmationBasis: confirmationBasisFor(searchInput, cluster),
    searchInput,
    evidenceSnapshot: {
      profiles: cluster.profiles,
      warnings: cluster.warnings,
    },
  })
  if (confirmed.status === 'contradiction') {
    return NextResponse.json(confirmed, { status: 409 })
  }

  let confirmation = confirmed
  let automaticMerge: Awaited<ReturnType<typeof attemptAutomaticContactMergeFromPlatformV1>> | null = null
  if (confirmed.status === 'needs_reconciliation') {
    const candidateContactId = confirmed.mergeCandidateContactId
    if (!candidateContactId) {
      return NextResponse.json({ error: 'Missing reconciliation candidate', confirmation: confirmed }, { status: 500 })
    }
    try {
      automaticMerge = await attemptAutomaticContactMergeFromPlatformV1(contactId, candidateContactId)
    } catch (error) {
      console.error('[driver-person] Automatic reconciliation attempt failed:', error)
      return NextResponse.json({
        error: 'Automatic reconciliation is temporarily unavailable',
        confirmation: confirmed,
      }, { status: 503 })
    }
    if (automaticMerge.status === 'policy_blocked') {
      return NextResponse.json({
        error: 'Manual reconciliation required',
        confirmation: confirmed,
        automaticMerge,
      }, { status: 409 })
    }
    if (automaticMerge.status !== 'merged' || !automaticMerge.survivorContactId) {
      return NextResponse.json({
        error: 'Contact ownership changed; retry confirmation',
        confirmation: confirmed,
        automaticMerge,
      }, { status: 409 })
    }
    confirmation = {
      ...confirmed,
      status: 'confirmed',
      contactId: automaticMerge.survivorContactId,
    }
  }

  try {
    const reconciliation = await reconcileYandexFleetWithAutomaticMergeV1({
      contract: RECONCILE_YANDEX_FLEET_COMMAND_V1,
      mode: 'confirmation_followup',
      query: searchInput,
    })
    return NextResponse.json({ confirmation, automaticMerge, reconciliation })
  } catch (error) {
    console.error('[driver-person] Confirmation persisted but Fleet follow-up failed:', error)
    return NextResponse.json({
      error: 'Confirmation persisted, but Fleet reconciliation failed',
      confirmation,
      automaticMerge,
    }, { status: 502 })
  }
}
