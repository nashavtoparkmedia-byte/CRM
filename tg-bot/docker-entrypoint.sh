#!/bin/sh
set -eu

# A Docker volume hides the ownership prepared in the image. Repair the
# persistent SQLite directory on every start, then run the application with
# the same unprivileged account as before.
mkdir -p /app/data
chown -R app:app /app/data

exec gosu app "$@"
