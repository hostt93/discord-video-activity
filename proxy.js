// Generic rewriting reverse-proxy. This is what lets the activity load
// *any* pasted embed link, instead of only domains pre-registered in the
// Discord Developer Portal's URL Mappings.
//
// Flow: browser -> /proxy?url=<target> -> we fetch <target> server-side,
// strip headers that would block framing, and (for HTML/CSS/HLS playlists)
// rewrite embedded URLs so sub-resources also route back through here.
const cheerio = require('cheerio');
const { Readable } = require('stream');
const dns = require('dns').promises;
const net = require('net');

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '::1']);

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
  }
  return false;
}

// Blocks requests to localhost/private ranges so this proxy can't be used
// as an SSRF pivot into your own network once it's hosted publicly.
async function assertSafeUrl(targetUrl) {
  const parsed = new URL(targetUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https URLs are allowed');
  }
  if (BLOCKED_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    throw new Error('Blocked host');
  }
  if (net.isIP(parsed.hostname)) {
    if (isPrivateIp(parsed.hostname)) throw new Error('Blocked private IP');
    return;
  }
  const records = await dns.lookup(parsed.hostname, { all: true });
  for (const { address } of records) {
    if (isPrivateIp(address)) throw new Error('Blocked private IP');
  }
}

// `ref` is the embedding-page URL that hotlink checks upstream want to see as
// the Referer. When present we carry it forward on every rewritten sub-URL so
// the whole resource tree (playlist -> variants -> segments) keeps the same
// referer context, instead of relying on the browser's own Referer header
// (which Discord's sandbox may strip).
function proxiedUrl(absoluteUrl, ref) {
  let out = `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
  if (ref) out += `&ref=${encodeURIComponent(ref)}`;
  return out;
}

// When a proxied page requests a sub-resource (CSS, JS, an HLS manifest, a
// segment), the browser sends us a Referer of our *own* /proxy?url=<page>
// URL — because that's the document making the request. Many hosts (e.g. S3
// buckets with a hotlink allowlist) only serve a resource when the Referer is
// the embedding site, not the resource's own origin. Recover the real page
// URL from that referer so we can present it upstream, exactly like a browser
// loading the page directly would. Returns null for top-level loads (where the
// referer isn't one of our proxy URLs), leaving the default behavior intact.
function originatingPageFromReferer(req) {
  const incoming = req.headers['referer'] || req.headers['referrer'];
  if (!incoming) return null;
  try {
    const inner = new URL(incoming).searchParams.get('url');
    if (!inner) return null;
    // Only trust http/https pages; ignore anything odd.
    const parsed = new URL(inner);
    return ['http:', 'https:'].includes(parsed.protocol) ? inner : null;
  } catch {
    return null;
  }
}

function resolve(maybeRelative, base) {
  try {
    return new URL(maybeRelative, base).href;
  } catch {
    return null;
  }
}

function rewriteCss(css, baseUrl, ref) {
  return css.replace(/url\(([^)]+)\)/g, (match, rawUrl) => {
    const url = rawUrl.trim().replace(/^['"]|['"]$/g, '');
    if (!url || url.startsWith('data:')) return match;
    const abs = resolve(url, baseUrl);
    return abs ? `url("${proxiedUrl(abs, ref)}")` : match;
  });
}

function rewriteM3u8(text, baseUrl, ref) {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return trimmed.replace(/URI="([^"]+)"/, (m, uri) => {
          const abs = resolve(uri, baseUrl);
          return abs ? `URI="${proxiedUrl(abs, ref)}"` : m;
        });
      }
      const abs = resolve(trimmed, baseUrl);
      return abs ? proxiedUrl(abs, ref) : line;
    })
    .join('\n');
}

function buildShim(baseUrl, ref) {
  // Rewrites URLs used by dynamic fetch()/XHR calls at runtime (this is
  // what makes JS-driven players like hls.js work, since they build segment
  // URLs on the fly rather than putting them in the initial HTML).
  // Force a permissive referrer policy so the browser always sends the full
  // /proxy?url=<page> referer (including the query) on sub-resource requests.
  // originatingPageFromReferer relies on that query to recover the embedding
  // page for hotlink allowlists; a stricter upstream/Discord policy would
  // otherwise trim the referer to just the origin and break it.
  return `<meta name="referrer" content="unsafe-url">
<script>
(function () {
  var REAL_ORIGIN = ${JSON.stringify(baseUrl)};
  var REF = ${JSON.stringify(ref || '')};
  function toProxied(url) {
    try {
      var abs = new URL(url, REAL_ORIGIN).href;
      if (abs.indexOf(location.origin) === 0) return url;
      var out = '/proxy?url=' + encodeURIComponent(abs);
      if (REF) out += '&ref=' + encodeURIComponent(REF);
      return out;
    } catch (e) { return url; }
  }
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') input = toProxied(input);
        else if (input && input.url) input = new Request(toProxied(input.url), input);
      } catch (e) {}
      return origFetch.call(this, input, init);
    };
  }
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var rest = Array.prototype.slice.call(arguments, 2);
    return origOpen.apply(this, [method, toProxied(url)].concat(rest));
  };
})();
</script>`;
}

function rewriteHtml(html, baseUrl, ref) {
  const $ = cheerio.load(html);

  const attrTargets = [
    ['img', 'src'], ['img', 'srcset'],
    ['script', 'src'],
    ['link', 'href'],
    ['iframe', 'src'],
    ['source', 'src'], ['source', 'srcset'],
    ['video', 'src'], ['video', 'poster'],
    ['audio', 'src'],
    ['a', 'href'],
    ['form', 'action'],
  ];

  for (const [tag, attr] of attrTargets) {
    $(tag).each((_, el) => {
      const $el = $(el);
      const val = $el.attr(attr);
      if (!val) return;

      if (attr === 'srcset') {
        const rewritten = val
          .split(',')
          .map((part) => {
            const [url, size] = part.trim().split(/\s+/, 2);
            const abs = resolve(url, baseUrl);
            if (!abs) return part.trim();
            return size ? `${proxiedUrl(abs, ref)} ${size}` : proxiedUrl(abs, ref);
          })
          .join(', ');
        $el.attr(attr, rewritten);
        return;
      }

      if (/^(javascript:|data:|#|mailto:)/.test(val)) return;
      const abs = resolve(val, baseUrl);
      if (abs) $el.attr(attr, proxiedUrl(abs, ref));
    });
  }

  $('style').each((_, el) => {
    const $el = $(el);
    $el.text(rewriteCss($el.text(), baseUrl, ref));
  });
  $('[style]').each((_, el) => {
    const $el = $(el);
    $el.attr('style', rewriteCss($el.attr('style'), baseUrl, ref));
  });

  const shim = buildShim(baseUrl, ref);
  if ($('head').length) $('head').prepend(shim);
  else $.root().prepend(shim);

  return $.html();
}

const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'set-cookie',
  'strict-transport-security',
]);

async function handleProxy(req, res) {
  const target = req.query.url;
  if (!target) {
    res.status(400).send('Missing "url" query parameter');
    return;
  }

  try {
    await assertSafeUrl(target);
  } catch (err) {
    res.status(400).send(`Blocked request: ${err.message}`);
    return;
  }

  const targetOrigin = new URL(target).origin;

  // Prefer an explicit ?ref= (the embedding page passed by our own player /
  // rewritten sub-URLs), then fall back to recovering it from the incoming
  // Referer, then to the target's own origin. hotlink allowlists that require
  // the *site's* referer — not the resource's own origin — need this.
  const explicitRef =
    typeof req.query.ref === 'string' && /^https?:\/\//i.test(req.query.ref)
      ? req.query.ref
      : null;
  const originatingPage = explicitRef || originatingPageFromReferer(req);
  let refererValue = `${targetOrigin}/`;
  let originValue = targetOrigin;
  if (originatingPage) {
    refererValue = originatingPage;
    try {
      originValue = new URL(originatingPage).origin;
    } catch {}
  }

  const forwardHeaders = {
    'user-agent':
      req.headers['user-agent'] ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    referer: refererValue,
    origin: originValue,
  };
  if (req.headers['range']) forwardHeaders['range'] = req.headers['range'];
  if (req.headers['accept']) forwardHeaders['accept'] = req.headers['accept'];
  if (req.headers['accept-language']) forwardHeaders['accept-language'] = req.headers['accept-language'];

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: forwardHeaders,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
      redirect: 'follow',
    });
  } catch (err) {
    res.status(502).send(`Upstream fetch failed: ${err.message}`);
    return;
  }

  const finalUrl = upstream.url || target;
  const contentType = upstream.headers.get('content-type') || '';

  res.status(upstream.status);
  for (const [key, value] of upstream.headers.entries()) {
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    res.setHeader(key, value);
  }

  const isHtml = contentType.includes('text/html');
  const isCss = contentType.includes('text/css');
  const isM3u8 = contentType.includes('mpegurl') || finalUrl.split('?')[0].endsWith('.m3u8');

  if (isHtml || isCss || isM3u8) {
    const text = await upstream.text();
    const rewritten = isHtml
      ? rewriteHtml(text, finalUrl, originatingPage)
      : isCss
      ? rewriteCss(text, finalUrl, originatingPage)
      : rewriteM3u8(text, finalUrl, originatingPage);
    res.send(rewritten);
    return;
  }

  if (upstream.body) {
    Readable.fromWeb(upstream.body).pipe(res);
  } else {
    res.end();
  }
}

// Fetches an embed page server-side (with browser-like headers, since many
// players only emit their stream URL when they think a real browser asked)
// and scrapes it for a playable media URL — an HLS manifest (.m3u8) or a
// progressive file (.mp4/.webm). Returns { media, ref } where `ref` is the
// page URL to forward as the Referer when playing, or null if nothing found.
async function resolveMedia(pageUrl) {
  await assertSafeUrl(pageUrl);
  const pageOrigin = new URL(pageUrl).origin;
  const res = await fetch(pageUrl, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      referer: `${pageOrigin}/`,
      origin: pageOrigin,
    },
    redirect: 'follow',
  });
  const finalUrl = res.url || pageUrl;
  const contentType = res.headers.get('content-type') || '';

  // If the pasted URL *is* the media, just use it directly.
  if (
    contentType.includes('mpegurl') ||
    finalUrl.split('?')[0].endsWith('.m3u8') ||
    contentType.includes('video/mp4') ||
    finalUrl.split('?')[0].endsWith('.mp4')
  ) {
    return { media: finalUrl, ref: pageOrigin + '/' };
  }

  if (!contentType.includes('text/html') && !contentType.includes('javascript') && !contentType.includes('json')) {
    return null;
  }

  const body = await res.text();
  // Look for absolute or root-relative media URLs anywhere in the markup/JS.
  const patterns = [
    /https?:\\?\/\\?\/[^\s"'`<>]+?\.m3u8[^\s"'`<>]*/gi,
    /https?:\\?\/\\?\/[^\s"'`<>]+?\.mp4[^\s"'`<>]*/gi,
  ];
  const found = [];
  for (const re of patterns) {
    const matches = body.match(re) || [];
    for (let m of matches) {
      m = m.replace(/\\\//g, '/'); // unescape JSON-escaped slashes
      if (!found.includes(m)) found.push(m);
    }
  }
  if (found.length === 0) return null;

  // Prefer an HLS manifest (gives us quality levels) over a flat mp4.
  const m3u8 = found.find((u) => u.split('?')[0].toLowerCase().endsWith('.m3u8'));
  const media = m3u8 || found[0];
  return { media, ref: finalUrl };
}

async function handleResolve(req, res) {
  const target = req.query.url;
  if (!target) {
    res.status(400).json({ error: 'Missing "url" query parameter' });
    return;
  }
  try {
    const result = await resolveMedia(target);
    if (!result) {
      res.json({ media: null });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}

module.exports = { handleProxy, handleResolve, resolveMedia };
