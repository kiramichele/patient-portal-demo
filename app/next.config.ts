import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // Pin the workspace root to this app dir so Next.js doesn't infer a parent
  // directory as the root (which breaks the Netlify Next.js plugin output).
  outputFileTracingRoot: __dirname,
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
