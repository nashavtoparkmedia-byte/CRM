# CRM FreeSWITCH image: FreeSWITCH 1.10.12 + drachtio mod_audio_fork.
#
# Base safarov image's entrypoint does:
#   cp -varf /usr/share/freeswitch/conf/vanilla/* /etc/freeswitch/
# on first start. By baking our overrides into the vanilla dir at build time,
# that copy step puts OUR files in /etc/freeswitch instead of stock examples.
# No volume mounts needed at runtime → no read-only-mount conflicts.
#
# Release rules (fail closed):
# - Runtime and builder images are pinned by digest; apt comes from a dated Debian snapshot.
# - FreeSWITCH and libwebsockets sources are fetched by release tag and must match the pinned
#   commit AND tree ids.
# - Vendored mod_audio_fork sources, patches and SDK stubs must match the SHA-256 list below.
# - The built module, its shared-library dependencies and the derived modules.conf.xml must
#   match their pinned values; the module loads as critical, so FreeSWITCH refuses to start
#   without it.
# - The entrypoint refuses a missing or placeholder MEGAFON_SIP_PASSWORD.
# Building needs BuildKit (Docker 23+) for the heredoc COPY steps; the legacy builder fails to parse.
# Provenance: third_party/mod_audio_fork/PROVENANCE.json. Licences: third_party/mod_audio_fork/NOTICE.

ARG FREESWITCH_RUNTIME="safarov/freeswitch@sha256:b31c743f4c911a19687c61e3214968f2a24f93f9d3d667cc26284192e158ffc6"
ARG DEBIAN_BUILDER="debian@sha256:63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e"
ARG DEBIAN_SNAPSHOT="20260713T000000Z"
ARG FREESWITCH_TAG="v1.10.12"
ARG FREESWITCH_COMMIT="a88d069d6ffb74df797bcaf001f7e63181c07a09"
ARG FREESWITCH_TREE="957b630df3cf84f0170e4e49164bb4687365aa98"
ARG LWS_TAG="v4.3.3"
ARG LWS_COMMIT="4415e84c095857629863804e941b9e1c2e9347ef"
ARG LWS_TREE="ee0b8e3b1784b9b478931ee262a2500c4e5cf96a"
ARG MOD_AUDIO_FORK_SO_SHA256="5fcb933bb82caf5fe09d1ce82c345287c7f9f14c5989e8179acde7d5d3072e76"
ARG MOD_AUDIO_FORK_NEEDED="libc.so.6,libcrypto.so.3,libfreeswitch.so.1,libgcc_s.so.1,libspeexdsp.so.1,libssl.so.3,libstdc++.so.6"
ARG MODULES_CONF_SHA256="39b050b2dac83baeee678319be2dd81279592624bc9fdea882c049a24b7f40df"

FROM ${FREESWITCH_RUNTIME} AS runtime-base

FROM ${DEBIAN_BUILDER} AS builder
ARG DEBIAN_SNAPSHOT

RUN set -eu; \
    rm -f /etc/apt/sources.list.d/debian.sources; \
    printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s bookworm main\n' "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list; \
    printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s bookworm-updates main\n' "$DEBIAN_SNAPSHOT" >> /etc/apt/sources.list; \
    printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/%s bookworm-security main\n' "$DEBIAN_SNAPSHOT" >> /etc/apt/sources.list; \
    printf 'Acquire::Check-Valid-Until "false";\nAcquire::Retries "3";\n' > /etc/apt/apt.conf.d/99snapshot; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        autoconf automake build-essential ca-certificates cmake git patch \
        libcurl4-openssl-dev libedit-dev libjpeg-dev libldns-dev libncurses-dev \
        libopus-dev libpcre3-dev libsndfile1-dev libspeexdsp-dev libspeex-dev \
        libsqlite3-dev libssl-dev libtiff-dev libtool libtool-bin libuuid1 nasm \
        pkg-config uuid-dev zlib1g-dev; \
    rm -rf /var/lib/apt/lists/*

# Fetch a release tag and require the pinned commit and tree (content-addressed identity).
ARG FREESWITCH_TAG
ARG FREESWITCH_COMMIT
ARG FREESWITCH_TREE
ARG LWS_TAG
ARG LWS_COMMIT
ARG LWS_TREE
RUN set -eu; \
    fetch_tag() { \
      dir="$1"; url="$2"; tag="$3"; commit="$4"; tree="$5"; \
      git init -q "$dir"; \
      git -C "$dir" fetch -q --depth 1 "$url" "refs/tags/$tag"; \
      test "$(git -C "$dir" rev-parse 'FETCH_HEAD^{commit}')" = "$commit"; \
      test "$(git -C "$dir" rev-parse 'FETCH_HEAD^{tree}')" = "$tree"; \
      git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD; \
      rm -rf "$dir/.git"; \
    }; \
    fetch_tag /usr/src/freeswitch https://github.com/signalwire/freeswitch.git "$FREESWITCH_TAG" "$FREESWITCH_COMMIT" "$FREESWITCH_TREE"; \
    fetch_tag /usr/src/lws https://github.com/warmcat/libwebsockets.git "$LWS_TAG" "$LWS_COMMIT" "$LWS_TREE"

# SDK stubs first (they feed configure); every vendored file, these included, is verified against
# VENDORED_SHA256 below before the module is compiled.
COPY ./third_party/mod_audio_fork/fs-sdk/ /usr/src/mod_audio_fork/fs-sdk/

# FreeSWITCH 1.10.12 SDK: configure-only headers; link against the runtime's own libfreeswitch.
WORKDIR /usr/src/freeswitch
RUN ./bootstrap.sh -j2
RUN set -eu; \
    mkdir -p /opt/fs-sdk/lib/pkgconfig /opt/fs-sdk/include; \
    cp /usr/src/mod_audio_fork/fs-sdk/modules.conf /usr/src/freeswitch/modules.conf; \
    cp /usr/src/mod_audio_fork/fs-sdk/spandsp.pc /usr/src/mod_audio_fork/fs-sdk/sofia-sip-ua.pc /opt/fs-sdk/lib/pkgconfig/; \
    PKG_CONFIG_PATH=/opt/fs-sdk/lib/pkgconfig ./configure --prefix=/opt/fs-sdk --disable-dependency-tracking \
      --disable-core-pgsql-support --disable-silent-rules; \
    cp -a src/include/. /opt/fs-sdk/include/; \
    cp /usr/src/mod_audio_fork/fs-sdk/freeswitch.pc /opt/fs-sdk/lib/pkgconfig/freeswitch.pc
COPY --from=runtime-base /usr/lib/libfreeswitch.so.1.0.0 /opt/fs-sdk/lib/libfreeswitch.so.1.0.0
RUN ln -s libfreeswitch.so.1.0.0 /opt/fs-sdk/lib/libfreeswitch.so

# libwebsockets: static, PIC, OpenSSL 3, client use only; unused subsystems disabled.
WORKDIR /usr/src/lws
RUN set -eu; \
    cmake -S . -B build \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/lws \
      -DLWS_WITH_STATIC=ON -DLWS_WITH_SHARED=OFF -DLWS_STATIC_PIC=ON \
      -DLWS_WITH_SSL=ON -DLWS_WITHOUT_TESTAPPS=ON -DLWS_WITHOUT_TEST_SERVER=ON \
      -DLWS_WITH_MINIMAL_EXAMPLES=OFF -DLWS_WITH_LIBUV=OFF -DLWS_WITH_LIBEV=OFF \
      -DLWS_WITH_LIBEVENT=OFF -DLWS_WITH_GLIB=OFF -DLWS_WITH_ZLIB=OFF \
      -DLWS_WITH_EXTERNAL_POLL=OFF -DLWS_IPV6=ON \
      -DLWS_WITH_HTTP2=OFF -DLWS_WITH_SYS_ASYNC_DNS=OFF -DLWS_WITH_NETLINK=OFF; \
    cmake --build build --parallel 2; \
    cmake --install build

# Vendored mod_audio_fork sources and patches, verified by SHA-256 before use.
COPY ./third_party/mod_audio_fork/upstream/ /usr/src/mod_audio_fork/upstream/
COPY ./third_party/mod_audio_fork/patches/ /usr/src/mod_audio_fork/patches/
COPY <<'VENDORED_SHA256' /usr/src/mod_audio_fork.sha256
eba2946f0b39634dee761e3f20fa85651f27247e37e12ee8c029bc286c090919  upstream/LICENSE
ae1b6459b7c8a4776ec185cec2611a6cced36aa1ec535c4e0d335d46d93245a8  upstream/LICENSE.drachtio-freeswitch-modules
e3e7670abe457224fcc686f26dc7454b6a728878266109450bd7c1dfec995217  upstream/Makefile.am
3a4414bcf5eec1d3b2e8e43efc4ec160a12d5696af8760f14afa27f37a683af8  upstream/README.md
95376badc1f66a0e2cfb33e7ebd6b55966cb0b2a1412f21697f2c1d342b36f0d  upstream/audio_pipe.cpp
92647697d455c20652ca8c78161320c01e802901fa815050346764f099191e0b  upstream/audio_pipe.hpp
f36558bee162411d906d58bf0f00af8b4573ea2c8ab05a506bb2ab10285659a4  upstream/base64.hpp
0a7f26a4fb6be0e3e876f8cf78fc49dd123b013d6304c2242090e1c279b4e14a  upstream/lws_glue.cpp
1dec87ae9a8cff85da756dbb11adf2324d87a2b2757ccb1e678510e8614a54eb  upstream/lws_glue.h
36c048649a07d0e86356ca7620130572fdb94c1c88ab6f77ff5c3751b8ae0475  upstream/mod_audio_fork.c
21e02e35bce3472513baab65cd4813e71e245047cd4cb8604b454babf7cf8f2f  upstream/mod_audio_fork.h
3a81a4634d0c3b4db645b24a96b866d97d8e8daefaa7a7bf1562852dfeba2cb6  upstream/parser.cpp
dabe25957d404468426c0570f22fe6106b724a15c366162a1ea59396f862e3aa  upstream/parser.hpp
9bb680aa112a61b76f7b5413af84f1894990653cde5041314974ef1fcb0a6676  patches/0001-uuid_audio_fork-start-null-argv-guards.patch
22506ffcfbee2326bbd006fbe2e995fecc977f8d6fcb7da930a9518277d3278e  patches/0002-playAudio-require-string-audioContentType.patch
63d02df508594bbc75b25509128e9ecfd3ecd448df37f4c67394845fa42db088  patches/0003-refuse-runtime-unload.patch
557c480fd7f30754e28217d923cc70c4bb8cad723591fd8ee9401d38e5e0d6e6  fs-sdk/freeswitch.pc
68be44f1bfc982ea55277b4aa433ab8dbd4dd674cf3573faf1dbb5a5959363fa  fs-sdk/modules.conf
f72b1db67d36babd298d28fc2208b160337baed86334e8c7b44f449555d8cd6c  fs-sdk/sofia-sip-ua.pc
75de7bb00b720a5b02aa9ea14fbc325c40383802edbfe0d9a66d8fd7117767b6  fs-sdk/spandsp.pc
VENDORED_SHA256
COPY <<'PATCHED_SHA256' /usr/src/mod_audio_fork.patched.sha256
d0437ad2b9c5a5d85f6ae0b4c85400bd68726441a41a2aeb11972fe89e921994  mod_audio_fork.c
e1071b9f25e188822f2acdf4fee5f7f862d3ef55dc10b3b27fc42032d037bb12  lws_glue.cpp
PATCHED_SHA256
RUN set -eu; cd /usr/src/mod_audio_fork; sha256sum --strict -c /usr/src/mod_audio_fork.sha256

# mod_audio_fork: vendored sources + patches, hardened link, pinned output.
ARG MOD_AUDIO_FORK_SO_SHA256
ARG MOD_AUDIO_FORK_NEEDED
WORKDIR /usr/src/mod_audio_fork/upstream
RUN set -eu; \
    patch -p1 --forward --fuzz=0 --batch < ../patches/0001-uuid_audio_fork-start-null-argv-guards.patch; \
    patch -p1 --forward --fuzz=0 --batch < ../patches/0002-playAudio-require-string-audioContentType.patch; \
    patch -p1 --forward --fuzz=0 --batch < ../patches/0003-refuse-runtime-unload.patch; \
    sha256sum --strict -c /usr/src/mod_audio_fork.patched.sha256; \
    CF="$(pkg-config --cflags /opt/fs-sdk/lib/pkgconfig/freeswitch.pc) -I/opt/lws/include -fPIC -O2 -fvisibility=hidden -DSWITCH_API_VISIBILITY=1"; \
    gcc -c $CF -o mod_audio_fork.o mod_audio_fork.c; \
    for s in lws_glue parser audio_pipe; do g++ -c $CF -fvisibility-inlines-hidden -std=c++11 -o "$s.o" "$s.cpp"; done; \
    g++ -shared -o mod_audio_fork.so mod_audio_fork.o lws_glue.o parser.o audio_pipe.o \
        /opt/lws/lib/libwebsockets.a -L/opt/fs-sdk/lib -lfreeswitch -lspeexdsp -lssl -lcrypto -lpthread \
        -Wl,--no-undefined -Wl,-z,defs -Wl,-z,now -Wl,-z,relro -Wl,--exclude-libs,ALL; \
    mkdir -p /out; \
    strip --strip-unneeded -o /out/mod_audio_fork.so mod_audio_fork.so; \
    nm -D --defined-only /out/mod_audio_fork.so | grep -q ' D mod_audio_fork_module_interface$'; \
    actual_so="$(sha256sum /out/mod_audio_fork.so | cut -d' ' -f1)"; \
    actual_needed="$(readelf -d /out/mod_audio_fork.so | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p' | sort | tr '\n' ',' | sed 's/,$//')"; \
    echo "mod_audio_fork.so sha256=$actual_so needed=$actual_needed"; \
    test "$actual_so" = "$MOD_AUDIO_FORK_SO_SHA256"; \
    test "$actual_needed" = "$MOD_AUDIO_FORK_NEEDED"; \
    cp /usr/src/lws/LICENSE /out/LICENSE.libwebsockets

# modules.conf.xml: the pinned runtime's vanilla file plus exactly one critical load line.
ARG MODULES_CONF_SHA256
COPY --from=runtime-base /usr/share/freeswitch/conf/vanilla/autoload_configs/modules.conf.xml /tmp/modules.conf.base.xml
RUN set -eu; \
    test "$(grep -c '<load module="mod_event_socket"/>' /tmp/modules.conf.base.xml)" = 1; \
    test "$(grep -c 'mod_audio_fork' /tmp/modules.conf.base.xml)" = 0; \
    sed 's|^\([[:space:]]*\)<load module="mod_event_socket"/>|&\n\1<load module="mod_audio_fork" critical="true"/>|' \
      /tmp/modules.conf.base.xml > /out/modules.conf.xml; \
    test "$(grep -c '<load module="mod_audio_fork" critical="true"/>' /out/modules.conf.xml)" = 1; \
    test "$(diff /tmp/modules.conf.base.xml /out/modules.conf.xml | grep -c '^[<>]')" = 1; \
    actual_conf="$(sha256sum /out/modules.conf.xml | cut -d' ' -f1)"; \
    echo "modules.conf.xml sha256=$actual_conf"; \
    test "$actual_conf" = "$MODULES_CONF_SHA256"

FROM ${FREESWITCH_RUNTIME} AS final
ARG MOD_AUDIO_FORK_SO_SHA256
ARG FREESWITCH_COMMIT
ARG LWS_COMMIT
LABEL org.opencontainers.image.title="CRM FreeSWITCH" \
      io.yoko.telephony.freeswitch.commit="${FREESWITCH_COMMIT}" \
      io.yoko.telephony.mod_audio_fork.source="swh:1:rev:88e1465908a89bed5c95d336aa53a3899bb5abb5+patches-0001-0003" \
      io.yoko.telephony.mod_audio_fork.sha256="${MOD_AUDIO_FORK_SO_SHA256}" \
      io.yoko.telephony.libwebsockets.commit="${LWS_COMMIT}"

COPY ./conf/vars.xml /usr/share/freeswitch/conf/vanilla/vars.xml
COPY ./conf/sip_profiles/internal.xml /usr/share/freeswitch/conf/vanilla/sip_profiles/internal.xml
COPY ./conf/sip_profiles/external/megafon.xml /usr/share/freeswitch/conf/vanilla/sip_profiles/external/megafon.xml
COPY ./conf/directory/default/101.xml /usr/share/freeswitch/conf/vanilla/directory/default/101.xml
COPY ./conf/directory/default/102.xml /usr/share/freeswitch/conf/vanilla/directory/default/102.xml
COPY ./conf/directory/default/103.xml /usr/share/freeswitch/conf/vanilla/directory/default/103.xml
COPY ./conf/dialplan/default/02_megafon_inbound.xml /usr/share/freeswitch/conf/vanilla/dialplan/default/02_megafon_inbound.xml
COPY ./conf/dialplan/default/03_user_outbound.xml /usr/share/freeswitch/conf/vanilla/dialplan/default/03_user_outbound.xml
COPY ./conf/autoload_configs/event_socket.conf.xml /usr/share/freeswitch/conf/vanilla/autoload_configs/event_socket.conf.xml
COPY ./conf/autoload_configs/acl.conf.xml /usr/share/freeswitch/conf/vanilla/autoload_configs/acl.conf.xml
COPY ./conf/autoload_configs/logfile.conf.xml /usr/share/freeswitch/conf/vanilla/autoload_configs/logfile.conf.xml
COPY ./conf/dialplan/public/00_inbound_did.xml /usr/share/freeswitch/conf/vanilla/dialplan/public/00_inbound_did.xml
COPY ./conf/dialplan/default/99_audio_fork_test.xml /usr/share/freeswitch/conf/vanilla/dialplan/default/99_audio_fork_test.xml

COPY --from=builder /out/modules.conf.xml /usr/share/freeswitch/conf/vanilla/autoload_configs/modules.conf.xml
COPY --from=builder /out/mod_audio_fork.so /usr/lib/freeswitch/mod/mod_audio_fork.so
COPY --from=builder /out/LICENSE.libwebsockets /usr/share/doc/crm-telephony/mod_audio_fork/LICENSE.libwebsockets
COPY ./third_party/mod_audio_fork/NOTICE ./third_party/mod_audio_fork/PROVENANCE.json ./third_party/mod_audio_fork/upstream/LICENSE ./third_party/mod_audio_fork/upstream/LICENSE.drachtio-freeswitch-modules /usr/share/doc/crm-telephony/mod_audio_fork/

# The installed module must be the pinned binary and resolve every library and symbol in this
# runtime. LD_WARN + LD_BIND_NOW make the loader report unresolved symbols (as `ldd -r` does);
# a plain --list only reports missing libraries.
RUN set -eu; \
    test "$(sha256sum /usr/lib/freeswitch/mod/mod_audio_fork.so | cut -d' ' -f1)" = "$MOD_AUDIO_FORK_SO_SHA256"; \
    linkage="$(LD_TRACE_LOADED_OBJECTS=1 LD_WARN=yes LD_BIND_NOW=yes /lib64/ld-linux-x86-64.so.2 /usr/lib/freeswitch/mod/mod_audio_fork.so 2>&1)"; \
    if printf '%s\n' "$linkage" | grep -Eq 'not found|undefined symbol'; then printf '%s\n' "$linkage"; exit 1; fi

COPY --chmod=0755 <<'FREESWITCH_TRUNK_GUARD' /usr/local/bin/crm-freeswitch-trunk-guard
#!/bin/sh
set -u
reason=
case "${MEGAFON_SIP_PASSWORD-}" in
  '') reason='is missing or empty' ;;
  __*__|*FILL_LATER*|replace-with-*|changeme*|CHANGEME*|your-*|*placeholder*|*PLACEHOLDER*|*REDACTED*)
    reason='is a placeholder' ;;
  -*) reason='starts with a dash' ;;
  '~'*) reason='starts with a tilde' ;;
  *[!A-Za-z0-9._~+=/@,-]*) reason='contains a character outside the allowed set' ;;
esac
if [ -z "$reason" ] && [ "${#MEGAFON_SIP_PASSWORD}" -lt 8 ]; then
  reason='is shorter than 8 characters'
fi
if [ -n "$reason" ]; then
  echo "crm-freeswitch: refusing to start: MEGAFON_SIP_PASSWORD $reason" >&2
  exit 64
fi
exec /docker-entrypoint.sh "$@"
FREESWITCH_TRUNK_GUARD
ENTRYPOINT ["/usr/local/bin/crm-freeswitch-trunk-guard"]
