#!/usr/bin/env bash
cd "$(dirname "$0")"
echo
echo "  ============================================"
echo "    NEXUS Agent - starting up"
echo "  ============================================"
echo
command -v node >/dev/null 2>&1 || { echo "  [X] Node.js not installed → https://nodejs.org"; exit 1; }
[ -d node_modules ] || { echo "  Installing dependencies..."; npm install || exit 1; }
if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "  Created .env — add your API key to it:"
  echo "    $(pwd)/.env"
  echo
  echo "  Set XKIRO_API_KEY=sk-... then run this script again."
  exit 1
fi
echo "  Starting NEXUS... open http://localhost:3000"
echo
npm start
