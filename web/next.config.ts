import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The repo root has its own lockfile for the nhost functions and scripts, so Turbopack
  // infers the wrong workspace root and ignores web's lockfile without this.
  turbopack: { root: __dirname },
};

export default nextConfig;
