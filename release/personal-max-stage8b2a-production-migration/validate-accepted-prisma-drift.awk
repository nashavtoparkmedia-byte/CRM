BEGIN {
  in_block_comment = 0
  normalized = ""
}

{
  line = $0
  sub(/\r$/, "", line)
  while (length(line) > 0) {
    if (in_block_comment) {
      block_end = index(line, "*/")
      if (block_end == 0) {
        line = ""
      } else {
        line = substr(line, block_end + 2)
        in_block_comment = 0
      }
    } else {
      block_start = index(line, "/*")
      line_comment = index(line, "--")
      if (line_comment > 0 && (block_start == 0 || line_comment < block_start)) {
        line = substr(line, 1, line_comment - 1)
        block_start = 0
      }
      if (block_start > 0) {
        normalized = normalized " " substr(line, 1, block_start - 1)
        line = substr(line, block_start + 2)
        in_block_comment = 1
      } else {
        normalized = normalized " " line
        line = ""
      }
    }
  }
}

END {
  if (in_block_comment) {
    exit 3
  }
  gsub(/[[:space:]]+/, " ", normalized)
  sub(/^ /, "", normalized)
  sub(/ $/, "", normalized)
  gsub(/"public"\./, "", normalized)
  gsub(/[[:space:]]*,[[:space:]]*/, ",", normalized)

  combined_a = "ALTER TABLE \"DriverTelegram\" DROP COLUMN \"submittedPhone\",DROP COLUMN \"submittedPhoneAt\";"
  combined_b = "ALTER TABLE \"DriverTelegram\" DROP COLUMN \"submittedPhoneAt\",DROP COLUMN \"submittedPhone\";"
  split_a = "ALTER TABLE \"DriverTelegram\" DROP COLUMN \"submittedPhone\"; ALTER TABLE \"DriverTelegram\" DROP COLUMN \"submittedPhoneAt\";"
  split_b = "ALTER TABLE \"DriverTelegram\" DROP COLUMN \"submittedPhoneAt\"; ALTER TABLE \"DriverTelegram\" DROP COLUMN \"submittedPhone\";"

  if (normalized == combined_a || normalized == combined_b || normalized == split_a || normalized == split_b) {
    print "ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS"
    exit 0
  }
  exit 2
}
