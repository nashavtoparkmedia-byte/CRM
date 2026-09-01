export const CONFIRM_DRIVER_PERSON_COMMAND_V1 = 'contacts.ConfirmDriverPersonCommand.v1' as const
export const RECONCILE_DRIVER_CLUSTER_COMMAND_V1 = 'contacts.ReconcileDriverClusterCommand.v1' as const

export type DriverClusterProfileEvidenceV1 = {
  driverId: string
  externalParkId: string
  externalDriverProfileId: string
  fullName: string
  phones: string[]
  normalizedVu: string | null
  evidenceRoot: string
  sourceFreshness: 'fresh' | 'stale' | 'unknown'
  legalRole?: string | null
  status?: string | null
  city?: string | null
  profileType?: string | null
  rawVu?: string | null
  sourceDates?: Record<string, string | null>
}

export type ConfirmDriverPersonCommandV1 = {
  contract: typeof CONFIRM_DRIVER_PERSON_COMMAND_V1
  contactId: string
  profileClusterKey: string
  representativeDriverId: string
  confirmedBy: string
  confirmationBasis: 'fio' | 'phone' | 'vu'
  searchInput: string
  evidenceSnapshot: {
    profiles: DriverClusterProfileEvidenceV1[]
    warnings: string[]
  }
}

export type ReconcileDriverClusterCommandV1 = {
  contract: typeof RECONCILE_DRIVER_CLUSTER_COMMAND_V1
  profileClusterKey: string
  profiles: DriverClusterProfileEvidenceV1[]
}
