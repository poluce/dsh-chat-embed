#!/bin/sh
# shell-patch - turn "logins survive a restart" on or off.
#
# Double-click this file in Finder (macOS runs it through Terminal). It finds a
# Node binary, runs the menu, and waits for a keypress so the result can be
# read.
#
# Usage:  shell-patch.command [status|apply|revert] [--resources <dir>]
#
# Nothing here edits files by itself: shell-patch.mjs does the work and verifies
# it. This launcher only locates Node and raises the script through admin rights
# when the app bundle refuses a write.

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/shell-patch.mjs"

if [ ! -f "$SCRIPT" ]; then
  printf '\n  [x] shell-patch.mjs not found next to this file.\n'
  printf '      Expected: %s\n\n' "$SCRIPT"
  printf '  Press enter to close.'
  read -r _
  exit 1
fi

# --- 1. Node bundled with DSH -------------------------------------------------
NODE=""
DSH_ROOT="${DSH_HOME:-$HOME/.dsh}"
for candidate in "$DSH_ROOT"/dsh-runtimes/*/dependencies/node/bin/node; do
  if [ -x "$candidate" ]; then
    NODE="$candidate"
    break
  fi
done

# --- 2. Node on PATH ----------------------------------------------------------
if [ -z "$NODE" ]; then
  NODE=$(command -v node 2>/dev/null || true)
fi

# --- 3. The usual install locations -------------------------------------------
if [ -z "$NODE" ]; then
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      NODE="$candidate"
      break
    fi
  done
fi

if [ -z "$NODE" ]; then
  printf '\n  [x] No Node binary found.\n'
  printf '      DSH normally ships one under %s/dsh-runtimes.\n' "$DSH_ROOT"
  printf '      Either start DSH once, or install Node and try again.\n\n'
  printf '  Press enter to close.'
  read -r _
  exit 1
fi

"$NODE" "$SCRIPT" "$@"
CODE=$?

printf '\n'
if [ "$CODE" -ne 0 ]; then
  printf '  [exit %s]\n\n' "$CODE"
fi
printf '  Press enter to close.'
read -r _
exit "$CODE"
