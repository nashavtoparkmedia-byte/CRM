/**
 * GET /api/search?q=...
 *
 * Глобальный поиск из шапки CRM. Сейчас scope ограничен Avito —
 * ищет параллельно по двум сущностям:
 *   - avito_accounts (name, login_phone)
 *   - avito_responses (candidate_name, phone, vacancy_title)
 *
 * Когда понадобится поиск по водителям/лидам — добавляется ещё
 * одна ветка в Promise.all и группа в SearchResults.
 *
 * По каждой группе — не больше 5 результатов, чтобы выпадашка
 * умещалась без скролла. Запрос < 2 символов → пустой ответ
 * (фильтрация на сервере, не на клиенте — экономит SQL).
 *
 * `contains` + insensitive — для коротких запросов (имена, телефоны)
 * этого достаточно; полнотекст PG появится когда упрёмся в
 * производительность.
 */
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export type SearchResultAvitoAccount = {
  kind: 'avito_account'
  id: number
  title: string
  subtitle: string | null
  href: string
}

export type SearchResultAvitoResponse = {
  kind: 'avito_response'
  id: number
  title: string
  subtitle: string | null
  href: string
}

export type SearchResults = {
  avitoAccounts: SearchResultAvitoAccount[]
  avitoResponses: SearchResultAvitoResponse[]
}

const MIN_LEN = 2
const PER_GROUP_LIMIT = 5

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const qRaw = (searchParams.get('q') ?? '').trim()

  if (qRaw.length < MIN_LEN) {
    return NextResponse.json<SearchResults>({
      avitoAccounts: [],
      avitoResponses: [],
    })
  }

  // Нормализуем телефонный поиск: если ввели «+7 (908) 404», убираем
  // лишние символы — в БД телефоны хранятся как «+79084048588».
  // Запрос остаётся «как ввёл», но для phone-полей ищем по digits-only.
  const qDigits = qRaw.replace(/\D/g, '')
  const phoneQuery = qDigits.length >= 4 ? qDigits : null

  try {
    const [avitoAccounts, avitoResponses] = await Promise.all([
      prisma.avito_accounts.findMany({
        where: {
          OR: [
            { name: { contains: qRaw, mode: 'insensitive' } },
            ...(phoneQuery ? [{ login_phone: { contains: phoneQuery } }] : []),
          ],
        },
        take: PER_GROUP_LIMIT,
        orderBy: { updated_at: 'desc' },
        select: { id: true, name: true, login_phone: true, status: true },
      }),
      prisma.avito_responses.findMany({
        where: {
          AND: [
            { NOT: { external_id: { startsWith: 'a2u-' } } },
            {
              OR: [
                { candidate_name: { contains: qRaw, mode: 'insensitive' } },
                { vacancy_title: { contains: qRaw, mode: 'insensitive' } },
                ...(phoneQuery ? [{ phone: { contains: phoneQuery } }] : []),
              ],
            },
          ],
        },
        take: PER_GROUP_LIMIT,
        orderBy: { detected_at: 'desc' },
        select: {
          id: true,
          candidate_name: true,
          vacancy_title: true,
          phone: true,
        },
      }),
    ])

    const result: SearchResults = {
      avitoAccounts: avitoAccounts.map((a) => ({
        kind: 'avito_account' as const,
        id: a.id,
        title: a.name,
        subtitle: a.login_phone ?? a.status,
        // На странице /avito/accounts нет глубокого link'а под аккаунт —
        // открываем общий список, оператор увидит нужную строку.
        href: `/avito/accounts`,
      })),
      avitoResponses: avitoResponses.map((r) => ({
        kind: 'avito_response' as const,
        id: r.id,
        title: r.candidate_name ?? r.phone ?? `Отклик #${r.id}`,
        subtitle:
          r.vacancy_title ?? (r.phone && r.candidate_name ? r.phone : null),
        // Deep-link с #response-N — на /avito.tsx есть scroll-into-view
        // hook, который подсветит строку после загрузки.
        href: `/avito#response-${r.id}`,
      })),
    }

    return NextResponse.json(result)
  } catch (err: any) {
    console.error('search error:', err)
    return NextResponse.json(
      { error: err?.message ?? 'unknown' },
      { status: 500 },
    )
  }
}
