#!/usr/bin/env bash
# De-identification content gate. Non-zero exit = private residue in tracked files.
# Mechanical backstop ONLY — static checks miss rewritten/semantic residue. Pair with review.
#
# Design rule: this file contains NO literal private words. Real names / usernames /
# private domains / nicknames live in .scrub-secrets.local (gitignored, never committed),
# so the scanner can never itself become the leak. Allowed-but-matching paths
# (e.g. a denylist file that must contain the words) go in scripts/scrub-allow.txt.
#
# bash 3.2 compatible (macOS). Scans git-tracked files — the public boundary IS what's tracked.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# files/paths legitimately allowed to contain otherwise-private tokens (regex, one per line)
EXCLUDE='\$\{|process\.env|\.example|EXAMPLE|placeholder|scrub-scan|check-identity|allowed-identities|scrub-allow|\.scrub-secrets|localhost'
if [ -f scripts/scrub-allow.txt ]; then
  extra=$(grep -vE '^[[:space:]]*(#|$)' scripts/scrub-allow.txt | paste -sd'|' -)
  [ -n "$extra" ] && EXCLUDE="$EXCLUDE|$extra"
fi

fail=0
scan() { # $1=label  $2=regex
  local hits
  hits=$(git grep -nIE "$2" -- . 2>/dev/null | grep -vE "$EXCLUDE")
  if [ -n "$hits" ]; then echo "✗ [$1]"; echo "$hits"; fail=1; else echo "✓ [$1]"; fi
}

echo "── shape layer (no literal private words) ───────────────────"
scan "local-path" "/Users/[A-Za-z]"
scan "credential" "sk-[A-Za-z0-9]{20,}|GOCSPX-[A-Za-z0-9]{10,}|-----BEGIN [A-Z]+ PRIVATE KEY|postgres(ql)?://[^@\"' ]+:[^@\"' ]+@"
scan "bearer-lit" "Bearer [A-Za-z0-9._-]{12,}"

if [ -f .scrub-secrets.local ]; then
  echo "── private-word layer (.scrub-secrets.local, local only) ────"
  while IFS= read -r w; do
    [ -z "$w" ] && continue
    case "$w" in \#*) continue ;; esac
    scan "priv" "$w"
  done < .scrub-secrets.local
else
  echo "⚠ no .scrub-secrets.local — shape layer only (expected in CI)."
fi

echo "─────────────────────────────────────────────────────────────"
if [ "$fail" -ne 0 ]; then echo "✗ SCRUB FAILED — private residue present. Do not push."; exit 1; fi
echo "✓ SCRUB PASSED"
