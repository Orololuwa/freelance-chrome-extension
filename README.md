# FreelanceAI — Auto Bidder Chrome Extension

Automatically scrapes Freelancer.com job listings and submits AI-written proposals using Claude.

---

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer Mode** (top-right toggle)
3. Click **"Load unpacked"**
4. Select the `freelancer-extension` folder

The extension icon will appear in your toolbar.

---

## Setup

1. **Get an Anthropic API key** from https://console.anthropic.com
2. Click the extension icon → go to **Config** tab
3. Paste your API key
4. Write your bio/skills summary (the more detail, the better the proposals)
5. Set your budget range and default bid amount
6. Set scan interval (default: every 5 minutes)
7. Click **Save Configuration**

---

## Usage

1. **Log in to Freelancer.com** in your browser
2. Navigate to https://www.freelancer.com/jobs/
3. Click the extension icon → **Dashboard** tab
4. Click **▶ START AGENT**

The agent will:
- Scan for new Web Development and Data Entry projects
- Filter by your budget range
- Generate a tailored proposal using Claude
- Open each project and submit the bid automatically
- Log all activity in the Dashboard

---

## How It Works

```
Alarm fires every N minutes
      ↓
Opens/finds Freelancer jobs page
      ↓
Scrapes project listings
      ↓
Filters by category + budget + not-already-bid
      ↓
For each eligible project:
   → Sends to Claude API → gets custom proposal
   → Opens project URL in background tab
   → Fills bid form (amount + proposal)
   → Clicks submit
   → Logs result
   → Waits 3–5 seconds (human-like pacing)
```

---

## Important Notes

- **Terms of Service**: Automated bidding may violate Freelancer's ToS. Use at your own discretion.
- **Bid Credits**: Freelancer has monthly bid limits. The agent respects this naturally since it only bids on relevant projects.
- **Login Required**: You must be logged into Freelancer.com for the extension to work.
- **API Costs**: Each proposal uses ~400 tokens. Monitor your Anthropic usage at console.anthropic.com.
- **Selector Changes**: If Freelancer updates their UI, selectors in `content.js` and `background.js` may need updating.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| No projects found | Make sure you're on `freelancer.com/jobs/` when starting |
| Bid form not found | Freelancer may have updated their UI — check browser console for errors |
| API errors | Verify your API key in Config tab |
| Extension not loading | Check `chrome://extensions/` for errors |

---

## Files

```
freelancer-extension/
├── manifest.json      # Extension config
├── background.js      # Service worker: orchestrates scanning & bidding
├── content.js         # Runs on Freelancer pages, scrapes listings
├── popup.html         # Extension UI
├── popup.js           # UI logic
└── icons/             # Extension icons
```
