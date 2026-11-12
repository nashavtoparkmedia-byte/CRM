import { PageContainer } from '@/infrastructure/ui/PageContainer'
import { resolveContactReadAuthorityV1 } from '@/modules/contacts/public/v1'
import { getStaffLoginModeV1 } from '@/modules/identity-access/public/v1/staff-session'
import ContactsSearchClient from './ContactsSearchClient'
import LicenceSearchClient from './LicenceSearchClient'

export const dynamic = 'force-dynamic'

export default async function ContactsPage() {
  const authority = await resolveContactReadAuthorityV1()
  // «Войти» only where a personal password sign-in exists; elsewhere it would lead to
  // the legacy employee picker, which no reader accepts (Owner acceptance, 2026-11-12).
  const loginMode = authority.decision === 'allow' ? null : await getStaffLoginModeV1()
  return (
    <PageContainer>
      <div className="mb-6">
        <h1 className="text-[20px] font-semibold text-[#0F172A]">Люди</h1>
        <p className="mt-1 text-[13px] text-[#64748B]">Один человек — все его профили в парках и аккаунты связи.</p>
      </div>
      {authority.decision !== 'allow' ? (
        <div className="rounded-xl border border-[#E4ECFC] bg-[#F1F5FD] p-4 text-[15px] text-[#0F172A]">
          {loginMode === 'password' ? (
            <>
              Чтобы искать людей, войдите в CRM со своим паролем.{' '}
              <a href="/login" className="font-medium text-[#2AABEE]">Войти</a>
            </>
          ) : 'Вход по паролю на этом стенде не настроен.'}
          <div className="mt-2 text-[13px] text-[#64748B]">
            Пока личные пароли не включены, работает{' '}
            <a href="/settings/integrations/access?next=%2Fcontacts" className="text-[#2AABEE]">вход администратора интеграций</a>.
          </div>
        </div>
      ) : (
        <>
          <ContactsSearchClient />
          <LicenceSearchClient />
        </>
      )}
    </PageContainer>
  )
}
