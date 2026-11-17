import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { PageContainer } from '@/infrastructure/ui/PageContainer'
import { getStaffLoginModeV1 } from '@/modules/identity-access/public/v1/staff-session'
import { loadContactPersonCardV1 } from '@/modules/platform-shell/public/v1'
import PersonCardView from './PersonCardView'

export const dynamic = 'force-dynamic'

/**
 * «Карточка человека». The id in the URL is a client-held value: the page asks
 * the platform composition, whose Contacts read verifies the principal and the
 * exact id itself. A merged-away id is followed to its canonical Contact; no
 * other answer shows a person.
 */
export default async function ContactPersonPage({ params }: { params: { id: string } | Promise<{ id: string }> }) {
  const { id } = await Promise.resolve(params)
  if (!id) notFound()
  const result = await loadContactPersonCardV1(id)
  if (result.status === 'redirected') redirect(`/contacts/${encodeURIComponent(result.canonicalContactId)}`)
  if (result.status === 'missing') notFound()
  if (result.status === 'forbidden') {
    // «Войти» only where a personal password sign-in exists (see «Люди»).
    const loginMode = await getStaffLoginModeV1()
    return (
      <PageContainer>
        <BackLink />
        <div className="rounded-xl border border-[#E4ECFC] bg-[#F1F5FD] p-4 text-[15px] text-[#0F172A]">
          {loginMode === 'password' ? (
            <>
              Нет доступа к карточке человека. Войдите в CRM со своим паролем.{' '}
              <a href="/login" className="font-medium text-[#2AABEE]">Войти</a>
            </>
          ) : 'Нет доступа к карточке человека. Вход по паролю на этом стенде не настроен.'}
          <div className="mt-2 text-[13px] text-[#64748B]">
            Пока личные пароли не включены, работает{' '}
            <a href={`/settings/integrations/access?next=${encodeURIComponent(`/contacts/${id}`)}`} className="text-[#2AABEE]">вход администратора интеграций</a>.
          </div>
        </div>
      </PageContainer>
    )
  }
  if (result.status !== 'confirmed') {
    return (
      <PageContainer>
        <BackLink />
        <div className="rounded-xl border border-[#E4ECFC] bg-[#F1F5FD] p-4 text-[15px] text-[#0F172A]">
          Карточку не удалось прочитать согласованно. Обновите страницу.
        </div>
      </PageContainer>
    )
  }
  return (
    <PageContainer>
      <BackLink />
      <PersonCardView view={result.view} />
    </PageContainer>
  )
}

function BackLink() {
  return (
    <div className="mb-4">
      <Link href="/contacts" className="text-[13px] text-[#64748B] hover:text-[#0F172A]">← Люди</Link>
    </div>
  )
}
