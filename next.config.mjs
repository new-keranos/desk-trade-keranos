/** @type {import('next').NextConfig} */
// resvg is a native module: load it from node_modules at runtime instead of bundling it.
const nextConfig = { reactStrictMode: true, serverExternalPackages: ["@resvg/resvg-js"] };
export default nextConfig;
