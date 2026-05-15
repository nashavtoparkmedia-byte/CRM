#!/bin/bash
LOG=/usr/local/freeswitch/log/freeswitch.log
LAST_LINE=$(grep -n 'INVITE sip:79' "$LOG" | tail -1 | cut -d: -f1)
echo "Last INVITE found at line: $LAST_LINE"
echo "---FULL TRACE OF LAST CALL---"
sed -n "${LAST_LINE},+200p" "$LOG" | grep -E 'Executing|destination_number|sofia/gateway|cause:|Cannot|bridge|record|Trying|Ringing|HANGUP|INVALID|Originate|effective_caller' | head -60
