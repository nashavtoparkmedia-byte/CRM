// The persistence port of DriverProfilesForContactsQuery.v3's extra profile
// fields: the profile's own phone and its employment, from the Fleet-owned
// Driver row. Only the v3 handler sees these rows; it narrows the employment
// value to the contract's allowlist before anything leaves Fleet.

/** The stored card fields of one Driver row. */
export interface DriverCardFieldsRowV1 {
  phone: string | null
  isSelfEmployed: boolean | null
  employmentType: string | null
}

export interface DriverCardFieldsReadPortV1 {
  /** The stored card fields of each of these Driver rows. One bounded read. */
  findCardFieldsOfDrivers(driverIds: readonly string[]): Promise<Map<string, DriverCardFieldsRowV1>>
}
