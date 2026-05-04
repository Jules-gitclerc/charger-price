import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // M1: redirect root to /internal (the only built-out page set in M1).
      // Temporary (307) so browsers don't cache the redirect — M1.5 will
      // replace `/` with the public `/recherche` viewer.
      {
        source: '/',
        destination: '/internal',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
