#!/bin/bash
# Bootstrap canvas-to-notion on a fresh Mac (homebase).
# Usage: ./deploy/bootstrap.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "Installing dependencies…"
  npm install --no-fund --no-audit
fi

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "⚠️  Fill in .env (CANVAS_DOMAIN, NOTION_TOKEN, NOTION_HQ_PAGE_ID, CANVAS_TOKEN) then re-run."
  exit 0
fi

PLIST=~/Library/LaunchAgents/com.lukebrevoort.canvas-notion.plist
cat > "$PLIST" <<EOL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.lukebrevoort.canvas-notion</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>$(pwd)/node_modules/.bin/tsx</string>
        <string>$(pwd)/src/cli.ts</string>
        <string>sync</string>
    </array>
    <key>WorkingDirectory</key><string>$(pwd)</string>
    <key>StartInterval</key><integer>$(( $(grep SYNC_INTERVAL_MINUTES .env | cut -d= -f2 | tr -d '[:space:]') * 60 ))</integer>
    <key>RunAtLoad</key><true/>
    <key>StandardErrorPath</key><string>$(pwd)/data/error.log</string>
    <key>StandardOutPath</key><string>$(pwd)/data/output.log</string>
</dict>
</plist>
EOL

mkdir -p data
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✅ Loaded launchd job: $PLIST (runs every SYNC_INTERVAL_MINUTES)"
echo "Check: launchctl list | grep canvas-notion"
