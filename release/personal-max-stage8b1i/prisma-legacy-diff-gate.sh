#!/bin/sh
set -eu

diff_path=${1:?Prisma diff path required}
[ -f "$diff_path" ]
[ ! -L "$diff_path" ]
diff_bytes=$(wc -c <"$diff_path" | tr -d ' ')
case $diff_bytes in
  ''|*[!0-9]*) exit 64 ;;
esac
[ "$diff_bytes" -gt 0 ]
[ "$diff_bytes" -le 4096 ]

canonical=$(LC_ALL=C sed -E '/^[[:space:]]*--/d; /^[[:space:]]*$/d' "$diff_path" | \
  tr '\n\r\t' '   ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//')
expected='ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" TEXT, ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);'
[ "$canonical" = "$expected" ]
printf 'PRISMA_DIFF_STATUS=ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS\n'
