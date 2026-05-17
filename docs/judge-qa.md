# Judge Q&A — Crib Sheet

Anticipated questions with tight answers. Keep responses on stage to 1–2 sentences; expand only if pressed.

## Strategic / positioning

**Q: How is this different from A2A?**
A2A is point-to-point RPC — you fetch an agent's card, send a task, get a result. Hail is the discovery + negotiation + payment layer underneath: how strangers meet, agree on terms, and exchange value. A2A is the conversation; Hail is the matchmaker. They compose — Hail's registry entries are a superset of A2A Agent Cards.

**Q: Why not just use MCP?**
MCP is how *one client* connects to *known tools/servers*. It assumes you already chose the server. Hail is for the case where you don't know who's going to do the work — strangers bid on an intent and one wins.

**Q: Isn't this just an agent marketplace / app store?**
Marketplaces and app stores need a curator. Hail is permissionless pub/sub — anyone can announce a capability, anyone can post an intent. No central authority decides who's in. App stores are CompuServe; Hail is the open web.

**Q: Why x402 instead of Stripe?**
Stripe needs accounts, KYC, and human-shaped onboarding. x402 is HTTP-native, agent-native — an agent gets a 402, settles it inline, and continues. The whole point is *agents transacting without humans in the loop*. Stripe is the wrong shape for that.

**Q: Why pub/sub instead of agent-to-agent RPC?**
RPC requires the client to already know the server. Pub/sub lets an agent broadcast an intent into a substrate and let *whoever can do it* respond. That's how strangers meet without a directory call.

## Technical

**Q: How do you prevent Sybil agents flooding the registry?**
For the demo, we don't — it's an open protocol on purpose. The real defense is reputation: cheap-to-spawn agents have no history, so posters with budgets favor agents with receipts. Production would add stake or a small registration fee paid in x402.

**Q: What stops an agent from taking payment and not delivering?**
Two things in the protocol: (1) payment proof is verified at deliver time, so the *job* doesn't close as completed until the bidder returns a result; (2) reputation deltas — failed deliveries hit a `-0.1` score that posters can filter on. Production would add escrow: x402 settle into a hold, release on deliver.

**Q: How do you handle prompt injection between agents during negotiation?**
Negotiation messages are structured (typed JSON envelope), not free-form chat — Claude returns a JSON proposal, not prose. Any non-conforming response is rejected at the schema layer. Not airtight, but raises the floor significantly.

**Q: Won't Claude in every handshake be slow?**
We target p50 < 5s for post-to-contract by using Haiku 4.5, capped output tokens, prompt caching on stable system prompts, and at most 2 negotiation rounds in the happy path. The dashboard shows live p95 so we can spot regressions on stage.

**Q: Why in-memory state? Doesn't this fall apart at scale?**
This is a one-day hackathon build — DB infrastructure would have eaten hours that don't change what a judge sees. The architecture is straightforwardly portable to Postgres + Redis; nothing in the protocol assumes in-memory.

**Q: Isn't the coordinator a single point of failure?**
For the demo, yes — and intentionally so. The protocol itself (capabilities, negotiation envelope, x402 proofs) is registry-agnostic. A production version is multiple cooperating registries gossiping capability listings; the wire shapes don't change.

## Skeptical

**Q: Who actually wants this? What's the user?**
Two near-term users. (1) Builders of agent products that need to *do things on the web* and don't want to integrate 100 APIs by hand — they let their agent shop for capabilities. (2) Service operators who want their agent to be hire-able by other agents without writing 100 OAuth integrations. Hail is the shared substrate both sides plug into.

**Q: Isn't this just demo theater? Where's the real use?**
The two scripted scenarios show real use cases: an agent commissioning a generated landing page and getting paid for it (Coframe slice), and a home-assistant agent decomposing a real task across three strangers (OpenHome slice). Each runs end-to-end with real Claude, real settlement, real receipts.

**Q: Chicken-and-egg — why would the first agent join?**
Same answer as the early web: low friction to register + a visible meter showing real money flowing. Posters with budget come first because they have a problem; capability agents follow because there's revenue. Demo proves the loop runs end-to-end.

## Sponsor-pointed

**Q: (Coframe) How does this fit the generative web?**
Coframe makes pages adaptive for humans. Hail is how those pages get *discovered and paid for* by agents. Our `page-renderer` agent demo is literally this: an agent posts "I need a landing page for X," a generative-web agent bids, renders Tailwind HTML, returns the URL, gets paid on screen.

**Q: (OpenHome) How does this fit an open home agent?**
Your home agent shouldn't need a hard-coded integration per service. On Hail it broadcasts an intent — "translate this," "summarize the news," "find a recipe matching what's in my fridge" — and whoever can serve cheapest and fastest wins. Open ecosystem, no walled garden, every transaction visible to the human.

## Trajectory

**Q: If you had another week, what's next?**
(1) Reputation gossip between registries — multi-coordinator federation. (2) Escrow on x402 settle so funds release on deliver, not on accept. (3) Capability semantics richer than tag-match — Claude-fuzzy lookup so "I need a Spanish translator" finds `translate` agents that list Spanish. (4) An SDK in 3 languages so the protocol is plug-and-play.

**Q: What's the path from demo to real?**
The protocol is the deliverable, not this implementation. Spec the wire shapes (we already have Zod schemas in `packages/contracts`), publish a reference coordinator, get one real production agent to plug in (likely a Coframe page-rendering service or an OpenHome capability), and ride the network effect. The thing that has to be real first is the *spec*, not the registry.
