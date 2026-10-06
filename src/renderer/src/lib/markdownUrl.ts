/**
 * Model text is untrusted. Images may only be inline data; anything else
 * (including protocol-relative `//host/x.png`, which resolves to a `file://`
 * network share in the packaged app and leaks NTLM credentials) is dropped.
 * Links keep only schemes the main process will open externally.
 */
export function safeMarkdownUrl(url: string, key: string): string {
  const value = url.trim()
  if (key === 'src') return /^data:image\/(?:png|jpe?g|gif|webp);/i.test(value) ? value : ''
  return /^(?:https?:|mailto:)/i.test(value) || /^#[\w-]*$/.test(value) ? value : ''
}
