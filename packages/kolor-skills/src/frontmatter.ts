/**
 * Minimal YAML-subset parser for SKILL.md frontmatter.
 *
 * Claude skills use a handful of scalar fields (`name`, `description`,
 * `allowed-tools`, ...), sometimes written as `>` / `|` blocks. That is the
 * whole surface supported here; nested mappings are ignored.
 */
export interface ParsedSkillMarkdown {
  frontmatter: Record<string, string>;
  body: string;
}

export function parseSkillMarkdown(source: string): ParsedSkillMarkdown {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (lines[0] !== '---') return { frontmatter: {}, body: text };

  let closing = -1;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index] === '---') {
      closing = index;
      break;
    }
  }
  if (closing === -1) return { frontmatter: {}, body: text };

  return {
    frontmatter: parseScalars(lines.slice(1, closing)),
    body: lines.slice(closing + 1).join('\n').replace(/^\n/, ''),
  };
}

function parseScalars(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] as string;
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      index += 1;
      continue;
    }
    if (/^\s/.test(line)) {
      // Continuation of an unsupported/nested value; ignore.
      index += 1;
      continue;
    }

    const match = /^([A-Za-z0-9_.-]+):(.*)$/.exec(line);
    if (match === null) {
      index += 1;
      continue;
    }
    const key = match[1] as string;
    const raw = match[2]?.trim() ?? '';
    index += 1;

    if (/^[|>][+-]?$/.test(raw)) {
      const block: string[] = [];
      while (index < lines.length && (lines[index] === '' || /^\s/.test(lines[index] as string))) {
        block.push(lines[index] as string);
        index += 1;
      }
      while (block.length > 0 && (block.at(-1) as string).trim() === '') block.pop();

      const indents = block
        .filter((entry) => entry.trim() !== '')
        .map((entry) => (/^\s*/.exec(entry)?.[0].length ?? 0));
      const indent = indents.length > 0 ? Math.min(...indents) : 0;
      const stripped = block.map((entry) => entry.slice(indent));
      out[key] = raw.startsWith('>')
        ? stripped.join(' ').replace(/\s+/g, ' ').trim()
        : stripped.join('\n').trim();
      continue;
    }

    if (
      (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
      (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
    ) {
      const inner = raw.slice(1, -1);
      out[key] = raw.startsWith('"')
        ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
        : inner.replace(/''/g, "'");
      continue;
    }

    // Plain scalar with indented continuation lines.
    const parts = [raw];
    while (index < lines.length && /^\s+\S/.test(lines[index] as string)) {
      parts.push((lines[index] as string).trim());
      index += 1;
    }
    out[key] = parts.join(' ').trim();
  }

  return out;
}
