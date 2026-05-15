#!/bin/bash
LOG=/usr/local/freeswitch/log/freeswitch.log
# Find first INVITE from browser → 101 → 79222155750 in the last 500 lines
BROWSER_INVITE_LINE=$(grep -n 'INVITE sip:79222155750@crm.local' "$LOG" | tail -1 | cut -d: -f1)
if [ -z "$BROWSER_INVITE_LINE" ]; then
  echo "No browser INVITE found in full log"
  exit 0
fi
echo "Browser INVITE at absolute line: $BROWSER_INVITE_LINE"
echo "--- FULL FLOW ---"
sed -n "${BROWSER_INVITE_LINE},+500p" "$LOG" | grep -E 'INVITE |Executing|Regex \(PASS\)|sofia/gateway|sofia/external|Originate|Bridg|Cannot create|cause:|SIP/2.0|early.*media|read codec|write codec|hanging up|state \[|peer_uuid|m=audio|a=fingerprint' | head -80
