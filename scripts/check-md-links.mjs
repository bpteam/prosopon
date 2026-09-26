// Checks relative links and #anchors in the repository's own Markdown files.
//
//   node scripts/check-md-links.mjs
//
// External (http/https/mailto) links are not fetched. Exit code 1 lists every broken link.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'test-results', 'playwright-report', 'dev-profile']);

function markdownFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

/** GitHub-style heading slugs of a Markdown file. */
function anchors(file) {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  const seen = new Map();
  return new Set(
    [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, heading]) => {
      const base = heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return n ? `${base}-${n}` : base;
    }),
  );
}

const broken = [];
for (const file of markdownFiles(root)) {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z]+:/i.test(target)) continue;
    const [path, anchor] = target.split('#');
    const resolved = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
    const where = `${relative(root, file)} → ${target}`;
    if (!existsSync(resolved)) broken.push(`${where} (missing file)`);
    else if (anchor && resolved.endsWith('.md') && !anchors(resolved).has(anchor)) broken.push(`${where} (missing anchor)`);
  }
}

if (broken.length) {
  console.error(`Broken Markdown links:\n${broken.map((b) => `  ${b}`).join('\n')}`);
  process.exit(1);
}
console.log('Markdown links OK');
