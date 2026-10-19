module.exports = {
  experimental: {
    reactCompiler: true,
  },
  transpilePackages: ["gifsicle-wasm-browser"],
  async rewrites() {
    return {
      beforeFiles: [{ source: "/", destination: "/clipper/index.html" }],
    };
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};
