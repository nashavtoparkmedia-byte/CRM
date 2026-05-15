/**
 * Profile signals extractor (STEP 2 — first business signals).
 *
 * Reads window.__preloadedState__ ONCE from the rendered HTML and extracts
 * three business signals: itemsCount, accountName, profileType.
 *
 * Hard rules:
 *   - one source per field, one attempt, no fallback chains
 *   - any failure (missing source, decode error, parse error, missing path,
 *     wrong type, etc.) returns a neutral value for that field
 *   - this function NEVER throws — caller uses the returned object as-is
 *
 * Chosen paths (committed without fresh profile_ok probe; adjust later if
 * live data shows otherwise):
 *   - accountName:  parsed.user.name   (string)
 *   - profileType:  parsed.user.isCompany (boolean → 'pro'/'private')
 *   - itemsCount:   parsed.user.itemsCount (integer)
 *
 * Mechanism mirrors stable-id-extractor: page.content() → regex for the
 * assignment → decodeURIComponent → JSON.parse. No page.evaluate, no DOM
 * lib dependency, no tsx/__name risk.
 */
import type { Page } from 'playwright';

export type ProfileType = 'private' | 'pro' | 'unknown';

export interface ProfileSignals {
  itemsCount: number | null;
  accountName: string;
  profileType: ProfileType;
}

const NEUTRAL: ProfileSignals = {
  itemsCount: null,
  accountName: '',
  profileType: 'unknown',
};

function extractPreloadedState(html: string): unknown {
  if (!html.includes('__preloadedState__')) return null;
  const m =
    html.match(/__preloadedState__\s*=\s*"([^"]+)"/) ||
    html.match(/__preloadedState__\s*=\s*'([^']+)'/);
  if (!m || !m[1]) return null;
  try {
    const decoded = decodeURIComponent(m[1]);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function readAccountName(parsed: unknown): string {
  const name = (parsed as { user?: { name?: unknown } } | null)?.user?.name;
  if (typeof name !== 'string') return '';
  return name.trim();
}

function readProfileType(parsed: unknown): ProfileType {
  const isCompany = (parsed as { user?: { isCompany?: unknown } } | null)?.user
    ?.isCompany;
  if (isCompany === true) return 'pro';
  if (isCompany === false) return 'private';
  return 'unknown';
}

function readItemsCount(parsed: unknown): number | null {
  const n = (parsed as { user?: { itemsCount?: unknown } } | null)?.user
    ?.itemsCount;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return null;
  }
  return n;
}

export async function extractProfileSignals(
  page: Page,
): Promise<ProfileSignals> {
  try {
    const html = await page.content();
    const parsed = extractPreloadedState(html);
    if (parsed === null) return { ...NEUTRAL };
    return {
      itemsCount: readItemsCount(parsed),
      accountName: readAccountName(parsed),
      profileType: readProfileType(parsed),
    };
  } catch {
    return { ...NEUTRAL };
  }
}
