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

## user CRUD server actions — PARTIALLY mitigated

**Где:** `gravity-mvp/src/lib/users/user-service.ts` — `addUser`,
`updateUser`, `deleteUser`. Использует UI `app/users/page.tsx`.

**Что было:** все три функции были без серверного guard'a. Менеджер
из DevTools мог:
- `updateUser('u1', { role: 'Администратор' })` — self-elevation в
  один шаг, обходящий PR #44/#45 целиком.
- `addUser({ ..., role: 'Администратор' })` → новый admin → `login`
  на него (через anonymous-path, который остаётся открытым).
- `deleteUser('u2')` → удалить единственного Администратора, DoS
  на admin pool.

**Чем закрыто** (PR `fix/user-crud-guard`):

- `assertCanManageUsers(action)` — server-side guard в начале каждой
  функции. Reads cookie, resolves user через `pickUserById`, проверяет
  через `canManageUsers`. На denial → structured warn:
  `[auth] blocked user-management current=<id> role=<role> action=<addUser|updateUser|deleteUser>` + throw `Error('forbidden')`.
  Политика: Администратор + Руководитель allowed; всё остальное
  (включая Менеджер и anonymous) denied.

- **Role allowlist в addUser/updateUser:** `isValidRole(role)` гарантирует
  что в `users.json` попадают только три строки `Менеджер|Руководитель|Администратор`.
  Защищает от prototype-poisoning и malformed-input.

- **Last-privileged invariant в deleteUser/updateUser:**
  `wouldDeleteLastPrivileged` / `wouldDemoteLastPrivileged` предотвращают
  ситуацию, когда в системе не остаётся ни одного Администратора +
  Руководителя. Без этого operator может случайно сделать UI
  unrecoverable, и recovery потребует ручного редактирования
  `users.json` на диске.

- **20 unit-тестов** в `__tests__/user-crud.test.js` (canManageUsers /
  isValidRole / wouldDeleteLastPrivileged / wouldDemoteLastPrivileged) +
  все 13 предшествующих регрессий (login + pickUserById) остаются PASS.

**Что НЕ закрыто этим PR (намеренно):**

- **Anonymous user CRUD** через `/login` UI или DevTools всё ещё
  возможен: anonymous → не имеет cookie → `canManageUsers(null)` →
  false → blocked. Однако anonymous может вызвать `login(<existing admin id>)`
  (это intentional onboarding flow PR #45), стать admin и потом
  делать CRUD. Закрытие требует real auth.
- **Audit trail / history log** изменений users.json — нет (отдельная
  feature).
- **UI-уровень enforcement** — оставлен как есть (client-side check в
  `app/users/page.tsx` достаточен в комбинации с server-guard).

**Priority of remaining work:** Low (anonymous-path закрывается
полноценной authentication, не точечным fix-ом).

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
