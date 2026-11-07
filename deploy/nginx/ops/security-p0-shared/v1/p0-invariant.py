#!/usr/bin/env python3
"""p0-invariant v1 — the Security P0 edge invariant for YOKO CRM, as one read-only check.

INVARIANT: no request from the internet reaches Gravity (gravity-mvp:3002) without a
Basic-auth login. Concretely, in every nginx server block that proxies to Gravity:
  G1  server-level  auth_basic "YOKO CRM";
  G2  server-level  auth_basic_user_file <one of the accepted staff files>;
      accepted: /etc/nginx/templates/yoko-crm-staff.htpasswd        (production 2026-10-25)
                /etc/nginx/templates/auth/yoko-crm-staff.htpasswd   (MAIN layout: auth/ dir)
  G3  server-level  add_header X-Yoko-Edge-Gate "crm-staff-p0-20261025" always;
  G4  `auth_basic off` only in locations that never reach Gravity (e.g. /wss-sip);
      a location-level realm must name its own user file (still authenticated)
  G5  no `satisfy any` anywhere in the block
  G6  every location that reaches Gravity strips the Basic password
      (proxy_set_header Authorization "")
and at least one such server block exists.

Usage (exit 0 HOLDS, 1 VIOLATED, 2 UNKNOWN — callers MUST treat 2 as 1, 64 usage):
  p0-invariant.py template FILE      structural invariant + approved-template identity
  p0-invariant.py rendered FILE      structural invariant of a rendered conf (conf.d/crm.conf)
  p0-invariant.py backup DIR         a restore source: DIR/crm.conf.template and DIR/crm.conf
  p0-invariant.py map-only-diff A B  A and B differ at most in the Cash action-id map entries
  p0-invariant.py disk               production files: template, render, staff htpasswd
  p0-invariant.py live [--public]    disk + loaded config (nginx -T) + worker read test +
                                     anonymous probes from inside crm-nginx (and via the
                                     public IP with --public)
Options: --json (one JSON object on stdout instead of lines), --strict-consistency
(a Cash login missing from the staff file is a FAIL instead of a WARN).

Never prints credential material: htpasswd files are checked for shape, mode and
readability; only counts are reported.
"""
import hashlib
import json
import os
import re
import stat
import subprocess
import sys

VERSION = "p0-invariant/v1"
HERE = os.path.dirname(os.path.abspath(__file__))
APPROVED = os.path.join(HERE, "approved-templates.v1.txt")

# Test-only overrides (offline harness). Callers run the checker under `env -i`, so these
# never leak in; when set, the report carries a WARN row saying so.
OVERRIDES = {k: os.environ[k] for k in ("P0_NGINX_DIR", "P0_CONTAINER") if os.environ.get(k)}
NGINX_DIR = OVERRIDES.get("P0_NGINX_DIR", "/opt/crm/deploy/nginx")
TEMPLATE = NGINX_DIR + "/templates/crm.conf.template"
RENDERED = NGINX_DIR + "/conf.d/crm.conf"
CONTAINER = OVERRIDES.get("P0_CONTAINER", "crm-nginx")
CONTAINER_NGINX_DIR = "/etc/nginx"          # NGINX_DIR is mounted here (templates/ ro, conf.d rw)
NGINX_GID = 101
PUBLIC_IP = "155.212.130.14"
DOCKER = "/usr/bin/docker"
CURL = "/usr/bin/curl"

GATE_REALM = "YOKO CRM"
GATE_FILES = (
    "/etc/nginx/templates/yoko-crm-staff.htpasswd",        # production layout 2026-10-25
    "/etc/nginx/templates/auth/yoko-crm-staff.htpasswd",   # MAIN layout: dedicated auth/ directory
)
MARKER_NAME = "X-Yoko-Edge-Gate"
MARKER_VALUE = "crm-staff-p0-20261025"
GRAVITY = "gravity-mvp:3002"
TEMPLATE_VARS = ("CRM_DOMAIN", "CRM_WWW_DOMAIN", "CRM_APP_DOMAIN", "BOT_ADMIN_DOMAIN", "SITE_DOMAIN")
HTPASSWD_LINE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,31}:\$(2[aby]\$|5\$|6\$|apr1\$)\S+$")
MAP_ENTRY = re.compile(r'^\s*"~\*[0-9a-f]+"\s+1;\s*$')


class Report:
    def __init__(self, mode):
        self.mode, self.rows = mode, []

    def add(self, status, check, detail=""):
        self.rows.append({"status": status, "check": check, "detail": detail})

    def result(self):
        s = {r["status"] for r in self.rows}
        if "FAIL" in s:
            return "VIOLATED", 1
        if "UNKNOWN" in s or not self.rows:
            return "UNKNOWN", 2
        return "HOLDS", 0


# ---------------------------------------------------------------- nginx parsing
def strip_comments(text):
    out, quote = [], None
    for line in text.splitlines():
        buf, i = [], 0
        while i < len(line):
            c = line[i]
            if quote:
                buf.append(c)
                if c == "\\" and i + 1 < len(line):
                    buf.append(line[i + 1]); i += 1
                elif c == quote:
                    quote = None
            elif c in "\"'":
                quote = c; buf.append(c)
            elif c == "#":
                break
            else:
                buf.append(c)
            i += 1
        out.append("".join(buf))
    return "\n".join(out)


def tokenize(text):
    toks, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c.isspace():
            i += 1
        elif c in "{};":
            toks.append(c); i += 1
        elif c in "\"'":
            q, j, buf = c, i + 1, []
            while j < n and text[j] != q:
                if text[j] == "\\" and j + 1 < n:
                    buf.append(text[j + 1]); j += 2
                else:
                    buf.append(text[j]); j += 1
            toks.append(("Q", "".join(buf))); i = j + 1
        else:
            j = i
            while j < n and not text[j].isspace() and text[j] not in "{};\"'":
                if text[j] == "$" and j + 1 < n and text[j + 1] == "{":   # ${VAR}: template placeholder, not a block
                    close = text.find("}", j)
                    j = n if close < 0 else close
                j += 1
            toks.append(text[i:j]); i = j
    return toks


def parse(text):
    """-> list of nodes {name, args, children|None}; raises ValueError on unbalanced input."""
    toks = tokenize(strip_comments(text))
    pos = 0

    def val(t):
        return t[1] if isinstance(t, tuple) else t

    def block(top=False):
        nonlocal pos
        nodes = []
        while pos < len(toks):
            t = toks[pos]
            if t == "}":
                if top:
                    raise ValueError("unexpected }")
                pos += 1
                return nodes
            words = []
            while pos < len(toks) and toks[pos] not in ("{", ";", "}"):
                words.append(val(toks[pos])); pos += 1
            if pos >= len(toks):
                raise ValueError("unterminated directive")
            if toks[pos] == ";":
                pos += 1
                if words:
                    nodes.append({"name": words[0], "args": words[1:], "children": None})
            elif toks[pos] == "{":
                pos += 1
                nodes.append({"name": words[0] if words else "", "args": words[1:], "children": block()})
            else:
                raise ValueError("unexpected }")
        if not top:
            raise ValueError("unclosed block")
        return nodes

    tree = block(top=True)
    if pos != len(toks):
        raise ValueError("unbalanced braces")
    return tree


def walk(nodes):
    for n in nodes:
        yield n
        if n["children"] is not None:
            yield from walk(n["children"])


def servers(tree):
    return [n for n in walk(tree) if n["name"] == "server" and n["children"] is not None]


def reaches_gravity(node):
    nodes = node["children"] if node["children"] is not None else [node]
    return any(GRAVITY in " ".join(d["args"]) for d in walk(nodes) if d["name"] in ("proxy_pass", "set"))


def direct(node, name):
    return [d for d in node["children"] if d["name"] == name and d["children"] is None]


def strips_password(node, server_level_strips):
    psh = direct(node, "proxy_set_header")
    if not psh:
        return server_level_strips
    return any(len(d["args"]) == 2 and d["args"][0].lower() == "authorization" and d["args"][1] == "" for d in psh)


def gravity_servers(text):
    return [s for s in servers(parse(text)) if reaches_gravity(s)]


def auth_files(text):
    """(staff container path | None, sorted other user files) named by the Gravity server blocks.
    The staff file is the server-level G2 directive; the others are location-level gates (Cash)."""
    staff, others = None, set()
    try:
        gsrv = gravity_servers(text)
    except ValueError:
        return None, []
    for s in gsrv:
        for d in direct(s, "auth_basic_user_file"):
            if d["args"] and d["args"][0] in GATE_FILES:
                staff = staff or d["args"][0]
        for d in walk(s["children"]):
            if d["name"] == "auth_basic_user_file" and d["children"] is None and d["args"] and d["args"][0] != staff:
                others.add(d["args"][0])
    return staff, sorted(others)


def host_path(container_path):
    """/etc/nginx/<x> inside crm-nginx is NGINX_DIR/<x> on the host (the compose mounts)."""
    if not container_path.startswith(CONTAINER_NGINX_DIR + "/"):
        return None
    return NGINX_DIR + container_path[len(CONTAINER_NGINX_DIR):]


def check_structure(rep, text, label):
    try:
        tree = parse(text)
    except ValueError as exc:
        rep.add("UNKNOWN", "parse", f"{label}: {exc}")
        return
    gsrv = [s for s in servers(tree) if reaches_gravity(s)]
    if not gsrv:
        rep.add("FAIL", "gravity-servers", f"{label}: no server block proxies to {GRAVITY}")
        return
    rep.add("PASS", "gravity-servers", f"{label}: {len(gsrv)} server block(s) proxy to Gravity")
    for s in gsrv:
        name = " ".join(a for d in direct(s, "server_name") for a in d["args"]) or "?"
        tag = f"{label} [{name}]"
        ab = [d["args"] for d in direct(s, "auth_basic")]
        rep.add("PASS" if ab == [[GATE_REALM]] else "FAIL", "G1-server-auth_basic", f"{tag}: {ab or 'missing'}")
        uf = [d["args"] for d in direct(s, "auth_basic_user_file")]
        g2 = len(uf) == 1 and len(uf[0]) == 1 and uf[0][0] in GATE_FILES
        rep.add("PASS" if g2 else "FAIL", "G2-server-user-file", f"{tag}: {uf or 'missing'} (accepted: {list(GATE_FILES)})")
        mk = [d["args"] for d in direct(s, "add_header") if d["args"][:1] and d["args"][0].lower() == MARKER_NAME.lower()]
        rep.add("PASS" if mk == [[MARKER_NAME, MARKER_VALUE, "always"]] else "FAIL", "G3-server-marker", f"{tag}: {mk or 'missing'}")
        sat = [d for d in walk(s["children"]) if d["name"] == "satisfy" and d["args"] and d["args"][0] == "any"]
        rep.add("FAIL" if sat else "PASS", "G5-no-satisfy-any", f"{tag}: {len(sat)} found")
        server_strips = strips_password(s, False)
        bad_off, bad_realm, bad_strip, locs = [], [], [], 0
        for loc in walk(s["children"]):
            if loc["name"] not in ("location", "if", "limit_except") or loc["children"] is None:
                continue
            locs += 1
            where = " ".join(loc["args"]) or loc["name"]
            for d in direct(loc, "auth_basic"):
                if d["args"] == ["off"]:
                    if reaches_gravity(loc):
                        bad_off.append(where)
                elif not direct(loc, "auth_basic_user_file"):
                    bad_realm.append(where)
            if loc["name"] == "location" and direct(loc, "proxy_pass") and reaches_gravity(loc) and not strips_password(loc, server_strips):
                bad_strip.append(where)
        rep.add("FAIL" if bad_off or bad_realm else "PASS", "G4-location-auth",
                f"{tag}: {locs} location/if blocks; auth_basic off on a Gravity path: {bad_off or 'none'}; realm without user file: {bad_realm or 'none'}")
        rep.add("FAIL" if bad_strip else "PASS", "G6-password-stripped", f"{tag}: Gravity locations keeping Authorization: {bad_strip or 'none'}")
        robots = any(d["name"] == "location" and d["args"] == ["=", "/robots.txt"] for d in s["children"])
        xrt = any(d["args"][:1] and d["args"][0].lower() == "x-robots-tag" for d in direct(s, "add_header"))
        rep.add("PASS" if robots and xrt else "WARN", "robots-noindex", f"{tag}: robots.txt={robots} X-Robots-Tag={xrt}")


# ---------------------------------------------------------------- identity
def normalize(text):
    """Template text with the Cash action-id map entries removed (they change per Gravity build)."""
    out, in_map = [], False
    for line in text.splitlines():
        if re.match(r"^\s*map\s+\$http_next_action\s+\$yoko_cash_action_elsewhere\s*\{", line):
            in_map = True
        elif in_map and line.strip() == "}":
            in_map = False
        elif in_map and MAP_ENTRY.match(line):
            continue
        out.append(line)
    return "\n".join(out) + "\n"


def approved_set():
    try:
        rows = [l.split() for l in open(APPROVED) if l.strip() and not l.startswith("#")]
    except OSError:
        return None
    return {r[0]: (r[1] if len(r) > 1 else "") for r in rows if re.fullmatch(r"[0-9a-f]{64}", r[0])}


def check_identity(rep, text, label):
    appr = approved_set()
    if appr is None:
        rep.add("UNKNOWN", "approved-template", f"registry missing: {APPROVED}")
        return
    full = hashlib.sha256(text.encode()).hexdigest()
    norm = hashlib.sha256(normalize(text).encode()).hexdigest()
    if norm in appr:
        rep.add("PASS", "approved-template", f"{label}: sha256 {full}, normalized {norm[:16]} = approved '{appr[norm]}'")
    else:
        rep.add("FAIL", "approved-template", f"{label}: sha256 {full}, normalized {norm[:16]} is not an approved P0 template (only Cash map entries may differ)")


# ---------------------------------------------------------------- files
def read_text(rep, path, check):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError as exc:
        rep.add("FAIL", check, f"{path}: {exc.strerror}")
        return None


def htpasswd_logins(path):
    with open(path) as fh:
        lines = [l.rstrip("\n") for l in fh if l.strip()]
    return lines, [l.split(":", 1)[0] for l in lines]


def check_staff(rep, strict, staff_host, cash_hosts):
    try:
        st = os.lstat(staff_host)
    except OSError:
        rep.add("FAIL", "staff-htpasswd", f"{staff_host} missing")
        return
    shape = stat.S_ISREG(st.st_mode) and stat.S_IMODE(st.st_mode) == 0o640 and st.st_uid == 0 and st.st_gid == NGINX_GID
    rep.add("PASS" if shape else "FAIL", "staff-htpasswd-mode",
            f"{staff_host}: regular={stat.S_ISREG(st.st_mode)} mode={oct(stat.S_IMODE(st.st_mode))} uid={st.st_uid} gid={st.st_gid} (want regular 0o640 0 {NGINX_GID})")
    parent = os.path.dirname(staff_host)
    try:
        pm = stat.S_IMODE(os.stat(parent).st_mode)
        if pm & 0o001:
            rep.add("WARN", "staff-dir-traversal", f"{parent}: mode {oct(pm)}; others can traverse, so the hash is readable by any host process with gid {NGINX_GID}; the auth/ layout (0710 root:{NGINX_GID}) closes this")
        else:
            rep.add("PASS", "staff-dir-traversal", f"{parent}: mode {oct(pm)}, others cannot traverse")
    except OSError:
        rep.add("UNKNOWN", "staff-dir-traversal", f"{parent}: cannot stat")
    lines, logins = htpasswd_logins(staff_host)
    bad = sum(1 for l in lines if not HTPASSWD_LINE.match(l))
    dup = len(logins) - len(set(logins))
    ok = lines and not bad and not dup
    rep.add("PASS" if ok else "FAIL", "staff-htpasswd-lines", f"logins={len(lines)} malformed={bad} duplicate={dup}")
    for cash_host in cash_hosts:
        if not os.path.exists(cash_host):
            continue
        _, cash = htpasswd_logins(cash_host)
        missing = len(set(cash) - set(logins))
        rep.add("PASS" if not missing else ("FAIL" if strict else "WARN"), "cash-subset-of-staff",
                f"{os.path.basename(cash_host)}: logins={len(cash)} missing from staff file={missing} (each Cash login must also be a staff login)")


def run(args, timeout=30, stdin=None):
    try:
        return subprocess.run(args, capture_output=True, timeout=timeout, input=stdin, env={"PATH": "/usr/bin:/bin"})
    except (OSError, subprocess.TimeoutExpired):
        return None


def container_env(rep):
    p = run([DOCKER, "inspect", CONTAINER, "--format", "{{range .Config.Env}}{{println .}}{{end}}"])
    if p is None or p.returncode != 0:
        rep.add("UNKNOWN", "container-env", f"docker inspect {CONTAINER} failed")
        return None
    env = dict(l.split("=", 1) for l in p.stdout.decode().splitlines() if "=" in l)
    missing = [k for k in TEMPLATE_VARS if k not in env]
    if missing:
        rep.add("UNKNOWN", "container-env", f"missing {missing}")
        return None
    return env


def render(text, env):
    for k in TEMPLATE_VARS:
        text = text.replace("${%s}" % k, env[k])
    return text


def check_disk(rep, strict):
    """-> the staff file's container path (for the live worker read test)."""
    t = read_text(rep, TEMPLATE, "template")
    staff_c, cash_cs = (auth_files(t) if t is not None else (None, []))
    if t is not None:
        check_structure(rep, t, "template")
        check_identity(rep, t, "template")
    r = read_text(rep, RENDERED, "rendered")
    if r is not None:
        check_structure(rep, r, "rendered")
        env = container_env(rep) if t is not None else None
        if env is not None:
            same = render(t, env) == r
            rep.add("PASS" if same else "FAIL", "render-matches-template",
                    "conf.d/crm.conf is the entrypoint render of the template" if same
                    else "conf.d/crm.conf differs from the render of the template (conf.d-only edit or stale render)")
    staff_c = staff_c or GATE_FILES[0]
    check_staff(rep, strict, host_path(staff_c), [h for h in (host_path(c) for c in cash_cs) if h])
    return staff_c


def probe_headers(args, stdin=None):
    p = run(args, timeout=25, stdin=stdin)
    if p is None or p.returncode not in (0,):
        return None
    blocks = re.split(rb"\r?\n\r?\n", p.stdout.strip())
    head = [b for b in blocks if b.startswith(b"HTTP/") and b" Connection established" not in b.split(b"\r\n", 1)[0]]
    if not head:
        return None
    lines = head[-1].decode(errors="replace").splitlines()
    code = lines[0].split()[1] if len(lines[0].split()) > 1 else "000"
    hdr = {}
    for l in lines[1:]:
        k, _, v = l.partition(":")
        hdr.setdefault(k.strip().lower(), v.strip())
    return code, hdr


def check_probes(rep, names, public):
    for name in names:
        for method, path in (("GET", "/"), ("GET", "/api/health"), ("POST", "/")):
            base = ["-sS", "-k", "-o", "/dev/null", "-D", "-", "--max-time", "15", "-A", VERSION, "-X", method]
            if method == "POST":
                base += ["--data", ""]
            if public:
                res = probe_headers([CURL, *base, "--resolve", f"{name}:443:{PUBLIC_IP}", f"https://{name}{path}"])
                where = "public"
            else:
                res = probe_headers([DOCKER, "exec", CONTAINER, "curl", *base, "--resolve", f"{name}:443:127.0.0.1", f"https://{name}{path}"])
                where = "internal"
            label = f"{where} anonymous {method} https://{name}{path}"
            if res is None:
                rep.add("UNKNOWN", "live-probe", f"{label}: no response")
                continue
            code, hdr = res
            ok = code == "401" and hdr.get("www-authenticate") == f'Basic realm="{GATE_REALM}"' and hdr.get(MARKER_NAME.lower()) == MARKER_VALUE
            rep.add("PASS" if ok else "FAIL", "live-probe", f"{label}: {code} realm={hdr.get('www-authenticate', '-')} marker={hdr.get(MARKER_NAME.lower(), '-')}")


def check_live(rep, public, strict):
    staff_c = check_disk(rep, strict)
    p = run([DOCKER, "inspect", "-f", "{{.State.Running}}", CONTAINER])
    if p is None or p.stdout.strip() != b"true":
        rep.add("UNKNOWN", "container", f"{CONTAINER} not running or not inspectable")
        return
    p = run([DOCKER, "exec", CONTAINER, "nginx", "-T"], timeout=30)
    if p is None or p.returncode != 0:
        rep.add("UNKNOWN", "nginx-T", "nginx -T failed")
        return
    loaded = p.stdout.decode(errors="replace")
    check_structure(rep, loaded, "nginx -T")
    p = run([DOCKER, "exec", "-u", f"{NGINX_GID}:{NGINX_GID}", CONTAINER, "test", "-r", staff_c])
    rep.add("PASS" if p is not None and p.returncode == 0 else "FAIL", "worker-reads-staff-file", f"uid {NGINX_GID} can read {staff_c}")
    try:
        names = sorted({a for s in gravity_servers(loaded) for d in direct(s, "server_name") for a in d["args"]})
    except ValueError:
        names = []
    if not names:
        rep.add("UNKNOWN", "live-probe", "no Gravity server names found to probe")
        return
    check_probes(rep, names, False)
    if public:
        check_probes(rep, names, True)


# ---------------------------------------------------------------- main
def main(argv):
    as_json = "--json" in argv
    strict = "--strict-consistency" in argv
    public = "--public" in argv
    args = [a for a in argv if not a.startswith("--")]
    if not args:
        print(__doc__.split("Usage")[1] if "Usage" in __doc__ else __doc__, file=sys.stderr)
        return 64
    mode, rest = args[0], args[1:]
    rep = Report(mode)
    if OVERRIDES:
        rep.add("WARN", "test-override", f"non-production targets in effect: {sorted(OVERRIDES)}")
    if mode == "template" and len(rest) == 1:
        t = read_text(rep, rest[0], "template")
        if t is not None:
            check_structure(rep, t, "template")
            check_identity(rep, t, "template")
    elif mode == "rendered" and len(rest) == 1:
        r = read_text(rep, rest[0], "rendered")
        if r is not None:
            check_structure(rep, r, "rendered")
    elif mode == "backup" and len(rest) == 1:
        t = read_text(rep, os.path.join(rest[0], "crm.conf.template"), "backup-template")
        if t is not None:
            check_structure(rep, t, "backup template")
            check_identity(rep, t, "backup template")
        r = read_text(rep, os.path.join(rest[0], "crm.conf"), "backup-rendered")
        if r is not None:
            check_structure(rep, r, "backup rendered")
    elif mode == "map-only-diff" and len(rest) == 2:
        a, b = (read_text(rep, p, "map-only-diff") for p in rest)
        if a is not None and b is not None:
            same = normalize(a) == normalize(b)
            rep.add("PASS" if same else "FAIL", "map-only-diff", "differences limited to Cash action-id map entries" if same else "templates differ outside the Cash action-id map")
    elif mode == "disk" and not rest:
        check_disk(rep, strict)
    elif mode == "live" and not rest:
        check_live(rep, public, strict)
    else:
        print("usage: p0-invariant.py template FILE | rendered FILE | backup DIR | map-only-diff A B | disk | live [--public] [--json] [--strict-consistency]", file=sys.stderr)
        return 64
    verdict, code = rep.result()
    if as_json:
        print(json.dumps({"checker": VERSION, "mode": mode, "result": verdict, "exit": code, "checks": rep.rows}, ensure_ascii=False))
    else:
        for r in rep.rows:
            print(f"P0 {r['status']:7s} {r['check']:26s} {r['detail']}")
        print(f"P0-INVARIANT RESULT={verdict} mode={mode} checker={VERSION}")
    return code


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:  # any internal fault is UNKNOWN, never HOLDS
        print(f"P0 UNKNOWN internal {type(exc).__name__}: {exc}")
        print(f"P0-INVARIANT RESULT=UNKNOWN checker={VERSION}")
        sys.exit(2)
