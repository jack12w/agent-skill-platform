/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  async rewrites() {
    // API 后端地址：Docker 中指向容器名 api，本地开发用 localhost
    const apiHost = process.env.API_HOST || 'localhost';
    const apiPort = process.env.API_PORT || '3001';
    return [
      {
        source: '/api/:path*',
        destination: `http://${apiHost}:${apiPort}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
