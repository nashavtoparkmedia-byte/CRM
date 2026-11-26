#!/bin/sh
set -eu

source_dir=/etc/nginx/templates/auth
target_dir=/run/nginx-auth

for name in yoko-crm-staff.htpasswd compensation.htpasswd; do
    if [ ! -f "$source_dir/$name" ]; then
        echo "Required Nginx auth file is absent: $name" >&2
        exit 1
    fi
done

install -d -o nginx -g nginx -m 0700 "$target_dir"
for name in yoko-crm-staff.htpasswd compensation.htpasswd; do
    install -o nginx -g nginx -m 0400 "$source_dir/$name" "$target_dir/$name"
done
