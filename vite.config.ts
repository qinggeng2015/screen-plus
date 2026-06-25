import { defineConfig } from 'vite';

function normalizeBasePath(value: string | undefined) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return '';

  const normalized = trimmed.split('/').filter(Boolean).join('/');
  return normalized ? `/${normalized}` : '';
}

const backendTarget = 'http://127.0.0.1:3000';
const websocketTarget = 'ws://127.0.0.1:3000';
const devBasePath = normalizeBasePath(process.env.SCREEN_PLUS_BASE_PATH || process.env.VITE_SCREEN_PLUS_BASE_PATH);
const stripDevBasePath = (path: string) => devBasePath && path.startsWith(`${devBasePath}/`)
  ? path.slice(devBasePath.length)
  : path;

export default defineConfig({
  base: './',
  define: {
    __SCREEN_PLUS_DEV_BASE_PATH__: JSON.stringify(devBasePath)
  },
  server: {
    proxy: {
      '/api': backendTarget,
      '/term': {
        target: websocketTarget,
        ws: true
      },
      ...(devBasePath ? {
        [`${devBasePath}/api`]: {
          target: backendTarget,
          rewrite: stripDevBasePath
        },
        [`${devBasePath}/term`]: {
          target: websocketTarget,
          ws: true,
          rewrite: stripDevBasePath
        }
      } : {})
    }
  }
});
