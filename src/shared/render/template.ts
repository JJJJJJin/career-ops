// Minimal {{KEY}} template substitution — no logic, no loops. The render
// helpers in resume-pdf.ts and cover-letter-pdf.ts pre-build HTML chunks
// for the dynamic blocks and pass them as values.

export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    return values[key] ?? '';
  });
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Inline-safe markdown subset: **bold**, *italic*, `code`. No block-level. */
export function inlineMd(s: string | null | undefined): string {
  if (!s) return '';
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
