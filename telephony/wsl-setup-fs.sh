#!/bin/bash
# Post-build setup: copy our configs into the freshly-installed FS tree
# and start the daemon. Run after wsl-build-fs.sh finishes.
#
# Usage: wsl -d Ubuntu-24.04 -u root -e bash /mnt/d/Github/CRM-telephony-test/telephony/wsl-setup-fs.sh
set -e

FS_PREFIX=/usr/local/freeswitch
CONF_SRC=/mnt/d/Github/CRM-telephony-test/telephony/conf

if [ ! -d "${FS_PREFIX}" ]; then
  echo "FreeSWITCH not installed at ${FS_PREFIX}. Run wsl-build-fs.sh first."
  exit 1
fi

echo "===> Copying our configs over vanilla samples"

# vars.xml (Megafon creds, domain, RTP port range)
cp "${CONF_SRC}/vars.xml" "${FS_PREFIX}/conf/vars.xml"

# autoload_configs (ESL ACL + custom ACL definition)
cp "${CONF_SRC}/autoload_configs/event_socket.conf.xml" "${FS_PREFIX}/conf/autoload_configs/event_socket.conf.xml"
cp "${CONF_SRC}/autoload_configs/acl.conf.xml" "${FS_PREFIX}/conf/autoload_configs/acl.conf.xml"

# sip_profiles (internal with DTLS-SRTP, external megafon)
cp "${CONF_SRC}/sip_profiles/internal.xml" "${FS_PREFIX}/conf/sip_profiles/internal.xml"
mkdir -p "${FS_PREFIX}/conf/sip_profiles/external"
cp "${CONF_SRC}/sip_profiles/external/megafon.xml" "${FS_PREFIX}/conf/sip_profiles/external/megafon.xml"

# directory (extension users 101/102)
cp "${CONF_SRC}/directory/default/101.xml" "${FS_PREFIX}/conf/directory/default/101.xml"
cp "${CONF_SRC}/directory/default/102.xml" "${FS_PREFIX}/conf/directory/default/102.xml"

# dialplan (megafon inbound/outbound, user outbound)
cp "${CONF_SRC}/dialplan/default/01_megafon_outbound.xml" "${FS_PREFIX}/conf/dialplan/default/01_megafon_outbound.xml"
cp "${CONF_SRC}/dialplan/default/02_megafon_inbound.xml" "${FS_PREFIX}/conf/dialplan/default/02_megafon_inbound.xml"
cp "${CONF_SRC}/dialplan/default/03_user_outbound.xml" "${FS_PREFIX}/conf/dialplan/default/03_user_outbound.xml"

# Remove vanilla demo dialplan files. `01_example.com.xml` matches ANY
# 11-digit number first (alphabetic order — 01_* before 03_*) and bridges
# to a non-existent gateway, producing "484 Address Incomplete" before
# our outbound extension is even tried.
rm -f "${FS_PREFIX}/conf/dialplan/default/00_ladspa.xml"
rm -f "${FS_PREFIX}/conf/dialplan/default/00_pizza_demo.xml"
rm -f "${FS_PREFIX}/conf/dialplan/default/01_Talking_Clock.xml"
rm -f "${FS_PREFIX}/conf/dialplan/default/01_example.com.xml"

# Recordings directory (Megafon bridge writes here)
mkdir -p /var/lib/freeswitch/recordings
chmod 755 /var/lib/freeswitch/recordings

echo "===> Verifying critical params present in internal.xml"
grep -E '(dtls-srtp|rtp-secure-media|wss-binding|ws-binding)' "${FS_PREFIX}/conf/sip_profiles/internal.xml" || true

echo "===> Verifying Megafon gateway"
grep -E '(username|realm|proxy)' "${FS_PREFIX}/conf/sip_profiles/external/megafon.xml" | head -3

echo "===> Stopping any previously-running FS"
pkill -f "/usr/local/freeswitch/bin/freeswitch" || true
sleep 1

echo "===> Starting FreeSWITCH in background"
${FS_PREFIX}/bin/freeswitch -nc -ncwait

echo "===> Waiting for sofia profile to come up"
sleep 3

echo "===> Status of internal profile (should show WS-BIND-URL + REGED count)"
${FS_PREFIX}/bin/fs_cli -x "sofia status profile internal" 2>&1 | head -20

echo "===> Status of megafon gateway (should show 'state REGED')"
${FS_PREFIX}/bin/fs_cli -x "sofia status gateway megafon" 2>&1 | head -10

echo "FS_SETUP_OK"
