#!/bin/bash
# Serves Ledger from http://localhost so Chrome treats it as a normal website
# (separate storage from the file:// copy — use Settings › Data › Restore to move data across once).
cd "$(dirname "$0")"
PORT=8765
if ! lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  nohup python3 -m http.server $PORT --bind 127.0.0.1 >/dev/null 2>&1 &
  sleep 1
fi
open "http://localhost:$PORT/finance-dashboard.html"
