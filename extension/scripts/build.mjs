// Builds the unpacked extension into dist/.
//
// Two Vite builds, because content scripts can't be ES modules while everything else should be:
//  1. ES: service worker, offscreen document, and the avatar runtime the content script imports on activation.
//  2. IIFE: the content script itself, kept tiny (no three.js) since it runs on every chatgpt.com page.
//
//   node scripts/build.mjs [--mode development] [--watch]
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const avatarRoot = resolve(root, '../avatar');
const outDir = resolve(root, 'dist');
const args = process.argv.slice(2);
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'production';
// WATCH_POLLING=true: file events don't cross some bind mounts (Docker Desktop on Windows, network FS).
const watch = args.includes('--watch')
  ? process.env.WATCH_POLLING === 'true'
    ? { watcher: { usePolling: true, pollInterval: 300 } }
    : {}
  : null;
const dev = mode === 'development';
// import.meta.env.DEV follows NODE_ENV, not --mode: development builds carry the diagnostics and the E2E hook.
process.env.NODE_ENV = dev ? 'development' : 'production';

const shared = {
  configFile: false,
  mode,
  logLevel: 'warn',
  resolve: {
    alias: { '@avatar': resolve(avatarRoot, 'src') },
    // Core sources live outside this package; make sure there is one copy of three.
    dedupe: ['three', '@pixiv/three-vrm'],
  },
};

/** Files that are not imported by code: manifest and the wLipSync worklet/WASM for the CSP-safe split build. */
function copyStatic() {
  const files = [
    [resolve(root, 'manifest.json'), 'manifest.json'],
    [resolve(avatarRoot, 'node_modules/wlipsync/dist/audio-processor.js'), 'lipsync/wlipsync/audio-processor.js'],
    [resolve(avatarRoot, 'node_modules/wlipsync/dist/wlipsync.wasm'), 'lipsync/wlipsync/wlipsync.wasm'],
  ];
  return {
    name: 'prosopon-copy-static',
    async writeBundle() {
      for (const [from, to] of files) {
        await mkdir(dirname(resolve(outDir, to)), { recursive: true });
        await copyFile(from, resolve(outDir, to));
      }
    },
  };
}

await build({
  ...shared,
  root: resolve(root, 'src'),
  // Models and lip-sync assets come straight from the sandbox: one copy in the repo.
  publicDir: resolve(avatarRoot, 'public'),
  base: '/',
  plugins: [copyStatic()],
  build: {
    outDir,
    emptyOutDir: true,
    watch,
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    // The preload helper would inject <link rel=modulepreload> into chatgpt.com from the content script's imports.
    modulePreload: false,
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      input: {
        background: resolve(root, 'src/background/service-worker.ts'),
        offscreen: resolve(root, 'src/offscreen/index.html'),
        'avatar-runtime': resolve(root, 'src/content/avatar-runtime.ts'),
      },
      preserveEntrySignatures: 'exports-only',
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});

await build({
  ...shared,
  root,
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: false,
    watch,
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    lib: {
      entry: resolve(root, 'src/content/content.ts'),
      formats: ['iife'],
      name: 'prosoponContent',
      fileName: () => 'content.js',
    },
  },
});

if (!watch) console.log(`[prosopon] built ${mode} extension into ${outDir}`);
