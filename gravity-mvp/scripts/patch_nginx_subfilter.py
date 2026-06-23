#!/usr/bin/env python3
"""
Adds sub_filter to nginx location / so HTML responses get ff49e525f0a75540.js
replaced with ff49e525f0a75540v2.js (new URL bypasses Chrome immutable cache).
Also adds a location for the v2 chunk served with no-cache headers.
"""
import sys

path = '/opt/crm/deploy/nginx/conf.d/crm.conf'
with open(path) as f:
    content = f.read()

if 'ff49e525f0a75540v2' in content:
    print('Already patched — skipping')
    sys.exit(0)

OLD_LOC_BLOCK = '''    location / {
        proxy_pass http://gravity_mvp_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }'''

# Keep original immutable-cache block, add v2 location before it
# Then patch location / to add sub_filter
OLD_CACHE_BLOCK = '''    # Cache override: SipContext chunk patched — force browser re-fetch
    location = /_next/static/chunks/ff49e525f0a75540.js {
        proxy_pass http://gravity_mvp_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
    }'''

NEW_CACHE_BLOCK = '''    # SipContext v2 chunk — new filename bypasses Chrome immutable disk cache
    location = /_next/static/chunks/ff49e525f0a75540v2.js {
        proxy_pass http://gravity_mvp_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
    }

    # Cache override: SipContext chunk patched — force browser re-fetch
    location = /_next/static/chunks/ff49e525f0a75540.js {
        proxy_pass http://gravity_mvp_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
    }'''

NEW_LOC_BLOCK = '''    location / {
        # sub_filter rewrites HTML: old chunk → v2 URL (bypasses Chrome immutable cache)
        proxy_set_header Accept-Encoding "";
        sub_filter "ff49e525f0a75540.js" "ff49e525f0a75540v2.js";
        sub_filter_once off;
        proxy_pass http://gravity_mvp_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }'''

if OLD_CACHE_BLOCK not in content:
    print('ERROR: old cache block not found')
    sys.exit(1)

if OLD_LOC_BLOCK not in content:
    print('ERROR: location / block not found')
    sys.exit(1)

content = content.replace(OLD_CACHE_BLOCK, NEW_CACHE_BLOCK, 1)
content = content.replace(OLD_LOC_BLOCK, NEW_LOC_BLOCK, 1)

with open(path, 'w') as f:
    f.write(content)
print('OK: nginx sub_filter + v2 location added')
