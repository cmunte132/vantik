/** Copyright (c) 2024, Vantik, all rights reserved. **/

module.exports = {
  reactStrictMode: false,
  experimental: {
    scrollRestoration: true,
  },
  transpilePackages: ['geist', '@vantikhq/ui'],
  devIndicators: {
    buildActivityPosition: 'bottom-right',
  },
  swcMinify: true,
  output: 'standalone',
};
