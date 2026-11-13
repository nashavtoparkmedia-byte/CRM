// How much of a driver's licence (ВУ) one reader may see (Owner D2, OD-03).
//
// Fleet Operations never decides this. Contacts' ContactReadAuthorityQuery.v1
// answers it once per request from the verified employee; the caller passes
// that answer on unchanged, and Fleet masks the stored licence by it. Nobody
// derives a view from a role or writes it as a literal.
//
// 'full'  — the stored licence as Fleet holds it (Администратор).
// 'last4' — only its last four characters (Руководитель, Менеджер).
export const DRIVER_LICENCE_VIEWS_V1 = ['full', 'last4'] as const
export type DriverLicenceViewV1 = typeof DRIVER_LICENCE_VIEWS_V1[number]

export function isDriverLicenceViewV1(value: unknown): value is DriverLicenceViewV1 {
  return typeof value === 'string' && (DRIVER_LICENCE_VIEWS_V1 as readonly string[]).includes(value)
}
