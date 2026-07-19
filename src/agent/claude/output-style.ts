import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../../core/logger';

/**
 * Load the active Claude Code output style and return it as a system-prompt
 * append fragment (leading blank line included), or '' when none applies.
 *
 * Why the bridge reads settings.json here even though the SDK call sets
 * `settingSources: []`: those are different concerns. `settingSources` controls
 * whether the SDK loads settings as a *permission/context source* — the bridge
 * keeps it empty so the on-disk `permissions.allow` list can't pre-approve tools
 * behind the bridge's canUseTool approval layer. Reading only the `outputStyle`
 * *string* here touches no permission surface; it just recovers the user's
 * chosen writing register, which the interactive TUI would normally inject into
 * the system prompt but the headless SDK path drops.
 *
 * Built-in styles (default/Explanatory/Learning) have no file on disk and are
 * baked into the claude_code preset already, so they are skipped — only custom
 * styles under ~/.claude/output-styles/*.md are appended.
 *
 * Every failure path returns '' so a malformed config can never break a run.
 */
export function loadActiveOutputStyleAppend(): string {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const settingsRaw = safeRead(join(configDir, 'settings.json'));
    if (!settingsRaw) return '';
    const styleName = (JSON.parse(settingsRaw) as { outputStyle?: unknown }).outputStyle;
    if (typeof styleName !== 'string' || !styleName.trim()) return '';

    const body = resolveStyleBody(join(configDir, 'output-styles'), styleName.trim());
    if (!body) return '';
    log.info('agent', 'output-style-injected', { style: styleName });
    return `\n\n${body}`;
  } catch (err) {
    log.warn('agent', 'output-style-load-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

/**
 * Find the *.md whose frontmatter `name:` (or, as a fallback, whose filename
 * slug) matches the configured style name, and return its body with the YAML
 * frontmatter stripped. Returns undefined for built-in styles with no file.
 */
function resolveStyleBody(stylesDir: string, styleName: string): string | undefined {
  let files: string[];
  try {
    files = readdirSync(stylesDir).filter((f) => f.endsWith('.md'));
  } catch {
    return undefined; // no custom styles dir → built-in style, nothing to inject
  }
  const wantSlug = slugify(styleName);
  let slugFallback: string | undefined;
  for (const file of files) {
    const raw = safeRead(join(stylesDir, file));
    if (!raw) continue;
    const { frontmatter, body } = splitFrontmatter(raw);
    const name = frontmatter.match(/^name:\s*(.+?)\s*$/m)?.[1]?.trim();
    if (name && name.toLowerCase() === styleName.toLowerCase()) return body.trim() || undefined;
    if (slugify(file.replace(/\.md$/, '')) === wantSlug) slugFallback = body.trim() || undefined;
  }
  return slugFallback;
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  // Frontmatter is a leading `---\n ... \n---` block; tolerate CRLF and a BOM.
  const m = raw.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: '', body: raw };
  return { frontmatter: m[1] ?? '', body: m[2] ?? '' };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
