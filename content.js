// Character disambiguator: puts a 5-glyph font subset (I l 1 0 |) in front of
// each element's own font stack, so those characters are distinguishable while
// everything else keeps the site's typography.
//
// Perf contract for large SPA DOMs (Gmail: ~30k nodes, mutations every frame):
//   * never read computed style between style writes -> one recalc per chunk, not per element
//   * one coalesced, time-budgeted idle task         -> no backlog of full subtree scans
//   * no data-* bookkeeping on the host's elements   -> less for its observers to react to

(() => {
  'use strict';

  if (window.__charDisambiguator) return;
  window.__charDisambiguator = true;

  const TARGETS = /[Il1|0]/;

  // SVG and MathML elements report tagName in their authored case, hence the
  // lowercase entries. TEXTAREA/PRE/CODE are left alone on purpose.
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TITLE', 'TEMPLATE', 'TEXTAREA', 'CODE', 'PRE',
    'svg', 'math',
  ]);

  // Ligature icon fonts render "delete" or "close" as a single glyph. Stealing
  // their l/1/0/I breaks the ligature and leaks the literal word onto the page.
  const ICON_FONT = /icon|symbols|glyph|material|fontawesome|\bfa\b/i;

  const BUDGET_MS = 6;     // fallback slice when requestIdleCallback is absent
  const CHUNK = 400;       // elements per read/write pair
  const MAX_QUEUE = 512;   // past this, one body-wide pass beats N subtree walks

  const FONT_FILE = 'fonts/jetbrains-mono-latin-400-normal.woff2';
  const FONT_CDN = 'https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-400-normal.woff2';

  const handled = new WeakSet();
  const queue = [];
  const classes = new Map();   // font stack -> generated class name (or null)

  let walker = null;
  let sheet = null;
  let scheduled = false;
  let rescanQueued = false;

  // Readable from the console as __charDisambiguatorStats: tells apart "the DOM
  // pass never ran" (styled === 0) from "the font never loaded" (styled > 0 but
  // nothing looks different).
  const stats = { styled: 0, skippedIconFont: 0, inherited: 0 };
  window.__charDisambiguatorStats = stats;

  function injectFontFace() {
    // Two sources, tried in order. The bundled copy dodges the page's font-src
    // CSP (which blocks CDN fonts on Gmail and most Google properties); the CDN
    // keeps the extension working before the woff2 is bundled. A src list falls
    // through on load failure, so neither one being absent is fatal.
    const sources = [];
    if (typeof chrome === 'object' && chrome.runtime && chrome.runtime.getURL) {
      sources.push(`url('${chrome.runtime.getURL(FONT_FILE)}') format('woff2')`);
    }
    sources.push(`url('${FONT_CDN}') format('woff2')`);

    const el = document.createElement('style');
    el.textContent = `@font-face{font-family:'JB-Subset';`
      + `src:${sources.join(',')};`
      + `unicode-range:U+0049,U+006C,U+0031,U+0030,U+007C;`
      + `font-display:swap}`;
    (document.head || document.documentElement).appendChild(el);
  }

  // A failed @font-face is silent - the page just keeps its original font and
  // nothing looks different. Say so out loud instead.
  function reportFontStatus() {
    if (!document.fonts || !document.fonts.load) return;
    document.fonts.load("400 16px 'JB-Subset'", 'Il1|0').then((faces) => {
      // Silent on success: this runs on every page on every site.
      if (!faces.length) console.warn('[char-disambiguator] JB-Subset matched no face — check the @font-face unicode-range.');
    }, (err) => {
      console.warn(
        `[char-disambiguator] JB-Subset failed to load, so no characters will change. `
        + `Check that "${FONT_FILE}" exists in the extension and is listed in `
        + `web_accessible_resources, and look for a CSP font-src violation above.`, err,
      );
    });
  }

  function ruleSheet() {
    if (!sheet) {
      const el = document.createElement('style');
      (document.head || document.documentElement).appendChild(el);
      sheet = el.sheet;
    }
    return sheet;
  }

  // One rule per distinct font stack - a handful of rules instead of tens of
  // thousands of unique inline declarations.
  function classFor(stack) {
    if (classes.has(stack)) return classes.get(stack);

    let cls = `jbs-${classes.size}`;
    try {
      const s = ruleSheet();
      s.insertRule(`.${cls}{font-family:'JB-Subset',${stack}!important}`, s.cssRules.length);
    } catch {
      cls = null;   // unparsable stack; the caller falls back to an inline style
    }
    classes.set(stack, cls);
    return cls;
  }

  const filter = {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return TARGETS.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
      // FILTER_REJECT on an element skips its whole subtree, so ignored
      // containers cost nothing instead of being walked and discarded.
      if (SKIP_TAGS.has(node.tagName) || node.isContentEditable) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_SKIP;
    },
  };

  // The walker filter is not applied to its own root, so roots get checked here.
  function inSkippedSubtree(el) {
    for (let n = el; n; n = n.parentElement) {
      if (SKIP_TAGS.has(n.tagName) || n.isContentEditable) return true;
    }
    return false;
  }

  function enqueue(node) {
    if (rescanQueued) return;

    if (queue.length >= MAX_QUEUE) {
      queue.length = 0;
      rescanQueued = true;
      queue.push(document.body);
    } else {
      queue.push(node);
    }
    schedule();
  }

  // Pulls up to CHUNK not-yet-handled elements, resuming the in-flight walker
  // across flushes so a huge subtree never blocks a single frame.
  function nextChunk() {
    const out = [];

    while (out.length < CHUNK) {
      if (!walker) {
        const root = queue.shift();
        if (!root) break;
        if (!root.isConnected) continue;

        if (root.nodeType === Node.TEXT_NODE) {
          const el = root.parentElement;
          if (el && !handled.has(el) && TARGETS.test(root.nodeValue) && !inSkippedSubtree(el)) {
            handled.add(el);
            out.push(el);
          }
          continue;
        }

        if (root.nodeType !== Node.ELEMENT_NODE || inSkippedSubtree(root)) continue;
        walker = document.createTreeWalker(
          root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, filter,
        );
      }

      const node = walker.nextNode();
      if (!node) { walker = null; continue; }

      const el = node.parentElement;
      if (el && !handled.has(el)) {
        handled.add(el);
        out.push(el);
      }
    }

    return out;
  }

  function apply(els) {
    // READ phase: no writes here, so the whole chunk costs one style recalc.
    const stacks = els.map((el) => (el.isConnected ? getComputedStyle(el).fontFamily : ''));

    // WRITE phase: no computed-style reads here, so nothing forces a recalc.
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const stack = stacks[i];

      if (!stack) { handled.delete(el); continue; }   // detached mid-chunk; retry if it returns
      if (stack.includes('JB-Subset')) { stats.inherited++; continue; }   // from a fixed ancestor
      if (ICON_FONT.test(stack)) { stats.skippedIconFont++; continue; }

      const cls = classFor(stack);
      if (cls) el.classList.add(cls);
      else el.style.setProperty('font-family', `'JB-Subset', ${stack}`, 'important');
      stats.styled++;
    }
  }

  function flush(deadline) {
    scheduled = false;
    rescanQueued = false;

    const start = performance.now();
    const hasTime = () => (deadline && deadline.timeRemaining
      ? deadline.timeRemaining() > 1
      : performance.now() - start < BUDGET_MS);

    while (hasTime()) {
      const chunk = nextChunk();
      if (!chunk.length) return;
      apply(chunk);
    }

    if (walker || queue.length) schedule();   // hand the frame back, finish next idle period
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;

    if (window.requestIdleCallback) requestIdleCallback(flush, { timeout: 250 });
    else setTimeout(flush, 16);
  }

  // Stays cheap: queue work, never touch style here.
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) {
          if (n.nodeType === Node.ELEMENT_NODE) enqueue(n);
          else if (n.nodeType === Node.TEXT_NODE && TARGETS.test(n.nodeValue)) enqueue(n);
        }
      } else if (r.type === 'characterData' && TARGETS.test(r.target.nodeValue)) {
        enqueue(r.target);
      }
    }
  });

  function start() {
    injectFontFace();
    reportFontStatus();
    enqueue(document.body);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
