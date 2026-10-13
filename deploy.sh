#!/bin/bash
# The whole release. Safe to run any time.
#   ./deploy.sh            create what is missing, migrate, deploy, attach the hostname
#   ./deploy.sh --dry-run  build only, upload nothing
#
# House auth pattern: fleet token from keys.json beats wrangler's expiring OAuth.
#
# The two LINE secrets are NOT here and never in the repo: the channel token can
# send messages as the account. Put them in keys.json under "line", or set them
# by hand once with `npx wrangler secret put LINE_CHANNEL_TOKEN`.
set -euo pipefail
cd "$(dirname "$0")"

WORKER=motdang-line
DB=motdang-line
BUCKET=motdang-line-inbox
HOST=line.motdang.net
ACCOUNT=fe332688b1b25b543f8429d7f08292a3
KEYS="$HOME/.config/nanobotco/keys.json"
PULL_FILE="$HOME/.motdang-line-pull-token"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  CLOUDFLARE_API_TOKEN=$(python3 -c "import json,pathlib;print(json.load(open('$KEYS'))['cloudflare']['api_token'])" 2>/dev/null || true)
  [ -n "$CLOUDFLARE_API_TOKEN" ] && export CLOUDFLARE_API_TOKEN && echo "→ using the nanobotco-fleet API token"
fi

if [ "${1:-}" = "--dry-run" ]; then
  npx wrangler deploy --dry-run --outdir /tmp/motdang-line-build >/dev/null && echo "✓ builds clean (nothing uploaded)"
  exit 0
fi

if grep -q REPLACED_BY_DEPLOY_SH wrangler.jsonc; then
  echo "→ first run: looking for D1 database $DB"
  ID=$(npx wrangler d1 list --json 2>/dev/null | python3 -c "import json,sys;r=[d for d in json.load(sys.stdin) if d['name']=='$DB'];print(r[0]['uuid'] if r else '')")
  if [ -z "$ID" ]; then
    echo "→ creating D1 database $DB"
    ID=$(npx wrangler d1 create "$DB" 2>/dev/null | python3 -c "import re,sys;print(re.search(r'[0-9a-f]{8}-[0-9a-f-]{27}',sys.stdin.read()).group(0))")
  fi
  echo "→ D1 id $ID written into wrangler.jsonc"
  sed -i '' "s/REPLACED_BY_DEPLOY_SH/$ID/" wrangler.jsonc
fi

if ! npx wrangler r2 bucket list 2>/dev/null | grep -q "^name: *$BUCKET$"; then
  echo "→ creating R2 bucket $BUCKET"; npx wrangler r2 bucket create "$BUCKET" >/dev/null
fi

echo "→ applying migrations"
npx wrangler d1 migrations apply "$DB" --remote
echo "→ deploying"
npx wrangler deploy

# The desk token is ours, not LINE's: it is what the local filer proves itself
# with. Made here on first run so there is one fewer thing to invent by hand.
if [ ! -f "$PULL_FILE" ]; then
  python3 -c "import secrets;print(secrets.token_urlsafe(32))" > "$PULL_FILE"
  chmod 600 "$PULL_FILE"
  echo "→ desk token made: $PULL_FILE"
fi
printf "%s" "$(cat "$PULL_FILE")" | npx wrangler secret put PULL_TOKEN >/dev/null 2>&1 && echo "  → PULL_TOKEN set"

# LINE's two, if keys.json has them. Absent is not an error: the Worker deploys
# and answers /health, and simply refuses every webhook until they are set.
for pair in "channel_secret:LINE_CHANNEL_SECRET" "channel_token:LINE_CHANNEL_TOKEN"; do
  slot=${pair%%:*}; name=${pair##*:}
  val=$(python3 -c "import json;print((json.load(open('$KEYS')).get('line') or {}).get('$slot') or '')" 2>/dev/null || true)
  if [ -n "$val" ]; then
    printf "%s" "$val" | npx wrangler secret put "$name" >/dev/null 2>&1 && echo "  → $name set"
  else
    echo "  · $name not in keys.json — set it with: npx wrangler secret put $name"
  fi
done

# The calendar the morning agenda reads: Google's SECRET iCal address for
# "Appointments — Nan & Michael". Read-only, and revocable without touching this
# Worker — Calendar settings, Integrate calendar, Reset, which invalidates the
# old address. Absent is not an error: the agenda simply finds no feed and says
# nothing, which /desk/agenda will tell you.
#
# ⛔ ONE CALENDAR. The court dates are on a different one and they are case
# content; catalog's rules forbid case content to any external service and LINE
# is one. Pointing this at a second calendar is that decision, not a config
# change.
ics=$(python3 -c "import json;print((json.load(open('$KEYS')).get('calendar') or {}).get('appointments_ics') or '')" 2>/dev/null || true)
if [ -n "$ics" ]; then
  printf "%s" "$ics" | npx wrangler secret put CALENDAR_ICS >/dev/null 2>&1 && echo "  → CALENDAR_ICS set"
else
  echo "  · CALENDAR_ICS not in keys.json — the morning agenda will stay quiet"
fi

# The relay secret mot-dang-claims checks on rain and flood answers forwarded
# from LINE (x-md-relay). The same value both Workers hold, kept in keys.json
# under motdang_relay.key. Absent is not an error: the answers still go, and
# mot-dang-claims counts them by caller address as before.
relay=$(python3 -c "import json;print((json.load(open('$KEYS')).get('motdang_relay') or {}).get('key') or '')" 2>/dev/null || true)
if [ -n "$relay" ]; then
  printf "%s" "$relay" | npx wrangler secret put RELAY_SECRET >/dev/null 2>&1 && echo "  → RELAY_SECRET set"
else
  echo "  · motdang_relay.key not in keys.json — rain and flood go without the relay headers"
fi

# The hostname, through the account-level Workers Domains API: the fleet token
# cannot touch zone Workers Routes, which is the path wrangler's custom_domain
# setting takes. Cloudflare creates the DNS record. Re-PUT is a no-op.
zid=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/zones?name=motdang.net" \
  | python3 -c "import json,sys;r=json.load(sys.stdin)['result'];print(r[0]['id'] if r else '')")
if [ -n "$zid" ]; then
  ok=$(curl -s -X PUT -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/domains" \
    -d "{\"zone_id\":\"$zid\",\"hostname\":\"$HOST\",\"service\":\"$WORKER\",\"environment\":\"production\"}" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print('ok' if d['success'] else d['errors'])")
  echo "  → $HOST: $ok"
else
  echo "  ✗ zone motdang.net not in this account"
fi

echo
echo "webhook URL for the LINE console:  https://$HOST/line/webhook"
