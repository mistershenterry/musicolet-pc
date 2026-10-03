// Small, safe Markdown renderer for the bulletin board. All text is escaped first, so the file can't
// inject HTML. Supports: # headings, paragraphs, - / * / 1. lists, - [ ] / - [x] checkboxes,
// **bold**, *italic*, `code`, [links](https://...), --- rules and <!-- comments --> (hidden).
const Markdown = {
  inline(s) {
    return escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`);
  },

  render(text) {
    const lines = String(text || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\r/g, '').split('\n');
    const out = [];
    let para = [];
    let list = null; // { tag, items: [] }
    const flushPara = () => {
      if (para.length) out.push(`<p>${this.inline(para.join(' '))}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`);
      list = null;
    };
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.trim()) {
        flushPara();
        flushList();
        continue;
      }
      let m;
      if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
        flushPara();
        flushList();
        const level = m[1].length + 2; // # -> h3, ## -> h4, ### -> h5 (the dialog already has h2/h3)
        out.push(`<h${level}>${this.inline(m[2])}</h${level}>`);
      } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        flushPara();
        flushList();
        out.push('<hr>');
      } else if ((m = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line))) {
        flushPara();
        const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(m[2]);
        if (task) {
          const done = task[1].toLowerCase() === 'x';
          list.items.push(`<li class="task${done ? ' done' : ''}"><span class="check">${done ? '✓' : ''}</span><span>${this.inline(task[2])}</span></li>`);
        } else {
          list.items.push(`<li>${this.inline(m[2])}</li>`);
        }
      } else if (list && /^\s{2,}\S/.test(raw)) {
        // Indented line right after a list item: it continues that item.
        const last = list.items.length - 1;
        list.items[last] = list.items[last].replace(/(<\/span>)?<\/li>$/, (end) => ' ' + this.inline(line.trim()) + end);
      } else {
        flushList();
        para.push(line.trim());
      }
    }
    flushPara();
    flushList();
    return out.join('');
  },
};
