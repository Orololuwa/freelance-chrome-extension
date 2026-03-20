// content.js — Runs on all Freelancer pages

// Listen for scan requests from background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'SCRAPE_PROJECTS') {
    const projects = scrapeProjects();
    sendResponse({ projects });
  }
});

function scrapeProjects() {
  const projects = [];
  const seen = new Set();

  // Try multiple selector patterns Freelancer has used
  const selectors = [
    '[data-project-id]',
    '.JobSearchResult',
    '.project-item',
    '.search-result-item',
    'article[class*="project"]',
    '[class*="JobSearchResult"]',
    'li[class*="project"]'
  ];

  let items = [];
  for (const sel of selectors) {
    const found = document.querySelectorAll(sel);
    if (found.length > 0) {
      items = Array.from(found);
      break;
    }
  }

  items.forEach(item => {
    try {
      const linkEl = item.querySelector('a[href*="/projects/"]');
      if (!linkEl) return;

      const url = linkEl.href;
      if (seen.has(url)) return;
      seen.add(url);

      const titleEl = item.querySelector('h2, h3, [class*="title"] a, [class*="name"] a') || linkEl;
      const descEl = item.querySelector('p, [class*="description"], [class*="desc"]');
      const budgetEl = item.querySelector('[class*="budget"], [class*="amount"], [class*="price"]');
      const skillEls = item.querySelectorAll('[class*="skill"] a, [class*="tag"] a, .skills a');

      projects.push({
        id: url,
        url,
        title: titleEl?.textContent?.trim() || 'Untitled',
        description: descEl?.textContent?.trim()?.slice(0, 600) || '',
        budget: budgetEl?.textContent?.trim() || 'N/A',
        tags: Array.from(skillEls).map(el => el.textContent.trim()).filter(Boolean)
      });
    } catch (e) {}
  });

  return projects;
}
