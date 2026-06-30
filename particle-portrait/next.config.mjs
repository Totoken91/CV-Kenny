/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // three / R3F ship ESM; Next 14 handles it, but transpiling keeps older setups happy.
  transpilePackages: ["three"],
};

export default nextConfig;
