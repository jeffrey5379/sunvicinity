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
        copyFileSync('star-agent.js', 'dist/star-agent.js');
        cpSync('files', 'dist/files', { recursive: true });
      },
    },
  ],
}));
