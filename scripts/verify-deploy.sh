#!/usr/bin/env bash
#
# Is the machine that just deployed actually serving this commit, and can it
# hold a match?
#
#     ./scripts/verify-deploy.sh [base-url] [expected-build]
#     ./scripts/verify-deploy.sh https://gladiator.fly.dev "$(git rev-parse --short HEAD)"
#
# `flyctl deploy` exiting 0 says a machine started. It does not say the machine
# is serving *this* build, that it can hold a tick rate, or that a deploy will
# not end every match on it — and those are the three ways this deploy is known
# to be able to go wrong. `/healthz` answers all three, so they are read rather
# than hoped for. `NOTES.md` says what to do about each.
#
# Exit codes: 0 all good, 1 the machine is not fit to serve. Warnings — jitter
# over budget, no resume secret — are printed and do not fail: neither is fixed
# by rolling back, and a red deploy nobody can act on is a red deploy people
# learn to ignore.
set -euo pipefail

BASE="${1:-https://gladiator.fly.dev}"
WANT="${2:-}"

health="$(curl -fsS --retry 5 --retry-delay 5 --retry-all-errors "${BASE}/healthz")"
echo "$health" | jq .

if ! jq -e '.ready == true' <<<"$health" > /dev/null; then
  echo "FAIL: up, but not accepting matches: $(jq -c .notReady <<<"$health")" >&2
  exit 1
fi

if [ -n "$WANT" ]; then
  got="$(jq -r .build <<<"$health")"
  if [ "$WANT" != "$got" ]; then
    echo "FAIL: serving build ${got}, expected ${WANT} — the deploy did not land" >&2
    exit 1
  fi
fi

# A warning rather than a failure, deliberately: a machine running late is still
# the machine holding these matches, and rolling back does not make it faster.
# The fix is a machine class. NOTES.md §3.
jq -e '.scheduler.withinBudget == true' <<<"$health" > /dev/null \
  || echo "WARNING: wakeup lateness p99 is over budget: $(jq -c .scheduler <<<"$health") — see NOTES.md §3" >&2

jq -e '.canResume == true' <<<"$health" > /dev/null \
  || echo 'WARNING: no RESUME_SECRET on this machine, so the next deploy ends every live match: flyctl secrets set RESUME_SECRET="$(openssl rand -hex 32)"' >&2

echo "OK: ${BASE} is serving $(jq -r .build <<<"$health") and accepting matches"
