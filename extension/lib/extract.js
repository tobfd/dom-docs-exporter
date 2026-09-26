/**
 * Runs inside the page via chrome.scripting.executeScript({ func: extractPage }).
 * The function is serialized, so it must NOT reference anything outside its own body.
 *
 * @returns {{ title: string, url: string, content: string, ext: string, mime: string }}
 */
export function extractPage({ type = 'docs', docsFormat = 'md', domClean = {} } = {}) {
  const meta = {
    title: (document.title || location.hostname || 'page').trim(),
    url: location.href,
  };

  if (type === 'dom') {
    return { ...meta, content: cleanDom(), ext: 'html', mime: 'text/html' };
  }

  const root = pickRoot();
  if (docsFormat === 'txt') {
    return { ...meta, content: root.innerText.trim(), ext: 'txt', mime: 'text/plain' };
  }
  return { ...meta, content: toMarkdown(root), ext: 'md', mime: 'text/markdown' };

  // ---------------------------------------------------------------- DOM

  function cleanDom() {
    const clone = document.documentElement.cloneNode(true);

    const drop = ['script', 'style', 'svg', 'iframe', 'noscript'];
    if (domClean.linkMeta) drop.push('link', 'meta', 'template');
    clone.querySelectorAll(drop.join(',')).forEach((el) => el.remove());

    if (domClean.comments) {
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
      const comments = [];
      while (walker.nextNode()) comments.push(walker.currentNode);
      comments.forEach((c) => c.remove());
    }

    for (const el of [clone, ...clone.querySelectorAll('*')]) {
      for (const { name, value } of [...el.attributes]) {
        if ((domClean.styleAttrs && name === 'style') ||
            (domClean.dataAttrs && name.startsWith('data-'))) {
          el.removeAttribute(name);
        } else if (domClean.base64 && /^\s*data:/i.test(value)) {
          el.setAttribute(name, 'data:…');
        }
      }
    }

    if (domClean.whitespace) {
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      const empty = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement?.closest('pre, textarea')) continue;
        if (node.nodeValue.trim()) node.nodeValue = node.nodeValue.replace(/\s+/g, ' ');
        else if (node.nodeValue.includes('\n')) empty.push(node); // indentation between tags
        else node.nodeValue = ' ';                                // meaningful space between inline tags
      }
      empty.forEach((n) => n.remove());
    }

    return '<!DOCTYPE html>\n' + clone.outerHTML;
  }

  // --------------------------------------------------------------- Docs

  function pickRoot() {
    const main = document.querySelector('main, [role="main"]');
    const articles = (main || document).querySelectorAll('article');
    if (articles.length === 1) return articles[0];
    return main || articles[0] || document.body;
  }

  function toMarkdown(root) {
    const clone = root.cloneNode(true);

    // Parallel walk over live page + clone (same order) before mutating the clone:
    // drop what the user can't see, remember rendered text of <pre> blocks,
    // pull in open shadow DOM of web components without light DOM (e.g. MDN code examples).
    const live = root.querySelectorAll('*');
    const copy = clone.querySelectorAll('*');
    const hidden = [];
    const preText = new Map();
    for (let i = 0; i < live.length; i++) {
      const el = live[i];
      if (el.tagName === 'PRE') preText.set(copy[i], el.innerText);
      if (el.shadowRoot && !el.childNodes.length) {
        copy[i].append(...[...el.shadowRoot.childNodes].map((n) => n.cloneNode(true)));
      }
      if (el.checkVisibility && !el.checkVisibility() &&
          !el.closest('details:not([open])') &&
          getComputedStyle(el).display !== 'contents') {
        hidden.push(copy[i]);
      }
    }
    hidden.forEach((el) => el.remove());

    clone.querySelectorAll(
      'script, style, noscript, template, svg, iframe, canvas, nav, aside, footer, ' +
      'button, input, select, textarea, [aria-hidden="true"], [role="navigation"]'
    ).forEach((el) => el.remove());
    clone.querySelectorAll('header').forEach((h) => {
      if (!h.querySelector('h1, h2')) h.remove();
    });

    const BLOCK = new Set([
      'address', 'article', 'aside', 'center', 'details', 'dialog', 'div', 'dl', 'fieldset',
      'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'li', 'main', 'nav', 'section',
    ]);
    const INLINE = new Set([
      'a', 'abbr', 'b', 'cite', 'code', 'del', 'em', 'font', 'i', 'kbd', 'label', 'mark', 'q',
      's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u',
    ]);
    const codeBlocks = [];

    let md = children(clone, {})
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Restore code blocks (kept out of whitespace cleanup), honoring list/quote indentation.
    md = md.replace(/^([ \t>]*)\u0000(\d+)\u0000$/gm, (_, pad, i) =>
      codeBlocks[i].split('\n').map((line) => pad + line).join('\n'));
    return md.replace(/\u0000(\d+)\u0000/g, (_, i) => codeBlocks[i]);

    function children(node, ctx) {
      const inline = INLINE.has(node.nodeName.toLowerCase());
      let out = '';
      for (const child of node.childNodes) {
        let part = conv(child, ctx);
        if (child.nodeType === Node.TEXT_NODE && ((out === '' && !inline) || out.endsWith('\n'))) {
          part = part.trimStart();
        }
        out += part;
      }
      return out;
    }

    function conv(node, ctx) {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, ' ');
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();
      switch (tag) {
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
          const text = children(node, { ...ctx, noLinks: true }).replace(/\s+/g, ' ').trim();
          if (!text) return '';
          if (ctx.table) return `**${text}**`;
          return `\n\n${'#'.repeat(Number(tag[1]))} ${text}\n\n`;
        }
        case 'p':
          return `\n\n${children(node, ctx).trim()}\n\n`;
        case 'br':
          return ctx.table ? ' ' : '\n';
        case 'hr':
          return '\n\n---\n\n';
        case 'strong': case 'b':
          return wrap('**', children(node, ctx));
        case 'em': case 'i':
          return wrap('*', children(node, ctx));
        case 's': case 'del': case 'strike':
          return wrap('~~', children(node, ctx));
        case 'code': case 'kbd': case 'samp': case 'tt':
          return inlineCode(node.textContent);
        case 'pre':
          return pre(node, ctx);
        case 'a':
          return link(node, ctx);
        case 'img':
          return image(node);
        case 'ul': case 'ol':
          return list(node, ctx);
        case 'blockquote': {
          const text = children(node, ctx).replace(/\n{3,}/g, '\n\n').trim();
          if (!text) return '';
          return `\n\n${text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}\n\n`;
        }
        case 'table':
          return table(node, ctx);
        case 'dt':
          return `\n\n**${children(node, ctx).trim()}**\n`;
        case 'dd':
          return `\n${children(node, ctx).trim()}\n`;
        case 'summary':
          return `\n\n**${children(node, ctx).trim()}**\n\n`;
        default:
          return BLOCK.has(tag) ? `\n\n${children(node, ctx)}\n\n` : children(node, ctx);
      }
    }

    function wrap(mark, text) {
      const trimmed = text.trim();
      if (!trimmed) return text;
      const lead = text.match(/^\s*/)[0];
      const trail = text.match(/\s*$/)[0];
      return `${lead}${mark}${trimmed}${mark}${trail}`;
    }

    function inlineCode(raw) {
      const text = raw.replace(/\s+/g, ' ');
      if (!text.trim()) return text;
      return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
    }

    function pre(node, ctx) {
      let text = node.textContent;
      const rendered = preText.get(node);
      // Some highlighters render one element per line without newline characters.
      if (!text.includes('\n') && rendered?.includes('\n')) text = rendered;
      text = text.replace(/^\n+|\s+$/g, '');
      if (!text) return '';
      if (ctx.table) return inlineCode(text);

      const hints = [node, ...node.querySelectorAll('code'), node.parentElement]
        .filter(Boolean)
        .map((el) => [
          el.getAttribute('class'), el.getAttribute('data-language'), el.getAttribute('data-lang'),
        ].filter(Boolean).join(' '))
        .join(' ');
      const lang = (
        node.getAttribute('data-language') ||
        node.getAttribute('syntax') ||
        node.querySelector('code')?.getAttribute('data-lang') ||
        (hints.match(/(?:language|lang|highlight-source|highlight)-([\w+#.-]+)/i) || [])[1] ||
        (hints.match(/brush:\s*([\w+#.-]+)/i) || [])[1] ||
        ''
      ).toLowerCase();

      const longestTicks = Math.max(0, ...(text.match(/`+/g) || []).map((m) => m.length));
      const fence = '`'.repeat(Math.max(3, longestTicks + 1));
      codeBlocks.push(`${fence}${lang}\n${text}\n${fence}`);
      return `\n\n\u0000${codeBlocks.length - 1}\u0000\n\n`;
    }

    function link(node, ctx) {
      const text = children(node, ctx);
      const label = text.replace(/\s+/g, ' ').trim();
      const href = node.getAttribute('href');
      if (!label) return text;
      if (/^[#¶§🔗\s]+$/u.test(label)) return ''; // heading permalink icons
      if (ctx.noLinks || !href || /^(javascript:|#$)/i.test(href) || text.includes('\n')) return text;
      const lead = /^\s/.test(text) ? ' ' : '';
      const trail = /\s$/.test(text) ? ' ' : '';
      return `${lead}[${label}](${abs(href)})${trail}`;
    }

    function image(node) {
      let src = node.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) src = node.getAttribute('data-src') || '';
      const alt = (node.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
      if (!src || src.startsWith('data:')) return alt;
      return `![${alt}](${abs(src)})`;
    }

    function list(node, ctx) {
      const ordered = node.tagName === 'OL';
      let n = parseInt(node.getAttribute('start'), 10) || 1;
      const items = [];
      for (const li of node.children) {
        if (li.tagName !== 'LI') continue;
        const marker = ordered ? `${n++}. ` : '- ';
        const pad = ' '.repeat(marker.length);
        const body = children(li, ctx)
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{2,}/g, '\n')
          .trim();
        items.push(marker + body.split('\n').map((l, i) => (i && l ? pad + l : l)).join('\n'));
      }
      return items.length ? `\n\n${items.join('\n')}\n\n` : '';
    }

    function table(node, ctx) {
      const grid = [...node.rows].map((tr) =>
        [...tr.cells].map((cell) =>
          escapePipes(children(cell, { ...ctx, table: true }).replace(/\s+/g, ' ').trim())));
      const cols = Math.max(0, ...grid.map((r) => r.length));
      if (!cols) return '';
      const line = (r) => `| ${Array.from({ length: cols }, (_, i) => r[i] ?? '').join(' | ')} |`;
      const [head, ...body] = grid;
      return `\n\n${[line(head), `|${' --- |'.repeat(cols)}`, ...body.map(line)].join('\n')}\n\n`;
    }

    // A "|" inside a cell must be written as "\|". Backslashes right before it are doubled
    // first, otherwise "\|" in the text would become "\\|" = literal backslash + column break.
    // Other backslashes stay as they are so code like `C:\Users` isn't altered.
    function escapePipes(text) {
      return text.replace(/(\\*)\|/g, (_, slashes) => `${slashes}${slashes}\\|`);
    }

    function abs(url) {
      try {
        return new URL(url, document.baseURI).href;
      } catch {
        return url;
      }
    }
  }
}
