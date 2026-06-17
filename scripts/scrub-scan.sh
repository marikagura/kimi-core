#!/usr/bin/env bash
# kimi-core de-identification gate. Run before every push / before going public.
# Non-zero exit = private residue found -> do not push.
#
# Mechanical backstop ONLY. It cannot catch rewritten / semantic residue — static
# checks systematically miss (see ARCHITECTURE.md). Always pair with human review.
#
# Design rule: this file contains NO literal private words. Real names / usernames /
# private domains live in .scrub-secrets.local (gitignored, never committed) so this
# scanner can never itself become a leak source.
#
# bash 3.2 compatible (macOS default). Scans git-tracked files only — the public
# boundary IS what's tracked.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
scan() { # $1=label  $2=regex
  local hits
  hits=$(git grep -nIE "$2" -- . 2>/dev/null | grep -vE '\$\{|process\.env|\.example|EXAMPLE|placeholder|scrub-scan|localhost')
  if [ -n "$hits" ]; then
    echo "✗ [$1]"; echo "$hits"; fail=1
  else
    echo "✓ [$1]"
  fi
}

echo "── shape layer (in-repo, no literal private words) ──────────"
scan "local-path"  "/Users/[A-Za-z]"
scan "credential"  "sk-[A-Za-z0-9]{8}|GOCSPX-[A-Za-z0-9]|-----BEGIN [A-Z]+ PRIVATE KEY|postgres(ql)?://[^@\"' ]+:[^@\"' ]+@"
scan "bearer-lit"  "Bearer [A-Za-z0-9._-]{12,}"

# private-word layer — patterns live in .scrub-secrets.local (gitignored).
if [ -f .scrub-secrets.local ]; then
  echo "── private-word layer (.scrub-secrets.local) ───────────────"
  while IFS= read -r w; do
    [ -z "$w" ] && continue
    case "$w" in \#*) continue ;; esac
    scan "priv" "$w"
  done < .scrub-secrets.local
else
  echo "⚠ no .scrub-secrets.local — shape layer only."
  echo "  Add one (gitignored) with your real names / usernames / private domains."
fi

echo "─────────────────────────────────────────────────────────────"
if [ "$fail" -ne 0 ]; then
  echo "✗ SCRUB FAILED — private residue present. Do not push."
  exit 1
fi
echo "✓ SCRUB PASSED"
