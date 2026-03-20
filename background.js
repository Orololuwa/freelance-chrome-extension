// background.js — Service Worker

let isRunning = false;
let scanAlarmName = 'freelancer-scan';

/** Freelancer bid description limit — keep generated text within this. */
const PROPOSAL_MAX_CHARS = 1500;

function clampProposalText(text, maxLen = PROPOSAL_MAX_CHARS) {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  let cut = t.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.82) cut = cut.slice(0, lastSpace);
  return cut.trim();
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'START_AGENT') {
    isRunning = true;
    startAgent();
  }
  if (msg.action === 'STOP_AGENT') {
    isRunning = false;
    chrome.alarms.clear(scanAlarmName);
    log('Agent stopped.', 'warn');
  }
  if (msg.action === 'CONTENT_PROJECTS') {
    handleProjects(msg.projects, msg.debug);
  }
});

// Restore state on service worker restart
chrome.storage.local.get('isRunning', data => {
  if (data.isRunning) {
    isRunning = true;
    startAgent();
  }
});

// Alarm fires each scan interval
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === scanAlarmName && isRunning) {
    triggerScan();
  }
});

async function startAgent() {
  chrome.storage.local.get('scanInterval', data => {
    const interval = data.scanInterval || 5;
    chrome.alarms.clear(scanAlarmName, () => {
      chrome.alarms.create(scanAlarmName, {
        delayInMinutes: 0.1, // first scan in 6 seconds
        periodInMinutes: interval
      });
    });
  });
  log('Agent started. First scan in ~6 seconds...', 'success');
}

async function triggerScan() {
  log('Scanning Freelancer for new projects...', 'info');

  const config = await getConfig();
  const SEARCH_URL = config.searchUrl || 'https://www.freelancer.com/jobs/';

  // Always open/navigate to a fresh search page
  const allTabs = await chrome.tabs.query({ url: 'https://www.freelancer.com/*' });
  let tab = allTabs.find(t => t.url && (t.url.includes('/jobs') || t.url.includes('/search/')));

  if (!tab) {
    tab = await chrome.tabs.create({ url: SEARCH_URL, active: false });
  } else {
    await chrome.tabs.update(tab.id, { url: SEARCH_URL });
  }

  await waitForTabLoad(tab.id);
  await injectScan(tab.id);
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        // Angular needs extra time after DOM-ready to render job cards
        setTimeout(resolve, 4000);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    // Safety timeout: resolve after 20s regardless
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 20000);
  });
}

async function injectScan(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: scanFreelancerPage
    });
  } catch (e) {
    log(`Scan injection failed: ${e.message}`, 'error');
    incrementStat('errors');
  }
}

// This function runs in the page context — waits for Angular to render
function scanFreelancerPage() {
  return new Promise((resolve) => {
    const MAX_WAIT_MS = 15000;
    const CHECK_INTERVAL = 600;
    let elapsed = 0;

    function extractProjects() {
      const projects = [];
      const seen = new Set();

      // ── Get all /projects/ links on page ──
      const allProjectLinks = Array.from(document.querySelectorAll('a[href*="/projects/"]'))
        .filter(a => {
          const href = a.href || '';
          // Must look like a real project URL, not a category/browse link
          return /\/projects\/[^/]+\/[^/]+/.test(href) && a.textContent.trim().length > 3;
        });

      if (allProjectLinks.length === 0) return projects;

      // ── Find the lowest common repeating ancestor ──
      // The key insight: all project cards share the same parent container.
      // Find the ancestor that contains exactly one /projects/ link per child.
      function findCardContainer(links) {
        if (links.length < 2) return null;

        // Walk up from the first link until we find a parent whose
        // direct children each contain one project link
        let candidate = links[0].parentElement;
        for (let depth = 0; depth < 15; depth++) {
          if (!candidate || candidate === document.body) break;
          const parent = candidate.parentElement;
          if (!parent) break;

          // Count how many of our project links fall under each direct child of parent
          const children = Array.from(parent.children);
          const childLinkCounts = children.map(child =>
            links.filter(l => child.contains(l)).length
          );

          // Good container: most children have exactly 1 project link, and there are many children
          const childrenWithOneLink = childLinkCounts.filter(c => c === 1).length;
          if (childrenWithOneLink >= Math.min(links.length * 0.7, 5)) {
            return { container: parent, cards: children.filter((_, i) => childLinkCounts[i] >= 1) };
          }

          candidate = parent;
        }
        return null;
      }

      const result = findCardContainer(allProjectLinks);

      if (result && result.cards.length > 0) {
        // ── Extract from discovered card elements ──
        result.cards.forEach(card => {
          try {
            const linkEl = card.querySelector('a[href*="/projects/"]');
            if (!linkEl) return;
            const url = linkEl.href;
            if (!url || seen.has(url)) return;
            seen.add(url);

            // Title: longest text in an anchor or heading
            const headingEl = card.querySelector('h1,h2,h3,h4,h5') ||
              Array.from(card.querySelectorAll('a[href*="/projects/"]'))
                .sort((a, b) => b.textContent.length - a.textContent.length)[0];

            // Description: longest <p> or span that isn't a tag/budget
            const allText = Array.from(card.querySelectorAll('p, [class*="desc"], [class*="detail"]'));
            const descEl = allText.sort((a, b) => b.textContent.length - a.textContent.length)[0];

            // Budget: look for $ signs
            const allSpans = Array.from(card.querySelectorAll('*'));
            const budgetEl = allSpans.find(el =>
              el.children.length === 0 && /\$[\d,]+/.test(el.textContent)
            );

            // Tags: short text nodes that look like skill names
            const tagEls = card.querySelectorAll('[class*="skill"], [class*="tag"], [class*="label"], fl-tag, app-tag');

            projects.push({
              id: url,
              url,
              title: (headingEl?.textContent || linkEl.textContent).trim().slice(0, 200),
              description: (descEl?.textContent || '').trim().slice(0, 600),
              budget: budgetEl ? budgetEl.textContent.trim() : 'N/A',
              tags: Array.from(tagEls).map(el => el.textContent.trim()).filter(t => t.length > 1 && t.length < 40)
            });
          } catch(e) {}
        });
      } else {
        // ── Fallback: just use the links directly ──
        allProjectLinks.forEach(link => {
          const url = link.href;
          if (seen.has(url)) return;
          seen.add(url);

          // Try to grab nearby text as description
          const parent = link.closest('li, div, article, section') || link.parentElement;
          const allText = parent ? parent.textContent.replace(link.textContent, '').trim() : '';

          projects.push({
            id: url,
            url,
            title: link.textContent.trim().slice(0, 200),
            description: allText.slice(0, 600),
            budget: 'N/A',
            tags: []
          });
        });
      }

      return projects;
    }

    // Poll until we get results or time out
    function poll() {
      const projects = extractProjects();
      if (projects.length > 0) {
        chrome.runtime.sendMessage({ action: 'CONTENT_PROJECTS', projects });
        resolve(projects.length);
        return;
      }

      elapsed += CHECK_INTERVAL;
      if (elapsed >= MAX_WAIT_MS) {
        // Send empty but also send the page title so we can debug
        chrome.runtime.sendMessage({
          action: 'CONTENT_PROJECTS',
          projects: [],
          debug: {
            url: window.location.href,
            title: document.title,
            linkCount: document.querySelectorAll('a[href*="/projects/"]').length,
            bodyLength: document.body.innerText.length
          }
        });
        resolve(0);
        return;
      }

      setTimeout(poll, CHECK_INTERVAL);
    }

    poll();
  });
}

async function handleProjects(projects, debug) {
  if (!projects || projects.length === 0) {
    if (debug) {
      log(`No projects found. Page: "${debug.title}" | /projects/ links: ${debug.linkCount} | Body length: ${debug.bodyLength}`, 'warn');
      if (debug.linkCount > 0) {
        log(`Found ${debug.linkCount} project links but couldn't extract cards. Freelancer may have updated their UI.`, 'warn');
      } else {
        log(`No project links found at all. Make sure you're logged in to Freelancer.com.`, 'error');
      }
    } else {
      log('No projects found on page. Make sure you are logged in to Freelancer.com.', 'warn');
    }
    return;
  }

  log(`Found ${projects.length} projects. Filtering...`, 'info');
  incrementStat('scanned', projects.length);

  const config = await getConfig();
  const alreadyBid = config.bidHistory || {};

  // Filter projects
  const targets = projects.filter(p => {
    if (alreadyBid[p.id]) return false; // skip already bid
    if (!matchesCategory(p, config)) return false;
    const budget = parseBudget(p.budget);
    if (budget !== null) {
      if (budget < config.minBudget || budget > config.maxBudget) return false;
    }
    return true;
  });

  log(`${targets.length} new eligible projects after filtering.`, 'info');

  const processing = new Set();

  for (const project of targets) {
    if (!isRunning) break;
    if (processing.has(project.id)) continue;
    processing.add(project.id);
    await processProject(project, config);
    await sleep(3000 + Math.random() * 2000);
  }
}

async function processProject(project, config) {
  log(`Opening project page: "${project.title.slice(0, 50)}..."`, 'info');

  let tab;
  try {
    // Step 1: Open the project page first
    tab = await chrome.tabs.create({ url: project.url, active: false });
    await waitForTabLoad(tab.id);

    // Step 2: Scrape full details from the actual project page
    log(`Scraping full project details...`, 'info');
    const scraped = await scrapeProjectPage(tab.id);

    // Merge: project page data takes precedence over search page data
    const fullProject = {
      ...project,
      title:       scraped.title       || project.title,
      description: scraped.description || project.description,
      tags:        scraped.tags.length  ? scraped.tags : project.tags,
      budget:      scraped.budget       || project.budget,
      minBudget:   scraped.minBudget,
      maxBudget:   scraped.maxBudget,
      duration:    scraped.duration,
    };

    // Step 3: Determine bid amount — client's real budget takes precedence
    const clientBudget = fullProject.maxBudget || fullProject.minBudget || parseBudget(fullProject.budget);
    const bidAmount = smartBidAmount(clientBudget, fullProject.minBudget, fullProject.maxBudget);

    log(`Full context ready. Budget: ${clientBudget ? '$' + clientBudget : 'N/A'}. Generating proposal...`, 'info');

    // Step 4: Generate proposal with full context
    const proposal = await generateProposal(fullProject, config, bidAmount, clientBudget);
    if (!proposal) {
      log(`Proposal generation failed for: ${fullProject.title.slice(0, 40)}`, 'error');
      incrementStat('errors');
      return;
    }

    const autoSubmit = config.autoSubmit !== false;

    if (autoSubmit) {
      log(`Submitting bid ($${bidAmount})...`, 'info');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: submitBidOnPage,
        args: [{ proposal, amount: bidAmount, projectId: project.id }]
      });

      const history = config.bidHistory || {};
      history[project.id] = { time: Date.now(), title: fullProject.title };
      await chrome.storage.local.set({ bidHistory: history });

      saveBidToLog({
        title: fullProject.title, clientBudget, bidAmount, proposal,
        url: project.url, tags: fullProject.tags,
        status: 'submitted', time: new Date().toLocaleTimeString(),
        category: detectCategory(fullProject)
      });
      incrementStat('submitted');
      log(`✓ Bid submitted: "${fullProject.title.slice(0, 40)}" — $${bidAmount}`, 'success');

    } else {
      log(`Manual mode — filling form and opening tab for review...`, 'info');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: fillBidFormOnly,
        args: [{ proposal, amount: bidAmount }]
      });
      await chrome.tabs.update(tab.id, { active: true });

      saveBidToLog({
        title: fullProject.title, clientBudget, bidAmount, proposal,
        url: project.url, tags: fullProject.tags,
        status: 'manual', time: new Date().toLocaleTimeString(),
        category: detectCategory(fullProject)
      });
      incrementStat('submitted');
      log(`📋 Manual review: "${fullProject.title.slice(0, 40)}" — tab opened`, 'warn');
    }

  } catch (e) {
    log(`Error on "${project.title.slice(0, 40)}": ${e.message}`, 'error');
    incrementStat('errors');
  }
}

// Scrape the full project detail page — runs via scripting.executeScript
async function scrapeProjectPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const get = sel => document.querySelector(sel)?.textContent?.trim() || '';
      const getAll = sel => Array.from(document.querySelectorAll(sel)).map(el => el.textContent.trim()).filter(Boolean);

      // ── Title ──
      const title =
        get('h1') ||
        get('[class*="title"] h1') ||
        get('[class*="PageTitle"]') ||
        document.title.replace(' | Freelancer', '').trim();

      // ── Full description ──
      // Project detail pages have much longer descriptions than search snippets
      const descCandidates = [
        '[class*="project-description"]',
        '[class*="ProjectDescription"]',
        '[class*="description-text"]',
        '[class*="Details"] p',
        '.project-details p',
        '[data-cy="project-description"]',
        'section p',
      ];
      let description = '';
      for (const sel of descCandidates) {
        const els = document.querySelectorAll(sel);
        if (els.length) {
          description = Array.from(els).map(e => e.textContent.trim()).join('\n\n');
          if (description.length > 100) break;
        }
      }
      // Fallback: biggest text block on the page
      if (description.length < 100) {
        const allP = Array.from(document.querySelectorAll('p'));
        description = allP
          .map(p => p.textContent.trim())
          .filter(t => t.length > 50)
          .join('\n\n')
          .slice(0, 2000);
      }

      // ── Budget — parse min and max separately ──
      let minBudget = null, maxBudget = null, budgetRaw = '';

      const budgetSelectors = [
        '[class*="budget"]',
        '[class*="Budget"]',
        '[class*="price"]',
        '[class*="Price"]',
        '[data-cy*="budget"]',
        '[class*="amount"]',
      ];
      for (const sel of budgetSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          budgetRaw = el.textContent.trim();
          if (budgetRaw) break;
        }
      }

      // Also scan all text for $ patterns (catches cases like "$30 - $250 USD")
      if (!budgetRaw) {
        const allText = document.body.innerText;
        const match = allText.match(/\$[\d,]+\s*[-–to]+\s*\$[\d,]+/);
        if (match) budgetRaw = match[0];
      }

      // Parse range like "$30 - $250" or "$30–$250"
      const rangeMatch = budgetRaw.replace(/,/g, '').match(/\$?([\d.]+)\s*[-–to]+\s*\$?([\d.]+)/);
      if (rangeMatch) {
        minBudget = parseFloat(rangeMatch[1]);
        maxBudget = parseFloat(rangeMatch[2]);
      } else {
        // Single value like "$150"
        const single = budgetRaw.replace(/,/g, '').match(/\$?([\d.]+)/);
        if (single) maxBudget = parseFloat(single[1]);
      }

      // ── Duration / timeframe ──
      const durationSelectors = [
        '[class*="duration"]', '[class*="Duration"]',
        '[class*="timeline"]', '[class*="Timeline"]',
        '[class*="delivery"]',
      ];
      let duration = '';
      for (const sel of durationSelectors) {
        const el = document.querySelector(sel);
        if (el) { duration = el.textContent.trim(); break; }
      }

      // ── Skills / tags ──
      const tagSelectors = [
        '[class*="skill"]', '[class*="Skill"]',
        '[class*="tag"]', '[class*="Tag"]',
        '[class*="label"]',
        'fl-tag', 'app-tag',
      ];
      const tags = [];
      const seen = new Set();
      for (const sel of tagSelectors) {
        document.querySelectorAll(sel).forEach(el => {
          const t = el.textContent.trim();
          if (t && t.length < 50 && !seen.has(t)) { seen.add(t); tags.push(t); }
        });
      }

      return { title, description: description.slice(0, 2000), budgetRaw, minBudget, maxBudget, duration, tags, budget: budgetRaw };
    }
  });

  return results?.[0]?.result || { title: '', description: '', tags: [], budget: '', minBudget: null, maxBudget: null, duration: '' };
}

// Calculate a competitive bid based on client's real budget range
// Client's range always takes precedence; config budget is just a floor filter
function smartBidAmount(clientBudget, minBudget, maxBudget) {
  // Use max as the anchor if we have a range
  const anchor = maxBudget || clientBudget;
  if (!anchor || anchor <= 0) return 150;

  // Bid at ~80-85% of the max — competitive but not suspiciously cheap
  // If there's a min, don't go below it
  let bid;
  if (maxBudget && minBudget) {
    // Bid between midpoint and max: (min + max) / 2 * 1.1, capped at max
    bid = Math.round(((minBudget + maxBudget) / 2) * 1.1);
    bid = Math.min(bid, maxBudget);
    bid = Math.max(bid, minBudget);
  } else if (maxBudget) {
    bid = Math.round(maxBudget * 0.82);
  } else {
    // Fallback tiers
    if (anchor <= 50)   return anchor;
    if (anchor <= 200)  return Math.round(anchor * 0.85);
    if (anchor <= 500)  return Math.round(anchor * 0.80);
    if (anchor <= 2000) return Math.round(anchor * 0.75);
    return Math.round(anchor * 0.70);
  }
  return bid;
}

// Claude API call to generate proposal
async function generateProposal(project, config, bidAmount, clientBudget) {
  let budgetContext;
  if (project.minBudget && project.maxBudget) {
    budgetContext = `Client budget range: $${project.minBudget}–$${project.maxBudget}. My bid: $${bidAmount}.`;
  } else if (clientBudget) {
    budgetContext = `Client budget: $${clientBudget}. My bid: $${bidAmount}.`;
  } else {
    budgetContext = `My bid: $${bidAmount}.`;
  }

  const durationContext = project.duration ? `Project timeline/duration: ${project.duration}.` : '';

  const systemPrompt = `You are a world-class software developer and freelance proposal writer. You write proposals that win contracts by being specific, credible, and human — not polished templates.

## Core principles
- Respond to the project, not to a category. Read the brief and reflect it back.
- Prove you understood the problem before you pitch the solution.
- Sound like a developer who knows their craft, not a salesperson.
- Every sentence earns its place. If it doesn't inform or persuade, cut it.

## Structure (follow this order; hard maximum ${PROPOSAL_MAX_CHARS} characters including spaces)
1. Hook — one sentence showing you read the brief; reference a specific detail from the project.
2. Diagnosis — name the core technical challenge in plain terms; show you understand what's hard about it.
3. Approach — describe your solution in 2–3 sentences; name the stack, method, or pattern you'd use.
4. Credibility — one relevant fact: a past project, specific metric, or skill that directly applies.
5. Timeline — give a realistic delivery estimate; never overpromise.
6. Call to action — end with a specific question or invite to a short call; don't beg for the work.

## Writing rules
- One idea per sentence. Lead with the subject, verb early.
- Active voice. Present tense. No passive constructions.
- Short paragraphs. Break long technical explanations into two sentences.
- State the main point first, qualify later.
- Write like a confident senior developer talking to a peer.
- Use contractions for warmth: "I'll", "won't", "you'll".

## Banned words and phrases — never use these
- "leverage" → use "use"
- "utilize" → use "use"
- "implement" → use "build" or "do"
- "seamless/seamlessly" → be specific about what works automatically
- "robust" → be specific about what makes it reliable
- "innovative" → remove
- "cutting-edge" → remove
- "best practices" → say what you'll actually do
- "I think / I believe" → state it directly
- "I would love to" → remove
- "I am confident that" → state it directly
- "Please review my profile" → remove
- "I have X years of experience" as an opener → lead with the project instead
- "Dear client" → remove all openers like this
- "Thank you for posting this project" → remove
- "Looking forward to hearing from you" → replace with a specific question
- "I can deliver high-quality work" → prove it with specifics instead
- Filler superlatives: "great", "excellent", "amazing", "perfect"
- Hedge words: "might", "perhaps", "potentially", "hopefully" unless uncertainty is real

## Format rules
- No bullet points in the proposal itself; write in flowing paragraphs.
- No headers or markdown formatting.
- No em dashes (—); use commas or short sentences instead.
- No exclamation points.
- Sentence case only; no title case phrases mid-sentence.
- Oxford commas in lists.`;

  const userPrompt = `Write a Freelancer.com proposal for this project.

PROJECT TITLE: ${project.title}
PROJECT DESCRIPTION: ${project.description}
SKILLS REQUIRED: ${project.tags.join(', ') || 'N/A'}
${durationContext}
FREELANCER BIO: ${config.userBio}
BUDGET: ${budgetContext}

Return ONLY the proposal text. No preamble, no subject line, no sign-off name.
The entire proposal must be at most ${PROPOSAL_MAX_CHARS} characters (count spaces). If unsure, be shorter.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 420,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || `API error ${response.status}`);
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text?.trim();
    return raw ? clampProposalText(raw) : null;
  } catch (e) {
    log(`Claude API error: ${e.message}`, 'error');
    return null;
  }
}

// Runs in project page context to fill and submit the bid form
function submitBidOnPage(bidData) {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    function trySubmit() {
      attempts++;
      if (attempts > 20) {
        reject(new Error('Bid form not found after 20 attempts'));
        return;
      }

      // Freelancer bid form selectors (try multiple patterns)
      const descriptionField =
        document.querySelector('textarea[name="description"]') ||
        document.querySelector('textarea[placeholder*="proposal"]') ||
        document.querySelector('textarea[placeholder*="cover letter"]') ||
        document.querySelector('.bid-form textarea') ||
        document.querySelector('[data-bid-description]') ||
        document.querySelector('textarea');

      const amountField =
        document.querySelector('input[name="amount"]') ||
        document.querySelector('input[placeholder*="bid amount"]') ||
        document.querySelector('.bid-amount input') ||
        document.querySelector('[data-bid-amount]') ||
        document.querySelector('input[type="number"]');

      if (!descriptionField || !amountField) {
        setTimeout(trySubmit, 500);
        return;
      }

      // Fill description
      descriptionField.focus();
      descriptionField.value = bidData.proposal;
      descriptionField.dispatchEvent(new Event('input', { bubbles: true }));
      descriptionField.dispatchEvent(new Event('change', { bubbles: true }));

      // Fill amount
      amountField.focus();
      amountField.value = bidData.amount;
      amountField.dispatchEvent(new Event('input', { bubbles: true }));
      amountField.dispatchEvent(new Event('change', { bubbles: true }));

      // Brief pause then submit
      setTimeout(() => {
        const submitBtn =
          document.querySelector('button[type="submit"]') ||
          document.querySelector('.bid-form button[class*="submit"]') ||
          document.querySelector('[data-bid-submit]') ||
          Array.from(document.querySelectorAll('button')).find(b =>
            b.textContent.toLowerCase().includes('place bid') ||
            b.textContent.toLowerCase().includes('submit bid') ||
            b.textContent.toLowerCase().includes('bid now')
          );

        if (submitBtn && !submitBtn.disabled) {
          submitBtn.click();
          resolve('submitted');
        } else {
          setTimeout(trySubmit, 600);
        }
      }, 800);
    }

    // Wait a moment for page to fully load forms
    setTimeout(trySubmit, 2000);
  });
}

// Fills bid form WITHOUT submitting — used in manual mode
function fillBidFormOnly(bidData) {
  return new Promise((resolve) => {
    let attempts = 0;

    function tryFill() {
      attempts++;
      if (attempts > 20) { resolve('timeout'); return; }

      const descriptionField =
        document.querySelector('textarea[name="description"]') ||
        document.querySelector('textarea[placeholder*="proposal"]') ||
        document.querySelector('textarea[placeholder*="cover letter"]') ||
        document.querySelector('.bid-form textarea') ||
        document.querySelector('textarea');

      const amountField =
        document.querySelector('input[name="amount"]') ||
        document.querySelector('input[placeholder*="bid amount"]') ||
        document.querySelector('.bid-amount input') ||
        document.querySelector('input[type="number"]');

      if (!descriptionField || !amountField) {
        setTimeout(tryFill, 500);
        return;
      }

      descriptionField.focus();
      descriptionField.value = bidData.proposal;
      descriptionField.dispatchEvent(new Event('input', { bubbles: true }));
      descriptionField.dispatchEvent(new Event('change', { bubbles: true }));

      amountField.focus();
      amountField.value = bidData.amount;
      amountField.dispatchEvent(new Event('input', { bubbles: true }));
      amountField.dispatchEvent(new Event('change', { bubbles: true }));

      // Add a visible banner so user knows it was filled by the agent
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#7c5cfc;color:white;padding:10px 16px;font-family:monospace;font-size:13px;text-align:center;';
      banner.textContent = `🤖 FreelanceAI filled this bid ($${bidData.amount}) — review and click submit when ready`;
      document.body.prepend(banner);

      resolve('filled');
    }

    setTimeout(tryFill, 2000);
  });
}

// ── Helpers ──────────────────────────────────────────────────

function matchesCategory(project, config) {
  const text = `${project.title} ${project.description} ${project.tags.join(' ')}`.toLowerCase();

  const webDevKeywords = ['web', 'website', 'wordpress', 'react', 'vue', 'angular', 'html', 'css', 'javascript', 'js', 'php', 'node', 'frontend', 'backend', 'fullstack', 'shopify', 'woocommerce', 'landing page', 'web app', 'api', 'django', 'flask', 'laravel', 'development'];
  const dataEntryKeywords = ['data entry', 'spreadsheet', 'excel', 'copy paste', 'typing', 'data collection', 'web scraping', 'database', 'csv', 'google sheets', 'data processing', 'data cleaning', 'research', 'list building'];

  if (config.catWebDev && webDevKeywords.some(k => text.includes(k))) return true;
  if (config.catDataEntry && dataEntryKeywords.some(k => text.includes(k))) return true;
  return false;
}

function detectCategory(project) {
  const text = `${project.title} ${project.tags.join(' ')}`.toLowerCase();
  if (['web', 'website', 'react', 'javascript', 'php', 'frontend'].some(k => text.includes(k))) return 'Web Dev';
  if (['data entry', 'spreadsheet', 'excel', 'csv'].some(k => text.includes(k))) return 'Data Entry';
  return 'Other';
}

function parseBudget(budgetStr) {
  if (!budgetStr || budgetStr === 'N/A') return null;
  const nums = budgetStr.replace(/,/g, '').match(/\d+/g);
  if (!nums) return null;
  const vals = nums.map(Number);
  return vals.length > 1 ? Math.round((vals[0] + vals[vals.length - 1]) / 2) : vals[0];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get(null, data => resolve(data));
  });
}

function incrementStat(key, amount = 1) {
  chrome.storage.local.get('stats', data => {
    const stats = data.stats || { scanned: 0, submitted: 0, errors: 0 };
    stats[key] = (stats[key] || 0) + amount;
    chrome.storage.local.set({ stats }, () => {
      chrome.runtime.sendMessage({ type: 'STATS_UPDATE', stats }).catch(() => {});
    });
  });
}

function saveBidToLog(bid) {
  chrome.storage.local.get('bidLog', data => {
    const log = data.bidLog || [];
    log.push(bid);
    if (log.length > 200) log.splice(0, log.length - 200);
    chrome.storage.local.set({ bidLog: log }, () => {
      chrome.runtime.sendMessage({ type: 'BID_ADDED', bid }).catch(() => {});
    });
  });
}

function log(text, level = 'info') {
  console.log(`[FreelanceAI] ${text}`);
  chrome.runtime.sendMessage({ type: 'LOG', text, level }).catch(() => {});
  // Always persist to activity log too
  chrome.storage.local.get('activityLog', data => {
    const actLog = data.activityLog || [];
    actLog.push({ msg: text, type: level, time: new Date().toLocaleTimeString('en-US', { hour12: false }) });
    if (actLog.length > 100) actLog.splice(0, actLog.length - 100);
    chrome.storage.local.set({ activityLog: actLog });
  });
}
