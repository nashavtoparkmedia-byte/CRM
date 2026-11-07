import { PageContainer } from '@/infrastructure/ui/PageContainer'
import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'
import ContactsSearchClient from './ContactsSearchClient'

export const dynamic = 'force-dynamic'

export default async function ContactsPage() {
  const principal = await getIntegrationAdminPrincipal()
  return (
    <PageContainer>
      <div className="mb-6">
        <h1 className="text-[20px] font-semibold text-[#0F172A]">Люди</h1>
        <p className="mt-1 text-[13px] text-[#64748B]">Один человек — все его профили в парках и аккаунты связи.</p>
      </div>
      {principal === null ? (
        <div className="rounded-xl border border-[#E4ECFC] bg-[#F1F5FD] p-4 text-[15px] text-[#0F172A]">
          Нужна подтверждённая сессия администратора интеграций.{' '}
          <a href="/settings/integrations/access?next=%2Fcontacts" className="font-medium text-[#2AABEE]">Войти</a>
        </div>
      ) : (
        <ContactsSearchClient />
      )}
    </PageContainer>
  )
}
