# Basic Website Visiting Plugin for LM Studio

An LM Studio plugin with two tools:

- Visit Website - Allows the assistant to view the links, image URLs and text content of a given webpage.
- View Images - Allows the assistant to download and display images from a list of image URLs.

# Upgrades

What changes/upgrades from the original?

# Upgrades from Base

- **Refactor** — Few refactors to existing codebase for a more reliability.
- **DNS** — Overrides the system resolver with Cloudflare (`1.1.1.1`, `1.0.0.1`) and Google (`8.8.8.8`, `8.8.4.4`) at startup, eliminating flaky ISP/router-caused `ENOTFOUND` errors.
- **Retry logic** — `fetchHTML` retries up to 3 times with a 500ms delay on transient network failures.
- **Timeouts** — Page fetches timeout after 15s, individual image downloads after 10s, both using `AbortSignal.any` so user cancellation still works.
- **TLS fallback** — When `fetch` rejects a misconfigured certificate, automatically retries via raw `node:https` with `rejectUnauthorized: false`. Forces `Accept-Encoding: identity` on that path (raw Node doesn't decompress automatically) and manually follows redirects up to 5 deep.
- **Image fallback** — Image download failures no longer crash the tool; page content and links are still returned.
- **Readability** — Replaced naive tag-stripping with Mozilla Readability + JSDOM, the same engine as Firefox Reader Mode. Discards navbars, footers, and boilerplate; returns only the main content. Falls back to tag-stripping if Readability finds nothing.
- **DOM-based extraction** — Links and images are now extracted via `querySelectorAll` on the already-parsed JSDOM tree instead of regex on raw HTML. Handles single-quoted attributes, relative URLs, and lazy-load image attributes (`data-src`, `data-lazy-src`, etc.).
- **User agents** — Replaced entries from 2020–2022 with current Chrome 133/134, Firefox 134/135, Safari 18.3, and modern mobile strings.
- **Dependencies** — Added `@mozilla/readability ^0.6.0` and `jsdom ^29.0.1`. Upgraded `zod` & `@lmstudio/sdk` version.

## Installation

The plugin is available for download on the
[LM Studio Hub](https://lmstudio.ai/danielsig/visit-website)

![click the "Run in LM Studio" button](/docs/assets/how_to_install_on_lm_studio_hub.png)

## Configuration

![Visit Website Configuration](/docs/assets/configuration.png)
  
## How to use

With the plugin enabled, the assistant can be instructed to visit a web page by providing a URL.

This plugin works well in combination with the [DuckDuckGo Search Tool](https://github.com/danielsig/lms-plugin-duckduckgo) which can be used to find relevant URLs.
