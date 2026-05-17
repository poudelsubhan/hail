import { chat, setClaudeLogSink } from "@ac/llm";

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("ANTHROPIC_API_KEY not set — skipping live call. Wrapper imported OK.");
  process.exit(0);
}

setClaudeLogSink((log) => {
  console.log("[sink]", JSON.stringify(log));
});

const res = await chat({
  system: "You answer in <= 8 words. Plain text only.",
  messages: [{ role: "user", content: "Say hi and name a color." }],
  cacheSystem: true,
  tag: "smoke",
  maxTokens: 32,
});

console.log("text:", res.text);
console.log("cost: $" + res.log.costUsd.toFixed(6));
