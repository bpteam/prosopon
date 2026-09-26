/** Pages the extension works on. Must match manifest.json's content_scripts/host_permissions. */
export function isChatGptUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'chatgpt.com';
  } catch {
    return false;
  }
}
