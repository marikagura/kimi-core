#!/usr/bin/env bash
# Identity allow-gate. Fails if any author/committer email is NOT on the allowlist
# (scripts/allowed-identities.txt). The allowlist names ONLY public identities, so
# this script and the list contain NO private data — safe to commit and run in CI.
#
# This is the layer the content scrubber misses: the original leak was the *committer*
# identity (a machine's hostname-derived name+email), never visible to a content grep.
#
# Modes:
#   --commit         check the identity THIS commit will use (pre-commit)
#   --range <range>  check every commit in <range>           (pre-push)
#   --all            check every commit reachable from all refs (CI / audit)
# bash 3.2 compatible (macOS default).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
ALLOW="scripts/allowed-identities.txt"

[ -f "$ALLOW" ] || { echo "✗ missing $ALLOW"; exit 1; }
pat=$(grep -vE '^[[:space:]]*(#|$)' "$ALLOW" | paste -sd'|' -)
[ -z "$pat" ] && { echo "✗ allowlist empty"; exit 1; }

mode="${1:---all}"; arg="${2:-}"
fail=0
flag() { echo "  ✗ disallowed identity: <$1>${2:+  ($2)}"; fail=1; }
ok_email() { echo "$1" | grep -qE "^($pat)$"; }

case "$mode" in
  --commit)
    ae=$(git var GIT_AUTHOR_IDENT    | sed -E 's/.*<([^>]+)>.*/\1/')
    ce=$(git var GIT_COMMITTER_IDENT | sed -E 's/.*<([^>]+)>.*/\1/')
    ok_email "$ae" || flag "$ae" "author"
    ok_email "$ce" || flag "$ce" "committer"
    ;;
  --range|--all)
    if [ "$mode" = "--all" ]; then src=$(git log --all --format='%ae%n%ce' | sort -u)
    else                          src=$(git log "$arg" --format='%ae%n%ce' | sort -u); fi
    while IFS= read -r e; do
      [ -z "$e" ] && continue
      ok_email "$e" || flag "$e"
    done <<EOF
$src
EOF
    ;;
  *) echo "usage: check-identity.sh [--commit|--range <range>|--all]"; exit 2 ;;
esac

if [ "$fail" -ne 0 ]; then
  echo "✗ IDENTITY GATE FAILED — author/committer must be a public identity."
  echo "  fix:  git config user.name '…'  &&  git config user.email '…'  (allowed list in $ALLOW)"
  echo "  to relabel existing commits, rewrite with git-filter-repo --mailmap before pushing."
  exit 1
fi
echo "✓ identity gate passed ($mode)"
