#!/bin/zsh
# Автозапуск роутера при входе в систему (launchd). Запускать один раз: ./launchd/install.sh
# Убрать: launchctl unload ~/Library/LaunchAgents/com.tele_claude.router.plist && rm ~/Library/LaunchAgents/com.tele_claude.router.plist
ROOT="${0:A:h:h}"
BUN="$(command -v bun)" || { echo "Нужен bun: brew install oven-sh/bun/bun" >&2; exit 1; }
PLIST="$HOME/Library/LaunchAgents/com.tele_claude.router.plist"
mkdir -p "$HOME/.tele_claude" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.tele_claude.router</string>
  <key>ProgramArguments</key><array><string>$BUN</string><string>$ROOT/router/router.ts</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$HOME/.tele_claude/router.log</string>
  <key>StandardOutPath</key><string>$HOME/.tele_claude/router.log</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null; launchctl load "$PLIST" && echo "Роутер будет запускаться автоматически. Лог: ~/.tele_claude/router.log"
