#!/bin/bash
LOG=/usr/local/freeswitch/log/freeswitch.log
# Find ALL FS->Megafon INVITEs (going to 193.201.229.35) with their following headers
echo '===== ALL FS→MEGAFON INVITEs (with From / Contact / SDP m=) ====='
grep -n 'send .* bytes to udp/\[193.201.229.35\]:5060' "$LOG" | tail -8 | while read line; do
  LINENUM=$(echo "$line" | cut -d: -f1)
  echo ''
  echo "--- send block starting at line $LINENUM ---"
  sed -n "${LINENUM},+30p" "$LOG" | grep -E '^INVITE |^From:|^To:|^Contact:|^User-Agent:|^m=audio|^c=IN|Proxy-Authorization' | head -8
done
