#!/bin/bash
# Build FreeSWITCH 1.10 from source for WSL2 Ubuntu 24.04.
# Includes spandsp3 from FreeSWITCH's fork (Ubuntu ships old spandsp 0.0.6).
# Run as root: wsl -d Ubuntu-24.04 -u root -e bash /mnt/d/Github/CRM-telephony-test/telephony/wsl-build-fs.sh
set -e

# Extra deps that the first pass missed
echo "===> [0/8] Installing missing build deps"
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libspandsp-dev libtiff5-dev libldns-dev libpq-dev unixodbc-dev libmariadb-dev \
    libswresample-dev libpcap-dev 2>&1 | tail -3 || true

# spandsp3 — required by FS configure, Ubuntu only ships v0.0.6 (~v2)
echo "===> [1/8] Building spandsp3 (FreeSWITCH fork) — needed by FS configure"
cd /opt
if [ ! -d spandsp ]; then
  git clone --depth 1 https://github.com/freeswitch/spandsp.git
fi
cd /opt/spandsp
if [ ! -f /usr/local/lib/libspandsp.so ]; then
  ./bootstrap.sh
  ./configure --prefix=/usr/local
  make -j$(nproc)
  make install
  ldconfig
fi

# sofia-sip — required by FS for mod_sofia (Ubuntu has it, but version may
# be too old; the FS fork is the canonical source)
echo "===> [2/8] Building sofia-sip"
cd /opt
if [ ! -d sofia-sip ]; then
  git clone --depth 1 https://github.com/freeswitch/sofia-sip.git
fi
cd /opt/sofia-sip
if [ ! -f /usr/local/lib/libsofia-sip-ua.so ]; then
  ./bootstrap.sh
  ./configure --prefix=/usr/local --with-pic --with-glib=no
  make -j$(nproc)
  make install
  ldconfig
fi

echo "===> [3/8] Cloning FreeSWITCH source"
cd /opt
if [ ! -d freeswitch ]; then
  git clone --depth 1 https://github.com/signalwire/freeswitch.git -b v1.10 freeswitch
fi
cd /opt/freeswitch

echo "===> [4/8] Running FS bootstrap"
./bootstrap.sh -j

echo "===> [5/8] Trimming heavy/unneeded modules"
# Disabled modules:
#  - mod_av: FTBFS on Ubuntu 24.04 (FFmpeg 6 deprecates ticks_per_frame;
#    FS 1.10 treats deprecation as error). We get wav from mod_sndfile and
#    mp3 conversion happens in Node via @ffmpeg-installer/ffmpeg.
#  - mod_spandsp: FTBFS because spandsp git master changed v18_init signature
#    and renamed V18_MODE_* constants; FS 1.10 references the old API. We
#    only need it for T.38 fax and TDD — irrelevant to voice CRM. DTMF still
#    works via RFC 2833 in mod_sofia.
#  - mod_signalwire: needs libks (we skipped it), not used.
#  - mod_v8/python3/perl: scripting languages we don't use.
#  - mod_verto: alternative WebRTC transport; we use mod_sofia WSS instead.
for m in \
    applications/mod_signalwire \
    applications/mod_av \
    applications/mod_spandsp \
    applications/mod_fax \
    languages/mod_v8 \
    languages/mod_python3 \
    languages/mod_perl \
    endpoints/mod_verto \
    say/mod_say_zh \
    formats/mod_shout; do
  sed -i "s|^${m}|#${m}|" modules.conf || true
done

echo "===> [6/8] Configure"
# -Wno-error=deprecated-declarations: other modules may also hit FFmpeg 6
# deprecations; we don't want -Werror to nuke an otherwise-working build.
export CFLAGS="-Wno-error=deprecated-declarations -Wno-error=incompatible-pointer-types"
export CXXFLAGS="$CFLAGS"
PKG_CONFIG_PATH=/usr/local/lib/pkgconfig ./configure --enable-portable-binary --disable-dependency-tracking 2>&1 | tail -10

echo "===> [7/8] Compile (~10-15 min)"
# Clean any half-built objects from the previous attempt
make clean 2>&1 | tail -2 || true
make -j$(nproc)

echo "===> [8/8] Install + sample configs"
make install
make samples
ldconfig

echo "FS_BUILD_OK"
/usr/local/freeswitch/bin/freeswitch -version 2>&1 | head -3 || true
