#!/bin/sh
set -eu

[ "$#" = 2 ]
[ "$1" = '-cf' ]
[ "$2" = '/etc/sudoers.d/92-yoko-privileged-runtime' ]
