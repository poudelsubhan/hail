import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages export raw TS — let Next compile them in our build.
  transpilePackages: ["@ac/contracts"],
  reactStrictMode: true,
};

export default nextConfig;
