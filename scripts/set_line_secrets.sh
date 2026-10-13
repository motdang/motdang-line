#!/bin/bash
# Put the two LINE credentials into keys.json without them touching the screen,
# the shell history, or anything I can read.
#
#   ./scripts/set_line_secrets.sh
#
# Paste them in EITHER ORDER. The two are different shapes — a channel secret is
# 32 hex characters, an access token is a long base64 string — so the script can
# tell which is which, and nobody has to remember which console it came from.
set -euo pipefail
cd "$(dirname "$0")/.."
KEYS="$HOME/.config/nanobotco/keys.json"

echo
echo "Paste whichever you have on the clipboard first — order does not matter."
echo "Nothing shows as you type. Press return after each."
echo
read -rs -p "  1st value, then return: " A; echo
read -rs -p "  2nd value, then return: " B; echo
echo

A="$A" B="$B" KEYS="$KEYS" python3 - <<'PY'
import json, os, pathlib, re, shutil, sys

vals = [os.environ["A"].strip(), os.environ["B"].strip()]
if not all(vals):
    sys.exit("Both values are needed. Nothing written.")

# A channel secret is exactly 32 hex characters. An access token is far longer
# and is not hex. That is enough to sort them without ever printing either.
def kind(v):
    if re.fullmatch(r"[0-9a-fA-F]{32}", v):
        return "channel_secret"
    if len(v) > 60:
        return "channel_token"
    return None

kinds = [kind(v) for v in vals]
if sorted(k or "?" for k in kinds) != ["channel_secret", "channel_token"]:
    got = ", ".join(f"{len(v)} characters" for v in vals)
    sys.exit(
        f"Could not tell those apart ({got}). Nothing written.\n"
        "  A channel secret is 32 hex characters — OA Manager, Settings,\n"
        "    Messaging API, second row, the Copy button beside it.\n"
        "  An access token is a long string — Developers console,\n"
        "    Messaging API tab, the Issue button at the foot of the page.\n"
        "  If one of them came back short, it was probably a partial copy.")

line = {k: v for k, v in zip(kinds, vals)}
keys = pathlib.Path(os.environ["KEYS"])
data = json.loads(keys.read_text()) if keys.exists() else {}
if keys.exists():
    shutil.copy(keys, str(keys) + ".bak")
data["line"] = line
keys.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
keys.chmod(0o600)
print(f"  sorted them out and wrote both into {keys}")
print('  (the previous file is kept as keys.json.bak)')
PY

echo
read -rp "Deploy them to the Worker now? [y/N] " go
case "$go" in
  y|Y) ./deploy.sh ;;
  *) echo "Not deployed. Run ./deploy.sh when you are ready." ;;
esac
