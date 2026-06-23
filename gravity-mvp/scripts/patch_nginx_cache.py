#!/usr/bin/env python3
path = '/opt/crm/deploy/nginx/conf.d/crm.conf'
with open(path) as f:
    content = f.read()

TARGET = '    location /wss-sip {'
OVERRIDE = '''    # Cache override: SipContext chunk patched — force browser re-fetch
    location = /_next/static/chunks/ff49e525f0a75540.js {
        proxy_pass http://gravity_mvp_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
    }

    location /wss-sip {'''

if TARGET not in content:
    print('ERROR: target location not found')
    exit(1)

if 'ff49e525f0a75540' in content:
    print('Already patched — skipping')
    exit(0)

content = content.replace(TARGET, OVERRIDE, 1)
with open(path, 'w') as f:
    f.write(content)
print('OK: nginx cache override added')
