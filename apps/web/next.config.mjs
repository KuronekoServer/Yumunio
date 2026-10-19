/** One Next.js App Router build is served by both the Node and Workers API hosts. */
const config = {
  output: 'export',
  trailingSlash: false,
  skipTrailingSlashRedirect: true,
  poweredByHeader: false,
  reactStrictMode: false,
  images: { unoptimized: true },
  experimental: { cpus: 2 },
};
export default config;
