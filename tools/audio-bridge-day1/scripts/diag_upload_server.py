#!/usr/bin/env python3
"""Tiny CORS-enabled receiver for browser-captured WAV uploads.

Listens on :3033 for POST requests, writes the body to /dev/shm/test-23/uploads/<X-Filename>.

Used by the in-browser PCM-capture snippet to upload its raw audio
recording without going through Chrome's download dialog (which blocks
repeated programmatic downloads). Pair with `webrtc_capture_auto.js`'s
fetch() POST path.
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import os
import sys

UPLOAD_DIR = '/dev/shm/test-23/uploads'
os.makedirs(UPLOAD_DIR, exist_ok=True)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Expose-Headers', '*')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        data = self.rfile.read(n)
        fname = self.headers.get('X-Filename', f'upload-{int(__import__("time").time())}.bin')
        # Sanitise filename
        fname = os.path.basename(fname).replace(' ', '_')
        path = os.path.join(UPLOAD_DIR, fname)
        with open(path, 'wb') as f:
            f.write(data)
        body = f'OK {len(data)} bytes -> {path}\n'.encode()
        self.send_response(200)
        self._cors()
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        sys.stderr.write(f'[upload] {fname} ({len(data)} bytes)\n')
        sys.stderr.flush()

    def log_message(self, *args, **kwargs):
        pass  # quiet


if __name__ == '__main__':
    port = int(os.environ.get('UPLOAD_PORT', 3033))
    HTTPServer(('0.0.0.0', port), Handler).serve_forever()
