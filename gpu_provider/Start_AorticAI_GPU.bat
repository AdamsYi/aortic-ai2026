START "AorticAI Tunnel" /MIN cmd /k "set HTTPS_PROXY=http://127.0.0.1:7890 && cloudflared tunnel run --protocol http2"
