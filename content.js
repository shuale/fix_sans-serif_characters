// 1. Inject the font into the head of the page
const fontLink = document.createElement('link');
fontLink.rel = 'stylesheet';
fontLink.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&display=swap';
document.head.appendChild(fontLink);

const style = document.createElement('style');
style.textContent = `
  input, textarea { font-family: 'JetBrains Mono', monospace !important; }
  .jb-fix { 
    font-family: 'JetBrains Mono', monospace !important; 
    font-weight: inherit !important;
    color: inherit !important;
    font-style: inherit !important;
  }
`;
document.head.appendChild(style);

/**
 * Function to wrap specific characters in a styled span
 */
function fixCharacters(node) {
  // Ignore specific tags to avoid breaking the site's functionality
  const ignoreTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE'];
  if (ignoreTags.includes(node.parentElement?.tagName)) return;
  
  // Skip if we've already processed this or it's inside an editable field
  if (node.parentElement?.classList.contains('jb-fix') || node.parentElement?.closest('[contenteditable="true"]')) return;

  // Process text nodes that contain l, I, 1, |, or 0
  if (node.nodeType === Node.TEXT_NODE && /[Il1|0]/.test(node.nodeValue)) {
    const span = document.createElement('span');
    span.className = 'jb-fix-container';
    
    // Replace characters with a span that forces JetBrains Mono
    // We use font-weight: 700 (Bold) to make them stand out even more
    span.innerHTML = node.nodeValue.replace(/([Il1|0])/g, '<span class="jb-fix">$1</span>');
    
    node.replaceWith(span);
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    // Recursively check children
    Array.from(node.childNodes).forEach(fixCharacters);
  }
}

// 2. Initial run when the script loads
fixCharacters(document.body);

// 3. MutationObserver to handle dynamic content (Facebook, YouTube, etc.)
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    mutation.addedNodes.forEach(node => {
      // Small delay to let the site finish rendering its own changes
      setTimeout(() => fixCharacters(node), 10);
    });
  }
});

observer.observe(document.body, { childList: true, subtree: true });