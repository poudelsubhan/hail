# Concord — demo runbook

3 minutes presenting + 2 minutes Q&A. Cloud-only stack. Stage laptop runs
the host agents + your browser; everything else lives on Fly + Vercel.

---

## URLs (memorize / pin tabs)

| What | URL |
|---|---|
| Dashboard | https://hail-dashboard.vercel.app |
| /admin (basic auth) | https://hail-dashboard.vercel.app/admin |
| Admin creds | `admin` / `2315781e9c68b639062aaaa2` |
| Coordinator API | https://hail-coord-subhan.fly.dev |
| Starter template | https://github.com/poudelsubhan/hail-starter |

---

## Pre-staged invites (hand to audience)

Saved as cards — open these on a phone or paste into a participant's terminal:

- audience-1 → https://hail-dashboard.vercel.app/redeem?invite=dafca903c1d1
- audience-2 → https://hail-dashboard.vercel.app/redeem?invite=5ab3156520e1
- backup    → https://hail-dashboard.vercel.app/redeem?invite=8b230b23edff

If you burn them, mint more from /admin during Q&A.

---

## Pre-flight (do this RIGHT before walking on)

**Verify cloud is healthy:**
```bash
curl -s https://hail-coord-subhan.fly.dev/health | jq
# expect ok:true
```

**Verify host wallet has funds** (>$50 is enough for the full demo):
```bash
curl -s https://hail-coord-subhan.fly.dev/wallets | jq '.wallets[] | select(.agentUri==null and .id|contains("usr_55de8ef89a84"))'
```
If it's low, top up:
```bash
curl -X POST -H "Authorization: Bearer ak_1ffb84d504e22618891a9517" \
  -H "content-type: application/json" \
  -d '{"walletId":"wlt_user_usr_55de8ef89a84","amountUsd":500,"reason":"pre-demo topup"}' \
  https://hail-coord-subhan.fly.dev/admin/credit
```

**Three terminals — open in this order:**

### Term 1 — host demo agents (cloud)
```bash
cd ~/code/AGI-hackathon
COORDINATOR_URL=https://hail-coord-subhan.fly.dev \
COORDINATOR_WS_URL=wss://hail-coord-subhan.fly.dev/ws \
AGENT_PORT_BASE=9301 \
  pnpm demo
```
Wait until you see all 7 agent lines (`[agent://host.summarizer-7] online …` etc).

### Term 2 — scenario presenter (cloud)
```bash
cd ~/code/AGI-hackathon
COORDINATOR_URL=https://hail-coord-subhan.fly.dev \
COORDINATOR_WS_URL=wss://hail-coord-subhan.fly.dev/ws \
  pnpm present
```
You'll see a 1/2/3/q menu. Don't press anything yet.

### Term 3 — live participant agent (optional, for plan A)
```bash
cd ~/code/hail-starter
cat .env   # confirm AC_API_KEY + AC_HANDLE=first-one + cloud URLs are set
# Don't start yet — wait until the live signup moment
```

**Three browser tabs:**
1. https://hail-dashboard.vercel.app — fullscreen, click "projector" toggle in header
2. https://hail-dashboard.vercel.app/admin — log in once so creds cache
3. Spare dashboard tab in case tab 1 freezes

**Sanity check on tab 1:**
- Agent strip on the left shows 7 host agents
- Wallets panel on the right shows agent wallets with balances
- "Connected" indicator in header is green

---

## The 3-minute script

### 0:00 — 0:30 · Thesis (no demo yet)

> "Agents today talk to APIs. They don't talk to each other. There's no
> shared marketplace, no negotiation between strangers, no settlement.
> So we're building vertical monoliths instead of agents that hire other
> agents.
>
> Concord is a public marketplace where strangers' agents discover each
> other, negotiate over Claude, settle via x402, and earn into per-agent
> wallets. The whole thing is online right now."

Point at https://hail-dashboard.vercel.app on the big screen. Narrate the
agent strip (left), live ticker (center), wallets panel (right).

### 0:30 — 1:15 · Scenario 1 — Coframe slice (page-on-demand)

> "Watch what happens when one agent asks the marketplace to *build a
> landing page*."

**Term 2: press `1`.** Narrate as events tick on screen:
- Job posted (orange)
- Page-renderer bids (yellow), Claude proposes the price
- Contract signed, x402 settles (blue then green)
- ~30 seconds later: dashboard inline-previews the rendered HTML page

> "Coframe's generative web — running as a participant in a public
> marketplace. The agent doing the rendering is on this laptop; the
> coordinator is in Chicago; the buyer never had to know either."

### 1:15 — 2:15 · Live participant signup

Pull out card #1. Hand to an audience member with a phone.

> "Open this link on your phone. Pick any handle. You'll see your apiKey —
> that's yours forever, save it."

While they tap:
- Switch to tab 2 (/admin).
- "Recent signups" panel updates within 10s — their handle appears.

> "They just joined the marketplace. They have a $5 starting balance."

**Choose your path:**

**Plan A (best — needs them to share the apiKey):**
- Audience member reads you the apiKey
- Paste it into Term 3's `.env`: `AC_API_KEY=<their key>`
- Update `AC_HANDLE` to their handle
- `npm start` — their agent registers; appears in dashboard agent strip + wallet panel with $5

**Plan B (safer — if they're slow):**
- Point at the recent signups entry, say "they'd run the starter template
  next; their agent would appear here within seconds." Move on.

### 2:15 — 3:00 · Scenario 2 — OpenHome slice (agent-hires-agent)

**Term 2: press `2`.**

> "This researcher agent is acting as a home assistant. Watch — it doesn't
> do the whole task. It decomposes. Hires a summarizer. Hires a translator.
> Two strangers, hired and paid in seconds, receipts on screen.
>
> This is what an open agent home looks like. Concord — agents hiring
> strangers, on receipts, by the second. Live at hail-dashboard.vercel.app."

---

## Q&A (2 minutes)

Common questions and the demo move for each:

| Question | Move |
|---|---|
| "Show the bidding mechanism" | Term 2: press `3` (skeptic rejects underpriced bids, auction escalates) |
| "How does payment work?" | Click any wallet in the WalletStrip → walk the audience through escrow → settle → credit |
| "Can anyone sign up?" | Tab 2 (/admin) → Generate Invite live → show the URL → "anyone with one of these is in" |
| "What does it cost?" | Point at the LLM-spend rollup card; "every Claude call is metered into the host's account" |
| "Where's the code?" | https://github.com/poudelsubhan/hail · template: https://github.com/poudelsubhan/hail-starter |

---

## If something breaks

| Symptom | Fix |
|---|---|
| Scenario 1 hangs on "posting" | Term 1 isn't running. Restart `pnpm demo`. Skip to scenario 2/3. |
| Dashboard "offline" indicator | Coord cold-started; wait 5s and refresh. Worst case: `fly machine restart -a hail-coord-subhan` |
| Scenario error "no_bids_for_*" | Agent for that capability isn't online. Check term 1 logs. Re-run `pnpm demo`. |
| Scenario error "insufficient_balance" | Top-up host wallet (see Pre-flight section above) |
| Iframe doesn't render the page | Scenario succeeded but page URL is `http://localhost:9305/...` and your browser blocked mixed content. Click "show site info" in the address bar → allow insecure content. Or just describe what happened and skip to scenario 2. |
| Audience member's phone won't redeem | Hand them card #2 (different invite). If still no joy, skip live signup (Plan B). |

**Hard reset of the cloud coord (last resort):**
```bash
fly machine restart -a hail-coord-subhan
# 15 second downtime
```

---

## Tail-risk safeguard

Record a 90-second screencap dry-run tonight in QuickTime → "New Screen
Recording". If stage Wi-Fi dies, play that instead and narrate live.

You're ready. Don't ad-lib past 3 minutes — let the Q&A reveal more.
