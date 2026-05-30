import { z } from 'zod';

/**
 * Schema for the YAML frontmatter inside a SKILL.md file.
 * Mirrors the Claude Skills convention: a markdown file with a `---` YAML
 * block at the top describing the skill's identity, version, and metadata.
 *
 * Example SKILL.md:
 * ---
 * name: my-skill
 * version: 1.2.0
 * description: A short summary of what this skill does.
 * tags: [search, web]
 * license: MIT
 * author: someone@example.com
 * ---
 *
 * # My Skill
 * (body content / instructions)
 */
export const SkillMetaSchema = z.object({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver like 1.2.3'),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  license: z.string().optional(),
  author: z.string().optional(),
});

export type SkillMeta = z.infer<typeof SkillMetaSchema>;

/**
 * Extract the raw YAML frontmatter block from a SKILL.md file.
 * Returns null if no frontmatter is present.
 */
function extractFrontmatter(content: string): string | null {
  // Strip BOM and normalize line endings
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  return match ? match[1] : null;
}

/**
 * Minimal YAML-subset parser for SKILL.md frontmatter.
 * Supports: scalars (string/number/bool), quoted strings, inline arrays `[a, b]`,
 * and YAML block-style arrays (`- item` lines).
 * Intentionally tiny — no external dependency needed for our schema.
 */
function parseSimpleYaml(yaml: string): Record<string, any> {
  const lines = yaml.split('\n');
  const out: Record<string, any> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  const stripQuotes = (s: string): string => {
    const t = s.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  };

  const coerce = (raw: string): any => {
    const v = stripQuotes(raw);
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '~' || v === '') return null;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  };

  for (const rawLine of lines) {
    // Skip blank lines and comments
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;

    // Block-list continuation: `  - item`
    const listItem = rawLine.match(/^\s*-\s+(.*)$/);
    if (listItem && currentKey && currentList) {
      currentList.push(stripQuotes(listItem[1]));
      continue;
    }

    // Key:value line
    const kv = rawLine.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const valuePart = kv[2];

    if (valuePart === '') {
      // Likely a block-list header
      currentKey = key;
      currentList = [];
      out[key] = currentList;
      continue;
    }

    // Inline array `[a, b, c]`
    const inlineArr = valuePart.match(/^\[(.*)\]$/);
    if (inlineArr) {
      out[key] = inlineArr[1]
        .split(',')
        .map((s) => stripQuotes(s))
        .filter((s) => s.length > 0);
      currentKey = null;
      currentList = null;
      continue;
    }

    out[key] = coerce(valuePart);
    currentKey = null;
    currentList = null;
  }

  return out;
}

/**
 * Parse a SKILL.md file's content and validate its frontmatter against SkillMetaSchema.
 * Throws a descriptive Error if the file is missing frontmatter or the metadata is invalid.
 */
export function parseSkillMd(content: string): SkillMeta {
  const fm = extractFrontmatter(content);
  if (!fm) {
    throw new Error(
      'SKILL.md is missing a YAML frontmatter block. Expected the file to start with a "---" delimited block containing `name` and `version`.',
    );
  }
  const raw = parseSimpleYaml(fm);
  return SkillMetaSchema.parse(raw);
}
