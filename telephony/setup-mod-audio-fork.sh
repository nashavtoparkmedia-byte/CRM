#!/bin/bash
# One-shot installer for FreeSWITCH mod_audio_fork on this machine.
#
# Run from WSL2 as root (sudo not needed if you're already root, which is
# the default in the project's WSL setup):
#
#     wsl bash /mnt/d/Github/CRM/.claude/worktrees/flamboyant-maxwell-8bca17/telephony/setup-mod-audio-fork.sh
#
# Or from inside WSL:
#
#     bash /mnt/d/Github/CRM-day1/telephony/setup-mod-audio-fork.sh
#
# Idempotent — safe to re-run. Will skip steps that are already done.

set -e

FS_PREFIX=/usr/local/freeswitch
SRC_DIR=/tmp/drachtio-freeswitch-modules
TARBALL=/tmp/drachtio-freeswitch-modules.tar.gz
# Original drachtio/drachtio-freeswitch-modules repo was deleted from GitHub
# (404). Active fork containing identical sources:
REPO_URL="https://github.com/mdslaney/drachtio-freeswitch-modules.git"
TARBALL_URL="https://codeload.github.com/mdslaney/drachtio-freeswitch-modules/tar.gz/refs/heads/main"

# Force non-interactive everywhere — no credential prompts, no apt prompts.
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/true
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export DEBIAN_FRONTEND=noninteractive

step() { echo; echo "===> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

step "Checking prerequisites"
command -v git >/dev/null || fail "git not installed"
command -v make >/dev/null || fail "make not installed"
[ -f "${FS_PREFIX}/include/freeswitch/switch.h" ] || fail "FreeSWITCH headers not found at ${FS_PREFIX}/include/freeswitch/"
[ -f "${FS_PREFIX}/lib/pkgconfig/freeswitch.pc" ] || fail "freeswitch.pc not found — FS not properly installed"

step "Killing any stale git clones from previous runs"
pkill -f 'git clone.*drachtio-freeswitch-modules' 2>/dev/null || true
sleep 1

step "Cleaning previous incomplete source dir"
rm -rf "${SRC_DIR}" "${TARBALL}"

step "Installing build dependencies (libwebsockets-dev + audio libs)"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
    build-essential autoconf libtool pkg-config \
    libwebsockets-dev \
    libspeex-dev libspeexdsp-dev libsndfile1-dev \
    ca-certificates curl

step "Fetching sources — tarball first (no git auth needed)"
HTTP_CODE=$(curl -sL -o "${TARBALL}" -w '%{http_code}' "${TARBALL_URL}" || echo "000")
TARBALL_SIZE=$(stat -c %s "${TARBALL}" 2>/dev/null || echo 0)
echo "tarball: HTTP ${HTTP_CODE}, ${TARBALL_SIZE} bytes"

if [ "${HTTP_CODE}" = "200" ] && [ "${TARBALL_SIZE}" -gt 100000 ]; then
    step "Extracting tarball"
    mkdir -p "${SRC_DIR}"
    tar -xzf "${TARBALL}" -C "${SRC_DIR}" --strip-components=1
else
    step "Tarball failed (${HTTP_CODE}/${TARBALL_SIZE}B), falling back to git clone"
    # GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS=/bin/true blocks any credential
    # prompt. Public repo doesn't need auth — if git still asks, it's
    # misconfigured locally; this aborts instead of hanging.
    if ! git clone --depth 1 "${REPO_URL}" "${SRC_DIR}"; then
        fail "Both tarball and git clone failed. Check internet, DNS, and whether github.com is reachable from WSL: 'wsl curl -I https://github.com'"
    fi
fi

# Sanity check
[ -d "${SRC_DIR}/modules/mod_audio_fork" ] || fail "modules/mod_audio_fork not found in fetched sources"

step "Building mod_audio_fork"
cd "${SRC_DIR}/modules/mod_audio_fork"

# bootstrap.sh generates configure from autogen sources
if [ -f bootstrap.sh ]; then
    ./bootstrap.sh
elif [ -f autogen.sh ]; then
    ./autogen.sh
else
    autoreconf -fiv
fi

# Tell configure where FS lives (this build is not in /usr/lib pkgconfig)
export PKG_CONFIG_PATH="${FS_PREFIX}/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
./configure --prefix="${FS_PREFIX}" CFLAGS="-I${FS_PREFIX}/include/freeswitch" CXXFLAGS="-I${FS_PREFIX}/include/freeswitch"
make -j$(nproc)
make install

step "Verifying .so deployed"
if [ ! -f "${FS_PREFIX}/mod/mod_audio_fork.so" ]; then
    fail "mod_audio_fork.so not deployed to ${FS_PREFIX}/mod/ — check make install output"
fi
echo "OK: $(ls -la ${FS_PREFIX}/mod/mod_audio_fork.so)"

step "Registering module in modules.conf.xml (if not already)"
MODULES_CONF="${FS_PREFIX}/conf/autoload_configs/modules.conf.xml"
if grep -q 'mod_audio_fork' "${MODULES_CONF}"; then
    echo "already registered"
else
    # Insert right after <modules> opening tag
    sed -i 's|<modules>|<modules>\n    <load module="mod_audio_fork"/>|' "${MODULES_CONF}"
    echo "added <load module=\"mod_audio_fork\"/>"
fi

step "Loading module into running FreeSWITCH"
if "${FS_PREFIX}/bin/fs_cli" -x "module_exists mod_audio_fork" 2>/dev/null | grep -q true; then
    echo "already loaded"
else
    "${FS_PREFIX}/bin/fs_cli" -x "load mod_audio_fork"
    sleep 1
    if "${FS_PREFIX}/bin/fs_cli" -x "module_exists mod_audio_fork" | grep -q true; then
        echo "OK: loaded"
    else
        fail "module did not load — check freeswitch.log for errors"
    fi
fi

step "Probing audio_fork usage"
"${FS_PREFIX}/bin/fs_cli" -x "audio_fork" 2>&1 | head -5

echo
echo "===> DONE. mod_audio_fork is built, installed, registered, and loaded."
