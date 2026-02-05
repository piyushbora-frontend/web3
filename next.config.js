const path = require("path");
const fs = require("fs");

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      // MetaMask SDK expects React Native async-storage; use browser localStorage stub
      "@react-native-async-storage/async-storage": path.resolve(
        __dirname,
        "lib/async-storage-stub.js"
      ),
      // pino (WalletConnect) optional dependency; not needed in browser
      "pino-pretty": path.resolve(__dirname, "lib/pino-pretty-stub.js"),
    };
    return config;
  },
  async rewrites() {
    const cssDir = path.join(__dirname, ".next", "static", "css");
    const rewritesList = [];
    if (fs.existsSync(cssDir)) {
      const files = fs.readdirSync(cssDir).filter((f) => f.endsWith(".css"));
      if (files.length > 0) {
        rewritesList.push({
          source: "/_next/static/css/app/layout.css",
          destination: `/_next/static/css/${files[0]}`,
        });
      }
    }
    return rewritesList.length > 0 ? { beforeFiles: rewritesList } : { beforeFiles: [] };
  },
};

module.exports = nextConfig;
