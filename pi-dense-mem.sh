#!/usr/bin/env bash
# Launch pi with Dense-Mem credentials loaded from .env files.
#
# Sources, in order, then launches pi with the merged environment:
#   1. ~/.pi/agent/.env   — global keyring (one var per team credential)
#   2. ./.env             — repo/cwd overrides
# Later files win (plain source semantics). Values are KEY=VALUE (no export
# keyword needed); CRLF line endings are tolerated. Set PI_BIN to override the
# pi executable (e.g. PI_BIN="npx pi").
#
# Usage: ./pi-dense-mem.sh            # or alias pi='./pi-dense-mem.sh'
set -a
for f in "$HOME/.pi/agent/.env" ./.env; do
  if [ -f "$f" ]; then
    # tr strips CRLF so Windows-edited .env files don't leak \r into tokens
    . <(tr -d '\r' < "$f")
  fi
done
set +a
exec "${PI_BIN:-pi}" "$@"
