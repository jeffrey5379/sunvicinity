import { defineConfig } from 'vite';
import { copyFileSync, cpSync } from 'fs';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/sunvicinity/' : '/',
  build: {
    target: 'esnext',
  },
  plugins: [
    {
      name: 'copy-static-assets',
      closeBundle() {
        copyFileSync('agent.js', 'dist/agent.js');
        cpSync('files', 'dist/files', { recursive: true });
      },
    },
  ],
}));
