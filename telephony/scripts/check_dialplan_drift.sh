#!/usr/bin/env bash
# Verify the repository's FreeSWITCH dialplan stays in sync with what's
# actually deployed on the production FS host.
#
# Why this exists
# ───────────────
# Both `tools/fs-config/` and `telephony/conf/dialplan/default/` ship
# copies of the same XML — they target two different delivery paths:
#
#   • tools/fs-config/                  → manually copied into
#                                         /usr/local/freeswitch/conf/...
#                                         on the production host
#   • telephony/conf/dialplan/default/  → mounted into the docker-compose
#                                         dev stack at telephony/
#
# Previously the deployed dialplan drifted ahead of repo (added
# `record_session`, second `<condition>` filter for inbound, etc.) without
# any of those edits making it back into git. After a clean redeploy from
# repo the AI-call recording_file would silently stop being set and
# `Call.recordingPath` would go back to NULL — symptom of issue #35.
#
# Acceptance: this script exits 0 iff every dialplan XML in both repo
# locations is byte-identical to its deployed counterpart (after CRLF
# stripping — Windows clones get CRLF, FS reads LF). Exit 1 otherwise
# with a per-file diff line so the operator can fix.
#
# Run on the FS host (or anywhere WSL can read it):
#
#   bash telephony/scripts/check_dialplan_drift.sh
#
# Override the deployed path for staging hosts:
#
#   DEPLOYED_DIALPLAN_DIR=/etc/freeswitch/dialplan/default \
#     bash telephony/scripts/check_dialplan_drift.sh

set -u

# ── inputs ──────────────────────────────────────────────────────────────
DEPLOYED_DIR=${DEPLOYED_DIALPLAN_DIR:-/usr/local/freeswitch/conf/dialplan/default}
REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
FS_CONFIG_DIR="$REPO_ROOT/tools/fs-config"
TELEPHONY_DIR="$REPO_ROOT/telephony/conf/dialplan/default"

# Files we care about. If FS gains new dialplan XML in the deployed dir,
# add it here AND mirror it into both repo dirs.
FILES=(
    02_megafon_inbound.xml
    03_user_outbound.xml
    99_audio_fork_test.xml
)

# ── helpers ─────────────────────────────────────────────────────────────
strip_cr_then_hash() {
    # Normalize CRLF→LF before hashing so a Windows checkout doesn't
    # falsely flag drift.
    tr -d '\r' < "$1" | sha256sum | awk '{print $1}'
}

# Pretty status accumulators.
mismatches=0
report=""

check_one() {
    local file=$1
    local deployed="$DEPLOYED_DIR/$file"
    local fsconfig="$FS_CONFIG_DIR/$file"
    local telephony="$TELEPHONY_DIR/$file"

    if [ ! -f "$deployed" ]; then
        report+="  [skip] $file — not present on the FS host (deployed dir)"$'\n'
        return
    fi

    local d_hash
    d_hash=$(strip_cr_then_hash "$deployed")

    for path_label in "fs-config:$fsconfig" "telephony:$telephony"; do
        local label=${path_label%%:*}
        local path=${path_label#*:}
        if [ ! -f "$path" ]; then
            report+="  [MISSING] $file ← $label"$'\n'
            mismatches=$((mismatches + 1))
            continue
        fi
        local r_hash
        r_hash=$(strip_cr_then_hash "$path")
        if [ "$d_hash" = "$r_hash" ]; then
            report+="  [ok]      $file ← $label"$'\n'
        else
            report+="  [DRIFT]   $file ← $label"$'\n'
            mismatches=$((mismatches + 1))
        fi
    done
}

# ── run ─────────────────────────────────────────────────────────────────
echo "== Dialplan drift check =="
echo "  deployed:  $DEPLOYED_DIR"
echo "  fs-config: $FS_CONFIG_DIR"
echo "  telephony: $TELEPHONY_DIR"
echo

for f in "${FILES[@]}"; do
    check_one "$f"
done

echo "$report"

if [ "$mismatches" -eq 0 ]; then
    echo "✓ no drift — repo is in sync with deployed"
    exit 0
fi

echo "✗ $mismatches drifted/missing file(s)"
echo
echo "To inspect a specific file:"
echo "  diff <(tr -d '\\r' < $DEPLOYED_DIR/<file>) <(tr -d '\\r' < <repo-path>)"
echo
echo "To pull the deployed copy into the repo (review before committing!):"
echo "  cp $DEPLOYED_DIR/<file> $FS_CONFIG_DIR/<file>"
echo "  cp $DEPLOYED_DIR/<file> $TELEPHONY_DIR/<file>"
exit 1
