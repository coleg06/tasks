import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { renderTenantHtml } from './shared/tenant-html.ts';

export default defineConfig({
  root: 'web',
  plugins: [
    {
      name: 'tenant-profile-html',
      transformIndexHtml: (html) => renderTenantHtml(html),
    },
    react(),
    tailwindcss(),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
