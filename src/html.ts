/**
 * Minimal Markdown → HTML converter. Azure DevOps stores rich-text fields
 * (System.Description) as HTML — raw Markdown renders as literal characters. This
 * covers the ticket body shape (headings, lists, checkboxes, bold, code,
 * paragraphs) and passes HTML comments through untouched so the canonical
 * `<!-- kodi:ticket … -->` marker survives the round-trip.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

export function mdToHtml(md: string): string {
  const out: string[] = [];
  let list: 'ul' | null = null;
  const closeList = () => {
    if (list) {
      out.push('</ul>');
      list = null;
    }
  };

  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();

    // Pass HTML comments (the kodi marker) through verbatim.
    if (/^<!--/.test(line.trim())) {
      closeList();
      out.push(line);
      continue;
    }
    if (line.trim() === '') {
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (!list) {
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}
