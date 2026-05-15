#!/bin/bash
LOG=/usr/local/freeswitch/log/freeswitch.log
echo "=== Latest INVITE sip:101@ blocks (FS → browser) ==="
grep -n 'INVITE sip:101@' "$LOG" | tail -3 | while read line; do
  LINENUM=$(echo "$line" | cut -d: -f1)
  echo ""
  echo "--- INVITE to 101 @ line $LINENUM ---"
  sed -n "${LINENUM},+40p" "$LOG" | head -40
done
