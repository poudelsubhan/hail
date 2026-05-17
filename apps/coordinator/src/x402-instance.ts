import { X402 } from "@ac/x402";

const SECRET = process.env.X402_HMAC_SECRET ?? "dev-secret-change-me";
if (SECRET === "dev-secret-change-me") {
  process.stderr.write(
    "[x402] using default dev secret — set X402_HMAC_SECRET in .env for stable proofs\n",
  );
}

export const x402 = new X402({ secret: SECRET });
