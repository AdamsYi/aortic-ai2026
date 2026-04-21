import os, sys
os.chdir("/Users/adams/Documents/New project/aortic ai2026/dist")
import http.server, socketserver
PORT = 8787
Handler = http.server.SimpleHTTPRequestHandler
with socketserver.TCPServer(("", PORT), Handler) as httpd:
    httpd.serve_forever()
