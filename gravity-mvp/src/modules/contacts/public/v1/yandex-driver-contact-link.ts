export interface YandexDriverContactLinkResultV1 {
  action: 'noop' | 'linked' | 'no_contact' | 'no_driver' | 'ambiguous'
  contactId?: string
  driverId?: string
  previousDriverYandexId?: string | null
  candidates?: Array<{
    id: string
    yandexDriverId: string
    dismissedAt: Date | null
    lastOrderAt: Date | null
  }>
  contactCandidates?: Array<{
    contactId: string
    contactPhoneId: string
    yandexDriverId: string | null
    isArchived: boolean
  }>
  reason?: string
}

export interface YandexDriverContactLinkPortV1 {
  link(phone: string | null | undefined): Promise<YandexDriverContactLinkResultV1>
}

export function createYandexDriverContactLinkHandlerV1(port: YandexDriverContactLinkPortV1) {
  return (phone: string | null | undefined): Promise<YandexDriverContactLinkResultV1> => (
    port.link(phone)
  )
}
