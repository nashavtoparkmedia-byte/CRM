# Cash-compensation edge perimeter

Temporary infrastructure gate in front of the CRM manager surface for the cash
compensation pilot. It is **not** a CRM authentication subsystem and does not
replace one: the application keeps its own identity model unchanged, and this
only decides who may reach the route at all.

## What it protects

`/compensation` exactly, and everything under `/compensation/` — list, detail,
the evidence route, POST/server-action traffic, and query-string or RSC
requests — on **both** CRM virtual hosts, `${CRM_DOMAIN}` and
`${CRM_APP_DOMAIN}`. Both are required: the legacy host still proxies the whole
CRM, so gating only the apex would leave the other hostname as an open bypass.
`${CRM_WWW_DOMAIN}` needs nothing — it answers 301 to the apex, and following
that redirect anonymously still terminates at 401.

Sibling paths such as `/compensationfoo`, and every unrelated CRM route, keep
their current behaviour. The gate is scoped by an exact match plus a
trailing-slash prefix precisely so that it cannot spread.

## Source of truth

`deploy/nginx/templates/crm.conf.template`, owned by the `edge_delivery`
context. The served file `deploy/nginx/conf.d/crm.conf` is **generated** — the
nginx image entrypoint renders every `*.template` into `conf.d` at container
start — so editing the rendered file is lost on the next start and must never
be done.

`tools/architecture/check-compensation-edge-perimeter-boundary.mjs` asserts the
invariant: both proxying vhosts gated, the gate scoped to the segment, each
gated location repeating its vhost's proxy directives verbatim so the
functional delta is exactly "+ Basic Auth", the password file read from the
read-only templates mount, and no credential material committed.

## The credential file

Host-managed, never in Git, never in application environment.

| property | value |
|---|---|
| host path | `deploy/nginx/templates/auth/compensation.htpasswd` |
| path in container | `/etc/nginx/templates/auth/compensation.htpasswd` |
| mount | the existing `./nginx/templates:/etc/nginx/templates:ro` bind — **read-only**, no compose change |
| directory | `auth/` — `0710 root:101` |
| file | `0640 root:101` |
| format | bcrypt (`$2b$`, cost 12) |

**The gate is directory traversal, not file ownership, and host UID 101 owns
nothing.** That distinction is the whole point. Without user namespaces —
and this host has none — container UID 101 *is* host UID 101, which is
`systemd-resolve`, an active, network-facing daemon. A file merely *owned* by
UID 101 is therefore readable by that daemon no matter how tight its mode is:
`0400` protects against everyone except the owner, and here the owner is a
running service. Ownership by 101 was rejected for exactly this reason.

With `auth/` at `0710 root:101`, `others` have no traverse bit, so an unrelated
host account cannot enter the directory and cannot open the file whatever its
mode. Inside the container the nginx worker runs uid 101 **gid 101**, matches
the directory's group, traverses, and reads the file by group permission.

Rejected alternatives, with the measured reason: `0644` makes the hash
world-readable; `root:root 0640` and `root:root 0400` fail outright (500),
because the worker rather than the master opens the file; `101:0 0400` under
world-traversable parents is readable by `systemd-resolved`.

### Activation preflight — fail closed

An empty `/etc/group` member list for GID 101 is **not** sufficient proof of
isolation. Before activation, a read-only preflight must confirm that **no
unrelated non-root host process** has GID 101 as its real, effective,
saved/fs, or supplementary group. If any does, activation must abort: that
process would gain read access to the hash through the directory's group bit.
Root access is outside this boundary and is expected.

This residual exists only because container and host share a UID/GID space.
Userns remapping or a dedicated uid would remove it; that is an infrastructure
decision beyond this pilot, and the preflight is what makes the pilot's
temporary arrangement safe in the meantime.

Generate it without the password ever reaching a command line or shell history:

```bash
python3 -c 'import crypt,getpass;print("pilot:"+crypt.crypt(getpass.getpass(),crypt.mksalt(crypt.METHOD_BLOWFISH,rounds=4096)))'
```

Write the output into the file, then set the contract:

```bash
mkdir -p deploy/nginx/templates/auth
chown root:101 deploy/nginx/templates/auth && chmod 0710 deploy/nginx/templates/auth
chown root:101 deploy/nginx/templates/auth/compensation.htpasswd
chmod 0640 deploy/nginx/templates/auth/compensation.htpasswd
```

If Python's `crypt` module is unavailable (removed in 3.13),
`openssl passwd -6 -stdin` produces a SHA-512 crypt hash that nginx also
accepts; bcrypt is preferred because it is a deliberately slow KDF with a
tunable cost. Never pass the password as a command argument — both forms above
read it interactively, so it reaches neither argv nor shell history.

Only the credential's exact path is git-ignored, not the `auth/` directory, so
an ordinary file added there stays visible to Git. The boundary control backs
that up by refusing any tracked file under `auth/` that contains a hash.

## Failure behaviour

Measured against the real image. Anonymous traffic is refused in **every**
state — no failure mode opens the route:

| credential file | anonymous | authenticated | `nginx -t` |
|---|---|---|---|
| present, readable | 401 | 200 | ok |
| missing | 401 | 403 | **ok** |
| present, unreadable | 401 | 500 | ok |

Note the middle row: `nginx -t` passes even with no credential file at all.
Config validation therefore cannot prove the gate is usable — **a successful
authenticated request is mandatory** in any verification.

## Verifying a change

Run the boundary control, and for behavioural proof use a disposable nginx
container built from the same `nginx:1.27-alpine` image and the same template
rendering path, with a stub backend standing in for `gravity-mvp:3002`. Never
verify against production. The matrix to cover is both hosts × {exact, nested,
evidence, POST, query-string, RSC} anonymous and authenticated, plus the
unrelated routes and the three credential-file states above.

## Production activation — not part of the implementation milestone

The logical gate is:

`LANDED / POST-MERGE GREEN` → production authorization → authoritative config
deployment through the approved release path → nginx config validation →
controlled activation → both-host runtime verification →
`PRODUCTION SECURITY BOUNDARY ACTIVE`

Runtime proof must include, for each of `${CRM_DOMAIN}` and
`${CRM_APP_DOMAIN}`: anonymous `/compensation` → 401 with no backend content,
authenticated `/compensation` → application reachable, nested and evidence
routes gated, POST gated, and unrelated routes unchanged.

**No sync or deploy command is prescribed here, deliberately.** The `/opt/crm`
release checkout is materially behind current main — its `origin/main` remote
ref is months stale and the commit that last changed this template is not in
its object database — so applying the current authoritative template would also
activate already-landed nginx changes, such as the `/api/debug-db` edge denial
that main has carried since 2026-08-10 but production has never received.
Choosing the synchronization and release mechanism is a later orchestration
decision. That drift is recorded here, not repaired here.

## Removing the perimeter

Revert the template hunks, validate, and re-render. Optionally delete the
password file. Nothing else is involved — no application, database, migration,
image or compose state. Removal restores the route's previous reachability,
which is public with cookie-only identity, so it is a deliberate re-exposure
decision rather than a neutral undo.
