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
# The original drachtio/drachtio-freeswitch-modules repo was deleted from
# GitHub (404). Active fork containing the same sources:
REPO_URL="https://github.com/mdslaney/drachtio-freeswitch-modules.git"

step() { echo; echo "===> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

step "Checking prerequisites"
command -v git >/dev/null || fail "git not installed"
command -v make >/dev/null || fail "make not installed"
[ -f "${FS_PREFIX}/include/freeswitch/switch.h" ] || fail "FreeSWITCH headers not found at ${FS_PREFIX}/include/freeswitch/"
[ -f "${FS_PREFIX}/lib/pkgconfig/freeswitch.pc" ] || fail "freeswitch.pc not found — FS not properly installed"

step "Installing build dependencies (libwebsockets-dev + audio libs)"
DEBIAN_FRONTEND=noninteractive apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    build-essential autoconf libtool pkg-config \
    libwebsockets-dev \
    libspeex-dev libspeexdsp-dev libsndfile1-dev

step "Cloning sources (or refreshing existing clone)"
if [ -d "${SRC_DIR}" ]; then
    cd "${SRC_DIR}"
    git fetch --depth 1 origin
    git reset --hard origin/HEAD
else
    git clone --depth 1 "${REPO_URL}" "${SRC_DIR}"
fi

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
