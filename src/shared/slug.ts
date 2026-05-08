// Filesystem-safe slug — used to build output/<company>-<role>/ paths.
export function slug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function applicationSlug(company: string | null, role: string): string {
  const c = slug(company ?? 'unknown');
  const r = slug(role);
  return `${c}-${r}`;
}
