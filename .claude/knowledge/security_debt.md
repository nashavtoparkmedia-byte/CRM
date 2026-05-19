# Security debt — CRM

Список известных security-долгов. Каждый пункт — отдельная задача,
которую стоит закрыть, но она не блокирует текущую работу.

---

## getCurrentUser() fallback на u3 для anonymous — ЗАКРЫТО

**Закрыто:** PR `fix/auth-remove-u3-fallback` (см. блок ниже про
оставшуюся работу).

**Что было:** `gravity-mvp/src/lib/users/user-service.ts:27-33`

```ts
export async function getCurrentUser(): Promise<UserItem | null> {
    const cookieStore = await cookies()
    let id = cookieStore.get('crm_user_id')?.value
    if (!id) id = 'u3' // ← backdoor: u3 = Руководитель
    const users = await getUsers()
    return users.find(u => u.id === id) || null
}
```

Любой server-side код, использующий `getCurrentUser()` для auth/role-check,
при отсутствии cookie `crm_user_id` неявно считал вызывающего
**Руководителем** (u3) — passive bypass через DevTools → cookie delete.

**Чем закрыто:**
- Fallback удалён, `getCurrentUser()` возвращает `null` для anonymous.
- Pure-функция `pickUserById` вынесена в `gravity-mvp/src/lib/users/auth-helpers.js`
  + 6 unit-тестов (`__tests__/user-service.test.js`), включая explicit
  «u3 НЕ резолвится из anonymous-запроса» regression-anchor.
- `console.warn('[auth] anonymous request (no crm_user_id cookie)')` —
  временная инструментация, чтобы видеть unexpected anonymous traffic
  после деплоя. Снять, когда `login(userId)` будет закрыт.

**Чем mitigated раньше (по-прежнему актуально):**
PR #28 (commit `7a75430`) ввёл локальный guard `assertCanEditAi()` в
`gravity-mvp/src/app/settings/ai/actions.ts`, читающий cookie напрямую
и НЕ полагающийся на `getCurrentUser()`. Этот guard оставлен — он
независимо защищает AI Control Center mutation actions.

---

## login(userId) без аутентификации — ОТКРЫТО, High

**Где:** `gravity-mvp/src/lib/users/user-service.ts:35-38`

```ts
export async function login(userId: string) {
    const cookieStore = await cookies()
    cookieStore.set('crm_user_id', userId, { maxAge: 60 * 60 * 24 * 7 })
}
```

**Что не так.** Это server action, callable из браузера. Принимает
произвольный `userId` без password / OTP / OAuth / любой проверки
identity, и просто записывает его в cookie. Любой пользователь может
вызвать `login('u3')` и получить cookie Руководителя за один HTTP-запрос.

**Severity.** Более серьёзная, чем закрытый fallback: fallback был
passive-bypass (нужно удалить cookie), а `login(userId)` —
active-bypass (одна команда выдаёт нужную роль). После закрытия
fallback это **самый прямой путь к privilege escalation** на CRM.

**Сценарий обхода:**
1. Реальный менеджер (или любой, кто открыл UI) видит кнопки переключения
   identity (legacy demo / dev-mode UX).
2. В DevTools Console: `fetch('/api/...', ...)` или прямой вызов
   server action c `userId='u3'`.
3. Cookie выставлена, все последующие запросы — под Руководителем.

**Что нужно сделать (отдельной задачей):**

- [ ] Определить архитектурную цель: реальная аутентификация (email +
      password / OAuth / SSO) или identity-selector remains, но
      защищён shared-secret / VPN / network namespace.
- [ ] Если remains identity-selector: подписывать cookie HMAC ключом,
      проверять подпись в getCurrentUser.
- [ ] Если real auth: добавить middleware + login flow + logout flow.
- [ ] Удалить произвольный `login(userId)` server action или обернуть
      его в strict identity-selection guard (что-то подобное по правам
      `assertCanEditAi`).
- [ ] Regression test: anonymous → не может вызвать `login('u3')` и
      получить Руководителя за один запрос.

**Priority:** High / security.
**Block-release:** да — до фикса любой пользователь, видевший UI хотя
бы раз, может escalate до Руководителя одной server-action call.

---

## 26 callsites `getCurrentUser()` — частично mitigated

После удаления fallback все они получают `null` в anonymous-сценарии.
Те, у кого есть pattern `if (!user) return 401` — fail-closed
автоматически. Те, у кого нет — упадут с `TypeError: Cannot read 'role'
of null` → 500.

**Что нужно сделать (отдельной задачей):**

- [ ] Полный аудит 26 callsites (см. список в commit message
      `fix/auth-remove-u3-fallback`) на наличие null-guard'a.
- [ ] Везде, где null-guard отсутствует, добавить `if (!user) return 401`
      (или соответствующий redirect для page components).
- [ ] Опционально: `requireUser()` / `requireRole(role[])` helpers
      в `lib/users/` для единообразия.

**Priority:** Medium.

---

## 15 файлов с прямым cookie reading — не аудитировано

Эти файлы НЕ проходят через `getCurrentUser()`, читают cookie
`crm_user_id` напрямую:

- `gravity-mvp/src/app/tasks/actions.ts`
- `gravity-mvp/src/app/messages/components/{ChatHeader,ChatList,ChatWorkspace,ContactProfileDrawer}.tsx`
- `gravity-mvp/src/app/settings/scenarios/actions.ts`
- `gravity-mvp/src/app/settings/avito-access/page.tsx`
- `gravity-mvp/src/app/my-day/actions.ts`
- `gravity-mvp/src/app/api/groups/visibility/route.ts`
- `gravity-mvp/src/app/api/avito/responses/[id]/mark-processed/route.ts`
- `gravity-mvp/src/lib/tasks/{usage,task-event-service}.ts`
- `gravity-mvp/src/lib/freeswitch/EslClient.ts`
- `gravity-mvp/src/lib/users/user-service.ts` (источник)
- `gravity-mvp/src/app/settings/ai/actions.ts` (правильный pattern из PR #28)

**Что нужно сделать:** аудит каждого на корректную обработку
missing/unknown cookie. Кандидат на консолидацию через единый helper.

**Priority:** Medium.
