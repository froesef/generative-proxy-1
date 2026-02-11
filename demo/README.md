# Generative Proxy Demo (Worker + Side Panel Extension)

This demo gives you:

- A **Cloudflare Worker proxy** that rewrites HTML elements with the class `generative-customization`.
- A **browser side panel extension** that:
  - edits the main prompt stored in Cloudflare KV,
  - manages multiple personalities stored in Cloudflare KV,
  - injects request headers to activate personality-driven rewriting.

## Architecture

1. Browser sends requests with headers from the extension:
- `x-generative-enabled: 1`
- `x-generative-personality: <personality-id>`

2. Worker receives the request, fetches upstream HTML, and replaces text inside tags that contain class `generative-customization`.

3. Worker builds generation input from:
- KV key `main_prompt`
- selected personality prompt from KV key `personalities`
- original text content from the HTML element

4. Worker uses Workers AI when available (`AI` binding). If AI is unavailable, it falls back to deterministic synthesized text.

## Files

- Worker: `/Users/ffroese/git/generative-proxy-1/demo/worker`
- Extension: `/Users/ffroese/git/generative-proxy-1/demo/extension`

## Worker Setup

1. Install dependencies:

```bash
cd /Users/ffroese/git/generative-proxy-1/demo/worker
npm install
```

2. Create KV namespace IDs:

```bash
wrangler kv namespace create GEN_CONFIG
wrangler kv namespace create GEN_CONFIG --preview
```

3. Put both IDs into `/Users/ffroese/git/generative-proxy-1/demo/worker/wrangler.jsonc`:
- replace `__REPLACE_WITH_KV_NAMESPACE_ID__`
- replace `__REPLACE_WITH_PREVIEW_KV_NAMESPACE_ID__`

4. Set your upstream origin in `ORIGIN_BASE_URL` inside `/Users/ffroese/git/generative-proxy-1/demo/worker/wrangler.jsonc`.

5. Optional admin protection for write APIs:

```bash
wrangler secret put ADMIN_TOKEN
```

6. Run local dev:

```bash
npm run dev
```

7. Deploy:

```bash
npm run deploy
```

## Extension Setup (Chrome)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select:

`/Users/ffroese/git/generative-proxy-1/demo/extension`

4. Click the extension icon to open the side panel.
5. Set Worker base URL (local dev usually `http://127.0.0.1:8787`), optionally set admin token, then click **Save Connection**.

## API Endpoints (Worker)

- `GET /api/config`
- `PUT /api/config/prompt` body: `{ "mainPrompt": "..." }`
- `GET /api/config/personalities`
- `PUT /api/config/personalities` body: `{ "personalities": [{ "id": "...", "name": "...", "prompt": "..." }] }`
- `POST /api/config/personalities` body: `{ "name": "...", "prompt": "...", "id": "optional" }`
- `DELETE /api/config/personalities/:id`

If `ADMIN_TOKEN` is configured, write endpoints require header `x-admin-token`.

## Markup Example

Use this class on any element whose text should be rewritten:

```html
<p class="generative-customization">Welcome to our product. We help teams ship faster.</p>
```

A ready-made sample page is included at:

- `/Users/ffroese/git/generative-proxy-1/demo/sample-page.html`

## Notes

- Rewriting runs only when header `x-generative-enabled` is set to `1` or `true`.
- The selected personality comes from `x-generative-personality`; if missing, the first stored personality is used.
- The current implementation replaces element text (not nested rich markup), which is ideal for plain copy blocks in a demo.
