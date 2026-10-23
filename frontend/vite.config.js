import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy: { '/api': { target: env.VITE_DEV_API || 'http://localhost:4000', changeOrigin: true } },
    },
    ssr: {
      // bundle everything: some UI packages ship extension-less ESM imports that Node cannot resolve
      noExternal: true,
    },
    build: { target: 'es2022', sourcemap: false, emptyOutDir: true, chunkSizeWarningLimit: 900 },
  };
});
