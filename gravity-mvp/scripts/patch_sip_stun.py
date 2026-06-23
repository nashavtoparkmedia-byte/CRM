#!/usr/bin/env python3
import sys

chunk = '/tmp/sip_chunk.js'

with open(chunk, 'rb') as f:
    data = f.read()

old = b'a.turn?.url&&(E.current={iceServers:[{urls:a.turn.url,username:a.turn.username,credential:a.turn.credential}],iceTransportPolicy:"relay"})'
new = b'a.turn?.url&&(()=>{let t=a.turn.url.replace(/^turns?:/,"").replace(/\\?.*$/,"");E.current={iceServers:[{urls:"stun:"+t}],iceTransportPolicy:"all"}})()'

if old not in data:
    print("ERROR: old string not found")
    sys.exit(1)

data = data.replace(old, new, 1)
with open(chunk, 'wb') as f:
    f.write(data)
print("OK: patched, new=" + str(len(new)) + " bytes")
