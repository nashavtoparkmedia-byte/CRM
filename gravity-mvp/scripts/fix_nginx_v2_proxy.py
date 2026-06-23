#!/usr/bin/env python3
"""
Fix v2 chunk location: proxy_pass should request the ORIGINAL v1 filename from Next.js
(Next.js only serves files it knows about from its build manifest).
"""
import sys

path = '/opt/crm/deploy/nginx/conf.d/crm.conf'
with open(path) as f:
    content = f.read()

OLD = '''    # SipContext v2 chunk — new filename bypasses Chrome immutable disk cache
    location = /_next/static/chunks/ff49e525f0a75540v2.js {
        proxy_pass http://gravity_mvp_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
    }'''

NEW = '''    # SipContext v2 chunk — new filename bypasses Chrome immutable disk cache
    # proxy_pass rewrites URI back to v1 so Next.js (which only knows v1) serves it
    location = /_next/static/chunks/ff49e525f0a75540v2.js {
        proxy_pass http://gravity_mvp_upstream/_next/static/chunks/ff49e525f0a75540.js;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
    }'''

if OLD not in content:
    print('ERROR: old v2 block not found')
    sys.exit(1)

content = content.replace(OLD, NEW, 1)
with open(path, 'w') as f:
    f.write(content)
print('OK: v2 location now proxies to v1 filename')
