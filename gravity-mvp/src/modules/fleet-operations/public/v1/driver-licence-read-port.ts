// The persistence port of Fleet's licence-carrying public reads. The rows here
// hold the STORED licence; only the handlers see them, and they mask it.

/** One Driver row found by its licence, Fleet-owned columns only. */
export interface DriverLicenceProfileRowV1 {
  id: string
  contactId: string | null
  externalParkId: string | null
  externalDriverProfileId: string | null
  parkName: string | null
  fullName: string
  licenseNumber: string | null
  dismissedAt: Date | string | null
}

export interface DriverLicenceReadPortV1 {
  /** The stored licence of each of these Driver rows (null when none is stored). One bounded read. */
  findLicencesOfDrivers(driverIds: readonly string[]): Promise<Map<string, string | null>>
  /**
   * Driver rows whose stored licence, as letters and digits upper case, equals
   * `licenceKey` exactly. At most `limit` rows, by full name then id.
   */
  findProfilesByLicenceKey(licenceKey: string, limit: number): Promise<DriverLicenceProfileRowV1[]>
}
