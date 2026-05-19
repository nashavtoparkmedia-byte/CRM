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

## login(userId) — PARTIALLY mitigated

**Где:** `gravity-mvp/src/lib/users/user-service.ts` — функция `login`.

**Чем mitigated** (PR `fix/login-escalation-guard`):
- `login(targetUserId)` теперь читает текущий cookie, резолвит current
  user через `pickUserById`, и применяет server-side политику
  `canLogin({ currentUser, targetUserId, allUsers })`:

| current role     | allowed target  |
|------------------|-----------------|
| anonymous        | any             |
| Администратор    | any             |
| Руководитель     | any             |
| Менеджер         | self only       |
| anything else    | denied          |

  Кросс-id login от Менеджера → throw `forbidden` + structured warn
  `[auth] blocked login escalation current=<id> role=<role> target=<id> reason=<tag>`.
- Unknown / empty target id → также throw (никогда не пишем мусор в
  cookie, чтобы не получить ghost-сессию которая masquerades за anonymous).
- 7 unit-тестов в `__tests__/login.test.js` покрывают все 4 строки
  матрицы выше + unknown-target + empty-target кейсы.

**Что НЕ закрыто этим PR (намеренно):**

- **Anonymous → любая identity** через `/login` UI или DevTools.
  Это **intentional trust model** для текущей стадии продукта: CRM —
  internal trusted app с identity-selector, а не internet-grade auth.
  Закрытие требует реальной аутентификации (email/password / SSO /
  one-time link) — отдельный архитектурный решение.
- **`addUser/updateUser/deleteUser` server actions без guard'ов** —
  отдельный escalation vector (создать user с `role: 'Администратор'`
  → залогиниться на него). Закрывается в следующем PR того же класса
  («fix(auth): protect user CRUD server actions»).

**Что осталось сделать (future scope):**

- [ ] Real authentication primitive (email/password / OAuth / SSO).
- [ ] Подписанные cookie с HMAC (когда появится server secret).
- [ ] Защита user-CRUD server actions (`addUser/updateUser/deleteUser`)
      ролевым guard'ом по образцу `assertCanEditAi`.
- [ ] Middleware-уровневая защита (когда определимся с auth-моделью).

**Priority of remaining work:** High (anonymous flow + user-CRUD).
**Block-release status:** статус понижен с «да» до «нет» — самый
очевидный active-bypass (Менеджер → Руководитель из DevTools) закрыт.
Anonymous-bypass остаётся как известный intentional trade-off для
текущей стадии продукта.

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
