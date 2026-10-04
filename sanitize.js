// Rich-text sanitizer for PM remarks, reviews, and human review notes.
// Allowlist policy: code, strong, em, b, i, br, p, a[href|title]. Plain text is escaped.
// Applied at render time (RichText) and on import (sanitizePhaseData).

window.khiraSanitize = (function () {
  const ALLOWED_TAGS = new Set(['code', 'strong', 'em', 'b', 'i', 'br', 'p', 'a']);
  const ALLOWED_ATTRS = {
    a: new Set(['href', 'title']),
  };
  const SAFE_HREF =
    /^(?:https?:|mailto:|#|\/|\.\/|\.\.\/)[^\s]*$/i;

  function escapeText(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function stripDangerousBlocks(html) {
    return String(html)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script\b[^>]*\/?>/gi, '')
      .replace(/<style\b[^>]*\/?>/gi, '');
  }

  // Quote-aware tag parser. Returns null when src does not start a well-formed
  // tag at `start` (the caller then treats '<' as literal text). Unlike the
  // previous regex scan, attribute values may safely contain '>'.
  function parseTagAt(src, start) {
    const n = src.length;
    let j = start + 1;
    const isClosing = src[j] === '/';
    if (isClosing) j++;
    const nameStart = j;
    while (j < n && /[a-zA-Z0-9]/.test(src[j])) j++;
    const name = src.slice(nameStart, j);
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) return null;

    const attrs = {};
    let selfClose = false;

    if (isClosing) {
      // Closing tags carry no attributes we honor; scan to the closing '>'.
      while (j < n && src[j] !== '>') j++;
      if (j >= n) return null;
      return { name: name.toLowerCase(), isClosing, selfClose: false, attrs, next: j + 1 };
    }

    while (j < n) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) return null; // unterminated tag
      if (src[j] === '>') { j++; break; }
      if (src[j] === '/') {
        if (src[j + 1] === '>') { selfClose = true; j += 2; break; }
        j++;
        continue;
      }
      const nameStart2 = j;
      while (j < n && !/[\s=/>]/.test(src[j])) j++;
      const attrName = src.slice(nameStart2, j);
      if (!attrName) { j++; continue; }
      let value = '';
      let k = j;
      while (k < n && /\s/.test(src[k])) k++;
      if (src[k] === '=') {
        k++;
        while (k < n && /\s/.test(src[k])) k++;
        const q = src[k];
        if (q === '"' || q === "'") {
          k++;
          const vStart = k;
          while (k < n && src[k] !== q) k++;
          if (k >= n) return null; // unterminated quote
          value = src.slice(vStart, k);
          k++;
        } else {
          const vStart = k;
          while (k < n && !/[\s>]/.test(src[k])) k++;
          value = src.slice(vStart, k);
        }
        j = k;
      }
      if (!attrName.toLowerCase().startsWith('on')) {
        attrs[attrName.toLowerCase()] = value;
      }
    }
    return { name: name.toLowerCase(), isClosing: false, selfClose, attrs, next: j };
  }

  function serializeAttrs(tag, attrs) {
    const allowed = ALLOWED_ATTRS[tag];
    if (!allowed) return '';
    let out = '';
    for (const [k, v] of Object.entries(attrs)) {
      if (!allowed.has(k)) continue;
      if (k === 'href') {
        const href = String(v).trim();
        if (!href || /^\s*javascript:/i.test(href) || /^\s*data:/i.test(href)) continue;
        if (!SAFE_HREF.test(href)) continue;
        out += ` href="${escapeText(href)}"`;
      } else if (k === 'title') {
        out += ` title="${escapeText(v)}"`;
      }
    }
    return out;
  }

  function sanitizeRichHtml(html) {
    if (html == null || html === '') return '';
    let src = stripDangerousBlocks(String(html));
    const out = [];
    const stack = [];
    let last = 0;
    let i = 0;

    while (i < src.length) {
      const lt = src.indexOf('<', i);
      if (lt === -1) break;
      const tag = parseTagAt(src, lt);
      if (!tag) { i = lt + 1; continue; }

      if (lt > last) out.push(escapeText(src.slice(last, lt)));
      last = tag.next;
      i = tag.next;

      if (tag.isClosing) {
        if (ALLOWED_TAGS.has(tag.name)) {
          while (stack.length && stack[stack.length - 1] !== tag.name) {
            out.push(`</${stack.pop()}>`);
          }
          if (stack.length && stack[stack.length - 1] === tag.name) {
            stack.pop();
            out.push(`</${tag.name}>`);
          }
        }
        continue;
      }

      if (!ALLOWED_TAGS.has(tag.name)) continue;

      // Only void elements may self-close in HTML output; every other open tag
      // must push the stack so a matching close is always emitted. Otherwise
      // `<em/>x` serializes as `<em />x`, which browsers parse as an unclosed
      // <em> and everything after it renders italic.
      const isVoid = tag.name === 'br';
      out.push(`<${tag.name}${serializeAttrs(tag.name, tag.attrs)}${isVoid ? ' /' : ''}>`);
      if (!isVoid) stack.push(tag.name);
    }

    if (last < src.length) out.push(escapeText(src.slice(last)));
    while (stack.length) out.push(`</${stack.pop()}>`);
    return out.join('');
  }

  function sanitizeReview(r) {
    if (!r || typeof r !== 'object') return r;
    const next = { ...r };
    if (typeof next.text === 'string') next.text = sanitizeRichHtml(next.text);
    return next;
  }

  function sanitizeTask(task) {
    if (!task || typeof task !== 'object') return task;
    const next = { ...task };
    if (typeof next.pm_remark === 'string') {
      next.pm_remark = sanitizeRichHtml(next.pm_remark);
    }
    if (Array.isArray(next.reviews)) {
      next.reviews = next.reviews.map(sanitizeReview);
    }
    if (Array.isArray(next.subtasks)) {
      next.subtasks = next.subtasks.map((sub) => {
        if (!sub || typeof sub !== 'object') return sub;
        const s = { ...sub };
        if (s.review) s.review = sanitizeReview(s.review);
        return s;
      });
    }
    return next;
  }

  function sanitizePhaseData(data) {
    if (!data || typeof data !== 'object') return data;
    const next = { ...data };
    if (Array.isArray(next.human_reviews)) {
      next.human_reviews = next.human_reviews.map((hr) => {
        if (!hr || typeof hr !== 'object') return hr;
        const h = { ...hr };
        if (typeof h.text === 'string') h.text = sanitizeRichHtml(h.text);
        return h;
      });
    }
    if (Array.isArray(next.tasks)) {
      next.tasks = next.tasks.map(sanitizeTask);
    }
    return next;
  }

  return {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    sanitizeRichHtml,
    sanitizePhaseData,
  };
})();
