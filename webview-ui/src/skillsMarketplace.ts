// Skills marketplace — fetches a curated catalog of public claude code
// skills the user can install in one click. Catalog lives in the
// deepthix-agent repo at docs/skills-marketplace.json so it can be
// updated without re-shipping the app. Each entry references a SKILL.md
// hosted on a public URL (raw.githubusercontent.com works); we fetch
// the markdown from the webview and hand the bytes to the Rust
// install_skill_from_text command.

const MARKETPLACE_URL =
  'https://raw.githubusercontent.com/deepthix/deepthix-agent/main/docs/skills-marketplace.json';

export interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  author?: string;
  /** Raw URL to the SKILL.md file. Fetched at install time, not at list time. */
  url: string;
  /** Optional homepage / repo URL shown in the card for transparency. */
  homepage?: string;
}

export interface MarketplaceCatalog {
  version: number;
  updated_at?: string;
  skills: MarketplaceSkill[];
}

/** Fetch the catalog index. Aggressively cached (no-store would melt the
 *  GitHub raw rate limiter on each refresh). */
export async function fetchMarketplaceCatalog(): Promise<MarketplaceCatalog> {
  const res = await fetch(MARKETPLACE_URL, { cache: 'default' });
  if (!res.ok) throw new Error(`marketplace fetch failed: HTTP ${res.status}`);
  const json = (await res.json()) as MarketplaceCatalog;
  if (!Array.isArray(json.skills)) throw new Error('malformed marketplace catalog');
  return json;
}

/** Fetch a single skill's SKILL.md content. Returns the raw markdown
 *  string (frontmatter + body) ready to feed to install_skill_from_text. */
export async function fetchSkillContent(url: string): Promise<string> {
  const res = await fetch(url, { cache: 'default' });
  if (!res.ok) throw new Error(`skill fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length < 10 || text.length > 524_288) {
    throw new Error(`skill content suspicious size: ${text.length} bytes`);
  }
  return text;
}
