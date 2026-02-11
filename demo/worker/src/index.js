const PROMPT_KEY = 'main_prompt';
const PERSONALITIES_KEY = 'personalities';
const HEADER_ENABLED = 'x-generative-enabled';
const HEADER_PERSONALITY = 'x-generative-personality';
const CEREBRAS_API_URL = 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_MODEL = 'gpt-oss-120b';
const CF_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';

const DEFAULT_MAIN_PROMPT = 'Rewrite webpage copy to match the given personality while keeping the same meaning and length.';

const DEFAULT_PERSONALITIES = [
  {
    id: 'funny-pirate',
    name: 'Funny Pirate',
    prompt: 'Talk like a swashbuckling pirate who finds everything hilarious. Use nautical metaphors, say "arrr" and "matey", and sneak in puns about the sea.',
  },
  {
    id: 'concerned-parent',
    name: 'Concerned Parent',
    prompt: 'Sound like a loving but slightly overprotective parent. Add gentle warnings, caring reminders, and phrases like "be careful" and "have you eaten?".',
  },
  {
    id: 'noir-detective',
    name: 'Noir Detective',
    prompt: 'Write like a hard-boiled 1940s detective narrating a case. Use moody metaphors, short punchy sentences, and a world-weary cynical tone.',
  },
  {
    id: 'surfer-dude',
    name: 'Surfer Dude',
    prompt: 'Talk like a laid-back California surfer. Everything is "rad", "gnarly", or "stoked". Keep it super chill and positive, dude.',
  },
  {
    id: 'shakespearean-bard',
    name: 'Shakespearean Bard',
    prompt: 'Rewrite in the style of William Shakespeare. Use "thee", "thou", "doth", and iambic phrasing. Be dramatic and poetic.',
  },
];

export default {
  async fetch(request, env) {
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: createCorsHeaders() });
      }

      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) {
        return handleApiRequest(request, url, env);
      }

      return handleProxyRequest(request, env);
    } catch (error) {
      console.error('Unhandled worker error', error);
      return jsonResponse(
        {
          error: 'Internal server error',
          detail: error instanceof Error ? error.message : 'Unknown error',
        },
        500,
      );
    }
  },
};

async function handleApiRequest(request, url, env) {
  ensureKvBinding(env);

  if (url.pathname === '/api/config' && request.method === 'GET') {
    const [mainPrompt, personalities] = await Promise.all([
      readMainPrompt(env),
      readPersonalities(env),
    ]);

    return jsonResponse({ mainPrompt, personalities });
  }

  if (url.pathname === '/api/config/prompt' && request.method === 'PUT') {
    if (!isAuthorized(request, env)) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const body = await parseJsonBody(request);
    if (!body || typeof body.mainPrompt !== 'string' || !body.mainPrompt.trim()) {
      return jsonResponse({ error: 'mainPrompt is required' }, 400);
    }

    const mainPrompt = body.mainPrompt.trim();
    await env.GEN_CONFIG.put(PROMPT_KEY, mainPrompt);

    return jsonResponse({ mainPrompt });
  }

  if (url.pathname === '/api/config/personalities' && request.method === 'GET') {
    const personalities = await readPersonalities(env);
    return jsonResponse({ personalities });
  }

  if (url.pathname === '/api/config/personalities' && request.method === 'PUT') {
    if (!isAuthorized(request, env)) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const body = await parseJsonBody(request);
    if (!body || !Array.isArray(body.personalities)) {
      return jsonResponse({ error: 'personalities array is required' }, 400);
    }

    const personalities = normalizePersonalities(body.personalities);
    await env.GEN_CONFIG.put(PERSONALITIES_KEY, JSON.stringify(personalities));

    return jsonResponse({ personalities });
  }

  if (url.pathname === '/api/config/personalities' && request.method === 'POST') {
    if (!isAuthorized(request, env)) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const body = await parseJsonBody(request);
    if (!body || typeof body.name !== 'string' || typeof body.prompt !== 'string') {
      return jsonResponse({ error: 'name and prompt are required' }, 400);
    }

    const name = body.name.trim();
    const prompt = body.prompt.trim();
    if (!name || !prompt) {
      return jsonResponse({ error: 'name and prompt cannot be empty' }, 400);
    }

    const current = await readPersonalities(env);
    const id = typeof body.id === 'string' && body.id.trim()
      ? slugify(body.id)
      : uniqueIdFromName(name, current);

    const next = [
      ...current.filter((item) => item.id !== id),
      {
        id,
        name,
        prompt,
      },
    ];

    const personalities = normalizePersonalities(next);
    await env.GEN_CONFIG.put(PERSONALITIES_KEY, JSON.stringify(personalities));

    return jsonResponse({ personalities, id });
  }

  const personalityDeleteMatch = url.pathname.match(/^\/api\/config\/personalities\/([^/]+)$/);
  if (personalityDeleteMatch && request.method === 'DELETE') {
    if (!isAuthorized(request, env)) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const personalityId = decodeURIComponent(personalityDeleteMatch[1]);
    const current = await readPersonalities(env);
    const next = current.filter((item) => item.id !== personalityId);

    if (next.length === 0) {
      return jsonResponse({ error: 'At least one personality must remain' }, 400);
    }

    await env.GEN_CONFIG.put(PERSONALITIES_KEY, JSON.stringify(next));
    return jsonResponse({ personalities: next });
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

async function handleProxyRequest(request, env) {
  ensureKvBinding(env);

  const upstreamRequest = buildUpstreamRequest(request, env);
  const upstreamResponse = await fetch(upstreamRequest);

  if (!shouldRewrite(request, upstreamResponse)) {
    const headers = new Headers(upstreamResponse.headers);
    headers.set('x-customized', 'false');
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  }

  const html = await upstreamResponse.text();
  const [mainPrompt, personalities] = await Promise.all([
    readMainPrompt(env),
    readPersonalities(env),
  ]);

  const personalityId = request.headers.get(HEADER_PERSONALITY) || '';
  const personality = personalities.find((item) => item.id === personalityId) || personalities[0];

  const errors = [];
  const debug = { provider: null, model: null };
  const rewritten = await rewriteGenerativeSections(html, {
    env,
    mainPrompt,
    personality,
    errors,
    debug,
  });

  const customized = rewritten !== html;
  const headers = new Headers(upstreamResponse.headers);
  headers.delete('content-length');
  headers.set('x-customized', customized ? 'true' : 'false');

  if (errors.length > 0) {
    headers.set('x-errors', errors.join('; '));
  }

  if (customized) {
    headers.set('x-generative-profile', personality.id);
    headers.set('cache-control', 'private');
  }

  if (debug.provider) {
    headers.set('x-debug', `provider=${debug.provider}; model=${debug.model}`);
  }

  return new Response(rewritten, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

function shouldRewrite(request, response) {
  if (request.method !== 'GET') {
    return false;
  }

  const enabled = request.headers.get(HEADER_ENABLED);
  if (!(enabled === '1' || enabled === 'true')) {
    return false;
  }

  const contentType = response.headers.get('content-type') || '';
  return contentType.includes('text/html');
}

function buildUpstreamRequest(request, env) {
  const customizeHost = request.headers.get('x-customize-host');
  const originBase = customizeHost || env.ORIGIN_BASE_URL;

  if (!originBase) {
    return request;
  }

  const incomingUrl = new URL(request.url);
  const originUrl = new URL(originBase);

  const targetUrl = new URL(request.url);
  targetUrl.protocol = originUrl.protocol;
  targetUrl.host = originUrl.host;

  if (incomingUrl.pathname === '/') {
    targetUrl.pathname = originUrl.pathname || '/';
  } else if (originUrl.pathname && originUrl.pathname !== '/') {
    targetUrl.pathname = `${originUrl.pathname.replace(/\/$/, '')}${incomingUrl.pathname}`;
  }

  const proxied = new Request(targetUrl.toString(), request);
  const headers = new Headers(proxied.headers);
  headers.delete(HEADER_ENABLED);
  headers.delete(HEADER_PERSONALITY);
  headers.delete('x-customize-host');
  headers.delete('x-admin-token');

  return new Request(proxied, { headers });
}

const TEXT_LEAF_TAGS = 'p|h[1-6]|li|blockquote|figcaption';

function findGenerativeContainers(html) {
  const containers = [];
  const classPattern = /class\s*=\s*["'][^"']*\bgenerative-customization\b[^"']*["']/gi;
  let classMatch;

  while ((classMatch = classPattern.exec(html)) !== null) {
    const tagStart = html.lastIndexOf('<', classMatch.index);
    const tagEnd = html.indexOf('>', classMatch.index) + 1;
    const tagNameMatch = html.slice(tagStart).match(/^<([a-zA-Z][\w:-]*)/);
    if (!tagNameMatch) continue;

    const tagName = tagNameMatch[1];
    const openRe = new RegExp(`<${tagName}(?=[\\s>])`, 'gi');
    const closeRe = new RegExp(`</${tagName}>`, 'gi');

    let depth = 1;
    let pos = tagEnd;

    while (depth > 0 && pos < html.length) {
      openRe.lastIndex = pos;
      closeRe.lastIndex = pos;

      const nextOpen = openRe.exec(html);
      const nextClose = closeRe.exec(html);

      if (!nextClose) break;

      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++;
        pos = openRe.lastIndex;
      } else {
        depth--;
        if (depth === 0) {
          containers.push({
            innerStart: tagEnd,
            innerEnd: nextClose.index,
          });
        }
        pos = closeRe.lastIndex;
      }
    }
  }

  return containers;
}

async function rewriteGenerativeSections(html, context) {
  const containers = findGenerativeContainers(html);

  if (containers.length === 0) {
    return html;
  }

  const textPattern = new RegExp(
    `<((?:${TEXT_LEAF_TAGS}))(\\s[^>]*)?>([\\s\\S]*?)<\\/\\1>`,
    'gi',
  );

  const edits = [];

  for (const container of containers) {
    const inner = html.slice(container.innerStart, container.innerEnd);
    const matches = [...inner.matchAll(textPattern)];

    for (const match of matches) {
      const plainText = collapseWhitespace(stripHtml(match[3]));
      if (!plainText) continue;

      edits.push({
        start: container.innerStart + match.index,
        end: container.innerStart + match.index + match[0].length,
        tagName: match[1],
        attrs: match[2] || '',
        innerHTML: match[3],
      });
    }
  }

  if (edits.length === 0) {
    return html;
  }

  const texts = edits.map((edit) => edit.innerHTML);
  const replacements = await generateBatch(context, texts);

  let result = html;
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    const replaced = `<${edit.tagName}${edit.attrs}>${replacements[i]}</${edit.tagName}>`;
    result = result.slice(0, edit.start) + replaced + result.slice(edit.end);
  }

  return result;
}

function buildBatchSystemPrompt(mainPrompt, personality, count) {
  return [
    `You will receive a JSON array of ${count} website text snippets.`,
    'Rewrite each snippet according to the provided prompt and personality.',
    'CRITICAL: Snippets may contain HTML tags such as <strong>, <em>, <a>, <br>, <span>, etc.',
    'You MUST preserve every HTML tag exactly as-is. Do NOT add, remove, or modify any tags.',
    'Only change the human-readable text between and around the tags.',
    `Return a JSON array of exactly ${count} rewritten strings in the same order. No other output.`,
    `Main prompt: ${mainPrompt}`,
    `Personality instructions: ${personality.prompt}`,
  ].join('\n');
}

function parseBatchResponse(raw, count) {
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    return { error: 'response did not contain a JSON array' };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { error: 'response contained invalid JSON' };
  }

  if (!Array.isArray(parsed)) {
    return { error: 'parsed response is not an array' };
  }

  if (parsed.length !== count) {
    return { error: `expected ${count} items but got ${parsed.length}` };
  }

  return { result: parsed.map((item) => (typeof item === 'string' ? item : String(item))) };
}

async function callCerebras(apiKey, systemPrompt, userContent, maxTokens) {
  const response = await fetch(CEREBRAS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: CEREBRAS_MODEL,
      max_tokens: maxTokens,
      temperature: 0.8,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cerebras API ${response.status}: ${body}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error('Cerebras returned empty content');
  }

  return text;
}

async function callCloudflareAI(ai, systemPrompt, userContent, maxTokens) {
  const result = await ai.run(CF_AI_MODEL, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    max_tokens: maxTokens,
    temperature: 0.8,
  });

  const text = typeof result.response === 'string' ? result.response.trim() : '';
  if (!text) {
    throw new Error('Cloudflare AI returned empty content');
  }

  return text;
}

async function generateBatch(context, texts) {
  const { env, mainPrompt, personality, errors, debug } = context;
  const count = texts.length;
  const systemPrompt = buildBatchSystemPrompt(mainPrompt, personality, count);
  const userContent = JSON.stringify(texts);
  const maxTokens = Math.min(count * 300, 4096);

  const providers = [];
  if (env.CEREBRAS_API_KEY) {
    providers.push({
      name: 'Cerebras',
      model: CEREBRAS_MODEL,
      call: () => callCerebras(env.CEREBRAS_API_KEY, systemPrompt, userContent, maxTokens),
    });
  }
  if (env.AI && typeof env.AI.run === 'function') {
    providers.push({
      name: 'Cloudflare Workers AI',
      model: CF_AI_MODEL,
      call: () => callCloudflareAI(env.AI, systemPrompt, userContent, maxTokens),
    });
  }

  for (const provider of providers) {
    try {
      const raw = await provider.call();
      const parsed = parseBatchResponse(raw, count);
      if (parsed.result) {
        debug.provider = provider.name;
        debug.model = provider.model;
        return parsed.result;
      }

      const msg = `${provider.name}: ${parsed.error}`;
      console.error(msg, raw);
      errors.push(msg);
    } catch (error) {
      const msg = `${provider.name}: ${error.message}`;
      console.error(msg);
      errors.push(msg);
    }
  }

  if (providers.length === 0) {
    errors.push('No AI provider available');
  }

  return texts;
}

async function readMainPrompt(env) {
  const stored = await env.GEN_CONFIG.get(PROMPT_KEY);
  if (typeof stored === 'string' && stored.trim()) {
    return stored.trim();
  }

  await env.GEN_CONFIG.put(PROMPT_KEY, DEFAULT_MAIN_PROMPT);
  return DEFAULT_MAIN_PROMPT;
}

async function readPersonalities(env) {
  const stored = await env.GEN_CONFIG.get(PERSONALITIES_KEY, 'json');

  if (Array.isArray(stored)) {
    return normalizePersonalities(stored);
  }

  if (stored && Array.isArray(stored.personalities)) {
    return normalizePersonalities(stored.personalities);
  }

  await env.GEN_CONFIG.put(PERSONALITIES_KEY, JSON.stringify(DEFAULT_PERSONALITIES));
  return DEFAULT_PERSONALITIES;
}

function normalizePersonalities(input) {
  if (!Array.isArray(input)) {
    return DEFAULT_PERSONALITIES;
  }

  const normalized = input
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : '';
      if (!name || !prompt) {
        return null;
      }

      const idSource = typeof entry.id === 'string' && entry.id.trim()
        ? entry.id
        : name;

      return {
        id: slugify(idSource),
        name,
        prompt,
      };
    })
    .filter(Boolean);

  if (normalized.length === 0) {
    return DEFAULT_PERSONALITIES;
  }

  const deduplicated = [];
  const seen = new Set();

  normalized.forEach((item) => {
    if (seen.has(item.id)) {
      return;
    }

    seen.add(item.id);
    deduplicated.push(item);
  });

  return deduplicated.length > 0 ? deduplicated : DEFAULT_PERSONALITIES;
}

function uniqueIdFromName(name, personalities) {
  const base = slugify(name);
  const ids = new Set(personalities.map((item) => item.id));

  if (!ids.has(base)) {
    return base;
  }

  let candidate = `${base}-${Math.floor(Math.random() * 100000)}`;
  while (ids.has(candidate)) {
    candidate = `${base}-${Math.floor(Math.random() * 100000)}`;
  }

  return candidate;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'personality';
}

function stripHtml(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

function collapseWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) {
    return true;
  }

  const token = request.headers.get('x-admin-token');
  return token === env.ADMIN_TOKEN;
}

async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function ensureKvBinding(env) {
  if (!env.GEN_CONFIG) {
    throw new Error('Missing GEN_CONFIG KV binding');
  }
}

function createCorsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-admin-token',
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...createCorsHeaders(),
    },
  });
}
