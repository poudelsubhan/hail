# 90-second demo script

Stage setup: laptop on stage Wi-Fi. Coordinator + demo + dashboard already
running. Browser open to `localhost:3000` projected. Terminal with
`pnpm present` ready to receive keypresses.

**If stage Wi-Fi misbehaves**: play the prerecorded fallback video at
`docs/fallback.mp4` (record this during the final dry run).

---

## Beat 1 — Thesis (≈15s)

> "Agents don't have HTTP yet. Two AI agents from different vendors can't
> find each other, agree on terms, or exchange value. There's no protocol
> for the marketplace between them. We built the missing layer."

Point at the dashboard. Agent strip on the left already shows seven
agents online with reputations. Briefly: *"These are seven strangers.
They've never met."*

---

## Beat 2 — Scenario 1: Coframe page-on-demand (≈25s)

Press **`1`** on the presenter.

What's on screen:

1. `job.posted` flashes in the ticker — `render_page · max $0.50`.
2. `bid.placed` from `page-renderer` at `$0.35`.
3. `contract.signed` between buyer and page-renderer.
4. `llm.cost` for the Sonnet 4.6 call (~$0.04, ~25s).
5. `payment.settled` + `job.completed` with a `result.url`.
6. **The iframe in the bottom-right fills with the rendered Tailwind
   landing page.**

Talking points (delivered while it runs):

> "A buyer posts a job: 'I want a landing page.' The page-renderer agent
> bids. They settle in **x402** — HTTP 402, signed proof, real wire
> protocol. The renderer generates Tailwind HTML with Claude Sonnet and
> hosts the page on its own URL. We see it inline."

Close with: ***"Coframe's generative web runs on this."***

---

## Beat 3 — Scenario 2: OpenHome home-agent decomposes (≈25s)

Press **`2`**.

What's on screen:

1. `research` job posted by `openhome-user`.
2. `researcher` bids, wins.
3. Researcher then posts **three** sub-jobs to `summarize`, `translate`,
   `image_describe` capabilities.
4. Three different agents win those sub-jobs. Three contracts, three
   payments, three deliveries.
5. The agent strip flashes white on each agent as it participates.
6. Reputation `+0.05` chips float up next to each winner.

Talking points:

> "Imagine this is your home assistant. You ask it to find a recipe,
> summarize the steps, and translate to Spanish. It doesn't know how to
> do any of it. It decomposes the task and **hires three strangers on
> the protocol.** Every step has a receipt. Reputation deltas you can see."

Close with: ***"This is what an open agent home looks like — your
assistant hires strangers, and you see every receipt."***

---

## Beat 4 — Scenario 3: Bidding war (≈15s)

Press **`3`**.

What's on screen:

1. `summarize` job with a generous `$0.30` ceiling.
2. Two summarizers (`summarizer-7` and `summarizer-pro`) both bid.
3. Each rebids 2–3 times, undercutting the other.
4. At some bid below `$0.05`, the **Skeptic chimes in** with a
   `negotiation.message` event: *"$0.04 is corner-cutting territory."*
5. One summarizer wins, delivers.

Talking points:

> "Two summarizers, same job. They fight. Each rebid is visible — round
> one, round two, round three. The Skeptic agent is just watching, and
> when bids drop below what it considers sane, it speaks up. Drama in
> the ticker."

---

## Beat 5 — Land the meter (≈10s)

Move the cursor to the headline strip at the top of the dashboard.

> "Every Claude call is logged, every dollar is on the wire, every
> millisecond of negotiation latency is here. p50, p95, success rate,
> total spend, total tokens. **Observability is the product** — not a
> follow-up."

Pause. Smile. Done.

---

## Backup talking points (if something hangs)

- **No bids land**: "The auction is live; the agents are deciding. Notice
  the p50 metric updates whenever a contract signs."
- **Page render takes too long**: "Sonnet generates a real document — we
  cap at 2400 tokens, ~$0.04 per page. The cost panel on the right is
  showing it as it happens."
- **Wi-Fi dies**: switch to the fallback video.

---

## What NOT to do

- Don't explain `agent://` URIs or HMAC details unless asked. Save it for
  the booth.
- Don't open the source code on stage. The dashboard is the demo.
- Don't read the result JSON aloud. Point at the iframe / the ticker /
  the meter — let the screen speak.

---

## Setup checklist (one hour before)

- [ ] `.env` populated with `ANTHROPIC_API_KEY` and `X402_HMAC_SECRET`
- [ ] `pnpm install` ran clean
- [ ] `pnpm coordinator` — health endpoint returns `{ok:true}`
- [ ] `pnpm demo` — all 7 agents print "online @ http://localhost:910x"
- [ ] `pnpm dashboard` — visible on the projector
- [ ] `pnpm present` — banner prints, terminal accepts keys
- [ ] Brightness up, presenter mouse working
- [ ] Run the three scenarios once before going on — confirms Claude
      latency is in spec for the day
- [ ] Fallback `.mp4` queued in QuickTime, full-screen ready
