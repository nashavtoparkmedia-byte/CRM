'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import ContactSelector from '@/modules/contacts/public/v1/client-ui/ContactSelector'
import { createHttpContactLookupClientV1 } from '@/modules/contacts/public/v1/client-ui/http-contact-lookup-client'
import type { ContactLookupItemV1 } from '@/modules/contacts/public/v1'

/**
 * «Люди» → поиск. The picker is Contacts' own ContactSelector over ContactLookup.v1;
 * choosing a result opens that person's page and nothing else. A match here is a
 * search hit, never a claim that two results are the same person.
 */
export default function ContactsSearchClient() {
  const router = useRouter()
  const lookup = useMemo(() => createHttpContactLookupClientV1(), [])
  const [value, setValue] = useState<ContactLookupItemV1 | null>(null)
  return (
    <div className="max-w-[560px]">
      <ContactSelector
        label="Поиск человека"
        lookup={lookup}
        value={value}
        placeholder="ФИО, телефон или username"
        onChange={(item) => {
          setValue(item)
          if (item) router.push(`/contacts/${encodeURIComponent(item.contactId)}`)
        }}
      />
      <p className="mt-3 text-[13px] text-[#64748B]">
        Совпадение в поиске — не доказательство, что две записи принадлежат одному человеку. Связи подтверждаются только в карточке.
      </p>
    </div>
  )
}
