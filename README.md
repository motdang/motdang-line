# motdang-line — the bot in the team group

A LINE Official Account (`@964yxgnk`, the public Mot Dang one) sitting in the
team chat. Beer sends photos, they get filed against a place. Michael reports a
bug, it gets a number. Nobody has to remember to move a file afterwards.

```
LINE group ──webhook──▶ Worker (line.motdang.net) ──▶ R2 bytes + D1 ledger
                            │                                  │
                            └── replies, free reply token      │  hourly
                                                               ▼
                              mot-dang/_incoming/line/  ◀── importers/pull_line.py
                                                               │
                                                               ▼
                                          Drive "Mot Dang — photos from LINE"
```

## Four things about LINE that shape all of this

1. **No history.** A bot sees only what is sent after it joins. Nothing said in
   the group before the webhook went live is reachable, by this or any bot.
2. **Photo bytes expire.** The binary is fetched at webhook time or not at all.
   There is no backfill, which is why the R2 write happens inside `waitUntil`
   on the same request and never on a later sweep.
3. **Albums, Notes and Keep are invisible to the API.** Only what is sent into
   the chat arrives.
4. **Replies are free and unlimited; pushes are metered.** Everything
   conversational uses a reply token. The single push is the nightly summary,
   and it stays quiet on a day when nothing happened.

## The room is the input

Nan, 2026-09-07: *"everything that goes into the operations motdang channel …
should be stored, understood, cataloged, and used as motdang.net knowledge.
Whether it's about Beer's hours or pictures from someplace we visited today, if
it's in the channel it's because it's an action item for motdang."*

So every message comes down to the desk, not only the photos and the things
prefixed `bug`. Nothing in the plumbing can tell "ร้านนี้เปิด 7 โมงแล้ว" (a fact
about a record) from "beer works tue-sat this month" (a fact about a person),
and a regex that tried would be wrong in both directions — so the Worker carries
every line and the hourly desk, which can read, sorts them into place knowledge,
operations, and questions for a person. The desk writes candidates under
`_incoming/`; nothing it produces reaches `data/` without someone promoting it.

## What it does in the chat

| they send | it does |
|---|---|
| a photo | reads the sign off it (a vision model on `env.AI`, `SIGN_MODEL`) and says what it read — a reading to confirm, never a fact on its own |
| a photo, having named a place within five minutes, or quoting the message that did | files it, says which place. What they typed beats what the sign says |
| a photo with no name typed, but a name on the sign | matches on the sign's name and says so |
| a photo it cannot place | asks, offering up to three numbered guesses |
| a location from the paperclip | pins the photo the same person sent within ten minutes, or waits for the next one. Exact, and survives however the photo was sent |
| `bug` · `bug!` · `wrong` · `ผิด` on its own | a report about the last thing it did; takes that photo back off the place |
| `…bug…` inside a sentence | undoes nothing; asks once, in an aside, if it did something recently that might be meant |
| `1` / a name / a motdang.net link | settles the photo it asked about |
| `none` | leaves that photo for a person |
| `bug <anything>` | gives it a number, keeps it |
| `status` | what it is holding right now |
| `help` | the list above |

One-to-one messages from readers are ignored while `PAGES` is `off`: the
Official Account's own auto-replies answer those, and a Worker answering as
well would send every reader two answers. With `PAGES` on they build that
reader's page — see *Pages from LINE* below.

## Filing, and when it refuses to

`src/match.js` scores the text against the site's own name index — the same
names the search box matches, so a place the bot can name is a place a reader
can reach. It files only at 0.80 and clear of the runner-up. Three rules earn
their place against the live 25,582-record index:

- **A generated bearing is not a name.** 172 records read `Car park · 570 m from
  Tha Phae Gate`. Matching the tail files a photo of the gate under a car park,
  so only the part before the middle dot is a name.
- **A fragment offers, it never files.** "tha phae gate" reaches *Pun Space Tha
  Phae Gate* exactly as well as it reaches the gate.
- **A one-word name shared with the corpus is a label.** There is a record whose
  entire name is "Market". The corpus decides which words those are — any
  single-word name more than twenty records use is capped below filing.

## The other rooms

Nan, 2026-09-30: *"I want a private line group so I can send my own thoughts
to a silent bot, and another one where the team and I message the bots."*

| group name has | mode | what the bot does |
|---|---|---|
| `thoughts` or `ความคิด` | thoughts | keeps every message, photo, file, voice note and location; never says a word, addressed or not, `SPEAK` or no `SPEAK` |
| `bots` or `บอท` (a word of its own) | bots | one hello on joining; answers `@bot`/`@nanobotco`/a mention, `bot, …`, `บอท…`, and a line that is only `help`, `status` or `bug …` (the ticket number goes back); nothing to people talking to each other; photos filed silently; never pushes |
| anything else | muted | keeps nothing, says nothing — a stranger's group, as before |
| set with `scripts/group_mode.py <group> gbd`; no name gives it | gbd | the Golf Ball Drop ledger: answers `@nanobotco`/a mention/`bot, …` and a line that is only `status`; keeps ledger commands and their results in its own tables, nothing else from the room; no hello on joining; six dated posts |

Names to use: **`ความคิด · thoughts`** and **`บอท · bots`**. The mode is read
off the name the first time the account meets the group (the join, or the
first message if the join was missed) and kept in `group_modes`, so a rename
later changes nothing. `python3 scripts/group_mode.py` lists the rooms and
changes a mode. The ops room and the swim room keep their own handling and
cannot be given a mode.

Only people in the ops room count in the other two: a message from anyone
else there is neither kept nor answered, because the account is public and
anyone can name a group "bots". Every row carries `channel` (`ops`, `bots`,
`thoughts`); thoughts photos sit in R2 under `thoughts/`, and
`importers/pull_line.py` writes that room to `_incoming/line/thoughts/` only —
not the ops transcript, the bug list or the Drive queue.

`tests/silence.test.mjs` proves the ops room, unknown groups and the thoughts
room silent; `tests/rooms.test.mjs` proves what the two new rooms do.

## Michael's PM words

Nan, 2026-10-21: *"give him access to PM tools in our line channels"*, then
"Bot DM, Michael only". Michael chats one-to-one with the account; `src/pm.js`
answers the LINE ids in the secret `PM_USERS` and reads and acts on the Team
Wheel (pm.nanobotco.workers.dev) with his wheel key, `PM_KEY`. A Give here is
the wheel's Give and posts in Discord as "Michael · PM".

| he sends | it does |
|---|---|
| `today` | to check, to give out, quiet 4+ days, numbered; who holds how many |
| `report` | the wheel's status report, to forward |
| `who Beer` · `find cards` | a numbered list |
| `3` | ticket 3 of the last list: state, holder, goal, done means, Discord link |
| `give 3 Beer [note]` · `pass 3` · `fail 3 why` · `note 3 words` · `back 3 why` · `doing 3` | asks, posts on `yes` |
| `first 3` · `next 3` · `later 3` | his order on the wheel; posts nothing |
| `link` | his wheel page (secret `PM_LINK`) |

Replies only. The ops room and every other person's one-to-one chat are as
before (`tests/pm.test.mjs`). Secrets: `PM_USERS`, `PM_KEY`, `PM_LINK`;
`PM_URL` defaults to the wheel.

## The Golf Ball Drop room

The Chiang Mai International Rotary Club's Golf Ball Drop is Sat 30 Jan 2027: 300 numbered balls, 1,000 baht each last year, tickets handed to members 1 Nov – 10 Jan. The account sits in the club's group "Golf Ball Drop 2026-2027", set to `gbd` from the Mac. Club members are not Mot Dang staff, so this room has its own handling in `src/gbd.js`.

```
@nanobotco issue 1-20 to Beer     numbers handed to a member
@nanobotco sold 5 Somchai         sold by the holder; buyer optional; 1-3 or 5,7,9 work
@nanobotco paid 1-20 [baht]       money to the treasurer; total for the command, default price × balls
@nanobotco back 15-20             unsold numbers returned
@nanobotco who 17                 holder, sold and paid state
@nanobotco price 1000             baht a ball (default 1,000)
status                            counts, baht in, one line per member while there are twelve or fewer
```

A command answers when it is addressed (`@nanobotco`, a mention, `bot, …`); a line that is only `status` answers without an address. Numbers outside 1–300, a ball already issued, a ball not issued, a sold ball going back, a ball already paid: each gets a one-line reply naming the ball, and the command records nothing. `paid` on a ball not yet marked sold marks it sold too and says so. Replies use the reply token. Joining the group sends nothing.

Tables: `gbd_tickets` (one row per issued ball, with who recorded each step and when), `gbd_log` (each ledger command with its sender, time and answer), `gbd_posts`, price in `state`. A message, photo or file from the room is not written to `events` or R2, so `/desk/pull` and `/desk/photo` and the Drive filing do not carry it; `tests/gbd.test.mjs` runs a room full of chatter, photos and files and checks the pull returns only the ops line.

Dated posts, 09:00 Bangkok, through `pushGbd()` in `src/line.js` (its own variable, `GBD_POSTS`; `SPEAK` and `push()` are not involved): 25 Oct 2026 tickets go out 1 Nov · 1 Nov handout starts · 1 Dec volunteer roles to confirm · 10 Jan 2027 tickets and money back · 23 Jan one week to the drop · 16 Feb final accounting. Each carries the current counts. The `0 2 * * *` cron sends them; the hourly cron retries one that failed that day. A push to a group counts once per member against the monthly allowance. `GET /desk/gbd/posts?date=2027-01-23` shows what a day's post would say and sends nothing.

The ledger as TSV: `GET /desk/gbd/ledger` (desk token), or `python3 scripts/gbd_ledger.py`, which writes `~/Desktop/3 — Projects/CMIRC Ball Drop/GBD ledger.tsv`: 300 rows with state, holder, buyer, baht, and sender and time of each step.

## Running it

```
./deploy.sh                                    # create, migrate, deploy, attach the hostname
python3 scripts/build_match_index.py --push    # after a site build that changed names
node --test "tests/*.test.mjs"                 # 224 tests, no network, no deploy
```

`tests/harness.mjs` puts the Worker on real SQLite (`node:sqlite`) and a stubbed
LINE, so the whole event path runs locally: signature, D1 writes, R2 puts, and
what the bot actually says.

## The morning agenda

Once each morning at 07:00 Bangkok the bot posts what is on today, then says
nothing else all day.

```
Google Calendar ──secret .ics──▶ Worker (cron 0 0 * * *) ──▶ operations - motdang
  "Appointments — Nan & Michael"          src/agenda.js         (Nan, Beer, Michael)
```

**Why it exists.** 15–16 September 2026: Michael moved a 3:30 to 3:00 inside a
sentence addressed to Beer, the place moved from Algonquin to Bronco Kids in a
second message, Beer confirmed — and at 2:00 the next afternoon Nan still held
the old picture, an hour before it started. Three people, one room, no
close-out. The calendar was not missing. A calendar anyone read out loud was.

**The room is the right size for it.** `operations - motdang` has exactly three
members and they are the same three people the calendar is shared with, so the
message tells nobody anything they could not already open.

**What it will not say.**

| never in the room | why |
|---|---|
| `DESCRIPTION`, any of it | the 12 Aug entry carries two Google Meet links in its body; a meeting link in a group chat is a meeting anyone who scrolls can walk into |
| anything URL-shaped in a title or location | same, plus an unfurled card buries the action items under artwork (Nan, 2026-09-07) |
| the title of a private event | Beer's access to that calendar is *see private events as free/busy*; reading the title out would hand her what the setting withholds. It says `busy` |
| a time it worked out from a rule it cannot read | it names the event and says to check the calendar. A date without its arithmetic is not a date |

**One calendar, and this is not a setting.** `CALENDAR_ICS` points at
*Appointments — Nan & Michael* only. The court dates are on a different calendar
and they are **case content**; the catalog rules forbid case content to any
external service and LINE is one. Widening this is that decision, not a config
change.

**The mute still holds.** Nan muted this account on 2026-09-18 — *"I will say
@bot if I want to talk to it"* — and `push()` still refuses flatly under
`SPEAK: "off"`, nightly summary included. The agenda goes out through
`pushAgenda()` in `src/line.js`, a separate door with its own variable, because
she asked for this one thing on 2026-09-19. Set `AGENDA` to `off` and the
morning goes quiet without touching anything else. `tests/agenda.test.mjs`
holds that promise under every spelling of the flag.

**Recurring events.** `FREQ` daily/weekly/monthly/yearly, `INTERVAL`, `COUNT`,
`UNTIL`, `BYDAY` (with an ordinal when monthly — `2TU` is the second Tuesday),
`BYMONTHDAY`, `EXDATE`, and a `RECURRENCE-ID` instance that moves or cancels one
date. Anything else — `BYSETPOS`, `BYWEEKNO`, `BYYEARDAY` — is not guessed at.

**Checking it without waiting until morning, and without speaking:**

```
curl -H "Authorization: Bearer $(cat ~/.motdang-line-pull-token)" \
     https://line.motdang.net/desk/agenda
```

Builds the message from the live feed and sends it nowhere. `armed` is whether
`AGENDA` is on; `why` says `nothing on today` on a quiet day, which is the
common answer and not a fault.

**Two things measured on 2026-09-19, so nobody re-derives them.** The secret
.ics answers `cache-control: no-cache, no-store` — what comes back is what the
calendar says right now, and a booking made last night is in it. And the
standard `cache: "no-store"` fetch field throws in workerd: the endpoint
answered `1101` until it came out.

**Revoking the calendar** costs nothing here: Calendar settings → Integrate
calendar → Reset invalidates the address, and the bot goes quiet until
`deploy.sh` is run with a new one in `keys.json`.

## Pages from LINE

Nan, 2026-09-28: *"a better line integration to offer as a free subscription
(similar to yahoo personal sites) that's based entirely in a line app, changes
no user behavior"*. Who gets one: *"anyone"*.

Somebody adds @964yxgnk and chats with it one-to-one. What they send becomes a
page at `https://line.motdang.net/u/<slug>`, and the bot replies with the link.

| they send | it does |
|---|---|
| follow (adding the account) | makes the page, named from their LINE display name, and replies with the link |
| a photo, or a JPEG/PNG through the paperclip | checks it, strips its metadata, puts it on the page |
| text | checks it, puts it on the page, cut at 1,000 characters |
| a location | a pin on the page map, drawn to three decimals (about 100 m) |
| `name …` · `ชื่อ …` | renames the page |
| `ลบ` · `delete`, then again | deletes the page, its photos in R2, its rows and their last location |
| `help` · `ช่วย` | the link and this list |

**The check** is the home-help board's (homematch `screen.mjs`, `photos.mjs`),
ported into `src/screen.js` and `src/photo.js`. Words: rules first — markup,
links, hidden characters, adult, scam and prompt-steering words — then Llama
Guard, which can only hold. Photos: a vision model classifies and counts
heads; a person, a child, nudity, or an unreadable answer marks it refused and its
bytes are not written; text or a QR code holds it. Held and refused rows stay
in D1 with the reason in `why`; the sender gets the same "got it" either way,
except for a refused photo, which is told pages show places and things.

**What stays private.** A photo's EXIF location goes into `page_items.lat/lng`
and nowhere on the page; the served copy has no EXIF. The last shared location
sits in `dm_users` for the rain and flood buttons. Pages send `noindex`.

**Limits.** 30 things an hour, 200 a day and 1,000 in all per page; 6 MB a
photo; six rain/flood answers an hour per person. Counted from the rows, so
refused photos count too.

**The team room is untouched.** `worker.js` hands only `source.type === "user"`
to `src/pages.js`, and only with `PAGES` on. Nothing one-to-one lands in
`events`, so `/desk/pull` carries none of it. A one-to-one chat is addressed by
nature, so `src/pages.js` calls `allow()` for each reply it makes; the group mute
and the agenda door in `src/line.js` are as they were.
`tests/pages.test.mjs` runs the team room with pages on to show it.

**Rain and flood.** Two buttons on a rich menu drafted in `richmenu/` (JSON
plus `IMAGE-SPEC.txt`, not uploaded). The answer is forwarded to
`mot-dang-claims` `/rain` or `/flood` as `{answer, lat, lng}` with the last
location shared in the past 30 minutes, or the bot asks for one with a
quick-reply location button first. Each forward carries `x-md-relay` (the
`RELAY_SECRET`) and `x-md-user` (the first 16 hex of the sha256 of the LINE
user id), which mot-dang-claims reads to count each person on their own; the
LINE id itself is not sent. Its answers carry `via: "line"`.

**Moving it under motdang.net.** `motdang.net/*` is routed to the site Worker
(`mot-dang/publish/wrangler.toml`). A more specific route, `motdang.net/u/*` →
`motdang-line`, would take these pages without touching the rest; then set
`PAGE_BASE` to `https://motdang.net/u/` and the bot hands out the new address.
Old `line.motdang.net/u/…` links keep working.

**Turning it on** is `"PAGES": "on"` in `wrangler.jsonc` and `./deploy.sh`,
which also applies the migrations. Before that, OA Manager → Response
settings decides whether the account's own auto-reply and greeting still
answer one-to-one chats; left on, a reader gets both.

## The LINE door

Nan, 2026-09-28, to a list of reasons to add Mot Dang on LINE: *"let's do all
of those, and also mae hong son passport"*. Sign-up is a message the reader
sends: the website opens `line.me/R/oaMessage/%40964yxgnk/?<text>` and the
reader taps send. The prefixes live on the site side in `mot-dang/linedoor.py`;
each command also answers to its Thai word or its English words alone.

Each feature has its own var, all `"off"`. Any one `"on"` makes the Worker
answer one-to-one chats, with the same OA Manager question as PAGES above.

| var | they send | it does |
|---|---|---|
| `PINS` | `หมุด · pins <map link>` · `แผน · plan <link>` | keeps the set, replies with a link rebuilt from what was parsed; `pins` alone lists them; the page lists them |
| `ASK` | a location | nearest pharmacy, fuel, toilet, hospital and 7-Eleven, straight-line, from `/api/v1/search` within 3 km; quick replies switch the kind; with PAGES on, a "pin" button puts it on the page |
| `ASK` | a question | a `motdang.net/search.html?q=` link and ask.motdang.net; not posted |
| `ALERTS` | `บ้าน · home`, then `หยุดเตือน · stop alerts` | keeps the place to about 100 m; the hourly cron pushes a river alert or a dust alert |
| `STAMPS` | `พาสปอร์ต · passport mhs` or `wats`, then locations | a stamp per stop, "N of M", a card at `/u/<slug>/card/<round>` |
| `OWNERS` | `เจ้าของ · owner MD-XXXXX` | a claim, pending until a person approves it; then their text and photos go to the place as owner edits |
| `SPOTTERS` | a rain or flood answer; `ชื่อบนหน้าอากาศ · credit me` | "N reports this month"; their name on `GET /spotters` |
| `SAFE` | `ปลอดภัย · safe` · `ต้องการความช่วยเหลือ · need help` · `ช่วยด้วย` | a private family link at `/safe/<token>`; help gets 1784 and 1669 as dial buttons and the three nearest rescue units |
| any | `ความลับ · privacy` · `ลบ · delete` twice | what is held, read from the tables; delete removes all of it, R2 photos included |

**Ask the ant.** The search words in the brief ("fuel", "toilet", "hospital")
returned a café, a printing shop and a vet from Tha Phae Gate on 2026-09-28,
so each kind asks with the filter that finds it: `sub=pharmacy`, `sub=fuel`,
`facet=toilet`, `sub=hospital`, `tag=7-eleven`. The reader assistant
(ask.motdang.net, on white-label-ai) has no server-to-server question
endpoint: a chat needs a reader session from `/api/session`, is limited per
caller address, can be gated by Turnstile, and streams. So a question gets
links rather than an answer.

**Alerts.** Cron `30 * * * *`, matched by its whole string in `scheduled()` so
the morning and nightly branches are as they were. River: a gauge in
`motdang.net/data/ping.json` within 15 km at or over its own `limit`.
`ping.json` carries no coordinates, so `data/ping_stations.json` holds them
(from weather-north's thaiwater sample, by station code). Dust: PM2.5 over 75
µg/m³ in the `air.json` city nearest the place, within 40 km. The push goes
through `pushAlert()` in `src/line.js`, its own door like the agenda's. One per
person per kind in 12 hours, `ALERT_CAP` a month across everyone (300), 40 in
one run; every attempt is a row in `alert_log`. `POST /desk/alerts` runs it on
demand, and pushes only with `ALERTS` on.

**Stamps.** `rounds/mhs.json` is `mhs-loop/data/passport_stops.json` as it is:
seven towns, Chiang Mai stamped once for start and end, 1,500 m each.
`rounds/wats.json` is every wat on the rounds in `mot-dang/data/wats.json`
(72), any nine of them, 150 m each — one round rather than one per /wats
round, so a reader who strays from a listed round still gets the stamp. A
location stamps the nearest stop whose circle it falls in.
`scripts/build_data.py` rebuilds both, `data/ping_stations.json` and
`data/rescue.json`, each with a `source` line.

**Owners.** The code is looked up at `motdang.net/data/codes/<first>.json`.
A person decides at the desk:

```
curl -H "Authorization: Bearer $(cat ~/.motdang-line-pull-token)" https://line.motdang.net/desk/owners
curl -X POST -H "Authorization: Bearer $(cat ~/.motdang-line-pull-token)" \
     -d '{"decision":"approve"}' https://line.motdang.net/desk/owners/<id>
```

The mot-dang importer pulls `GET /owner-edits`, fetches photo bytes from
`/desk/photo?key=`, and marks them with `POST /owner-edits/ack {"ids": […]}`,
all behind the same token.

**Safe.** Nan, 2026-09-28: *"family safe page seems too intrusive, but
location sharing is awesome."* The family page shows the name, the mark and
its time. A location reaches it only from the button under the "safe" and
"need help" replies ("ส่งตำแหน่งให้ครอบครัว · Share my location with family"),
sent within ten minutes and before anything else is sent. It is kept exact,
with a map, its time and open-in links (OpenStreetMap, Google, Apple, geo:),
first on the page after "need help". It goes on the next "safe", a new one,
"ลบตำแหน่ง · clear location", or after 24 hours
(`migrations/0007_family_location.sql`). The token is in the reply once;
`safe_links` keeps its sha256.

**Passing a point on.** Nan: *"you should be able to use motdang/line to send
your location to anyone on LINE or other map apps, just like any placeid"*.
Every reply to a shared location carries the point's ten-digit Plus Code
(`src/plus.js`, ported from `mot-dang/coords_layer.py`) and
`motdang.net/map.html?go=<code>`; a stamped wat goes as its `MD-` place ID
instead (codes in `rounds/wats.json`). A "ส่งให้เพื่อน · Share" button opens
`line.me/R/share` with the link, from the reader's own phone. Rescue units are `safety-north/rescue.json` placed from the site's
geojson (49 of 53 have a point).

## Secrets

Five, none in this repo. `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_TOKEN` come
from developers.line.biz — the token can send messages as the account.
`PULL_TOKEN` is ours, made by `deploy.sh` at `~/.motdang-line-pull-token`, and
is what the local filer proves itself with. `CALENDAR_ICS` is Google's secret
iCal address for the appointments calendar — read-only, and revocable from
Calendar settings without touching this Worker. `RELAY_SECRET` is the value
mot-dang-claims checks on forwarded rain and flood answers; `deploy.sh` sets
it from `motdang_relay.key` in `~/.config/nanobotco/keys.json`.

Until the two LINE secrets are set the Worker deploys, answers `/health`, and
refuses every webhook with a 401. That is the correct resting state.
