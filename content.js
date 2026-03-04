// Ensure the script only runs after the page is safely loaded
function initExtension() {
  
  // 1. Inject the font using a STABLE CDN (Fontsource via jsDelivr)
  // This avoids Google Fonts' rotating URL issues.
  const style = document.createElement('style');
  style.textContent = `
    @font-face {
      font-family: 'JB-Subset';
      src: url('https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-400-normal.woff2') format('woff2');
      unicode-range: U+0049, U+006C, U+0031, U+0030, U+007C; /* I, l, 1, 0, | */
      font-display: swap;
    }
  `;
  document.head.appendChild(style);

  // 2. Safely apply the font to the parent element (React-safe!)
  function fixParentNode(textNode) {
    const parent = textNode.parentElement;
    // Skip if it's already fixed or doesn't exist
    if (!parent || parent.dataset.jbFixed) return;

    // Ignore icons, scripts, and SVGs so we don't break UI elements
    const ignoreTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'I', 'SVG', 'CODE'];
    if (ignoreTags.includes(parent.tagName)) return;

    // Get the exact font this element is ALREADY using
    const currentFont = window.getComputedStyle(parent).fontFamily;
    
    // Prevent redundant processing
    if (currentFont.includes('JB-Subset')) {
      parent.dataset.jbFixed = "true";
      return;
    }

    // PREPEND our subset font to the element's inline style.
    // The browser uses JB-Subset for the 5 characters, and falls back to the original font for the rest!
    parent.style.setProperty('font-family', `'JB-Subset', ${currentFont}`, 'important');
    parent.dataset.jbFixed = "true";
  }

  // 3. Ultra-fast TreeWalker to scan the DOM without recursion lag
  function scanNode(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (/[Il1|0]/.test(textNode.nodeValue)) {
        fixParentNode(textNode);
      }
    }
  }

  // 4. Observer to catch new WhatsApp messages dynamically
  const observer = new MutationObserver((mutations) => {
    // Use requestIdleCallback to process changes ONLY when the browser isn't busy.
    // This entirely eliminates the lag/thrashing issue.
    const scheduler = window.requestIdleCallback || window.requestAnimationFrame;
    scheduler(() => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) scanNode(node);
            else if (node.nodeType === Node.TEXT_NODE && /[Il1|0]/.test(node.nodeValue)) fixParentNode(node);
          });
        } else if (mutation.type === 'characterData') {
          // Catches text that changes without generating a new HTML element
          if (/[Il1|0]/.test(mutation.target.nodeValue)) fixParentNode(mutation.target);
        }
      }
    });
  });

  // Start observing page changes
  observer.observe(document.body, { 
    childList: true, 
    subtree: true, 
    characterData: true 
  });

  // Initial page scan
  scanNode(document.body);
}

// Boot up safely to prevent 'document.body is null' crashes
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initExtension);
} else {
  initExtension();
}