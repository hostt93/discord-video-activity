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

function proxiedUrl(absoluteUrl) {
  return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
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

function rewriteCss(css, baseUrl) {
  return css.replace(/url\(([^)]+)\)/g, (match, rawUrl) => {
    const url = rawUrl.trim().replace(/^['"]|['"]$/g, '');
    if (!url || url.startsWith('data:')) return match;
    const abs = resolve(url, baseUrl);
    return abs ? `url("${proxiedUrl(abs)}")` : match;
  });
}

function rewriteM3u8(text, baseUrl) {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return trimmed.replace(/URI="([^"]+)"/, (m, uri) => {
          const abs = resolve(uri, baseUrl);
          return abs ? `URI="${proxiedUrl(abs)}"` : m;
        });
      }
      const abs = resolve(trimmed, baseUrl);
      return abs ? proxiedUrl(abs) : line;
    })
    .join('\n');
}

function buildShim(baseUrl) {
  // Rewrites URLs used by dynamic fetch()/XHR calls at runtime (this is
  // what makes JS-driven players like hls.js work, since they build segment
  // URLs on the fly rather than putting them in the initial HTML).
  return `<script>
(function () {
  var REAL_ORIGIN = ${JSON.stringify(baseUrl)};
  function toProxied(url) {
    try {
      var abs = new URL(url, REAL_ORIGIN).href;
      if (abs.indexOf(location.origin) === 0) return url;
      return '/proxy?url=' + encodeURIComponent(abs);
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

function rewriteHtml(html, baseUrl) {
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
            return size ? `${proxiedUrl(abs)} ${size}` : proxiedUrl(abs);
          })
          .join(', ');
        $el.attr(attr, rewritten);
        return;
      }

      if (/^(javascript:|data:|#|mailto:)/.test(val)) return;
      const abs = resolve(val, baseUrl);
      if (abs) $el.attr(attr, proxiedUrl(abs));
    });
  }

  $('style').each((_, el) => {
    const $el = $(el);
    $el.text(rewriteCss($el.text(), baseUrl));
  });
  $('[style]').each((_, el) => {
    const $el = $(el);
    $el.attr('style', rewriteCss($el.attr('style'), baseUrl));
  });

  const shim = buildShim(baseUrl);
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

  // Prefer the real embedding page (recovered from the incoming referer) so
  // hotlink allowlists that require the *site's* referer — not the resource's
  // own origin — are satisfied. Fall back to the target's own origin for
  // top-level loads, which satisfies simpler same-origin referer checks.
  const originatingPage = originatingPageFromReferer(req);
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
      ? rewriteHtml(text, finalUrl)
      : isCss
      ? rewriteCss(text, finalUrl)
      : rewriteM3u8(text, finalUrl);
    res.send(rewritten);
    return;
  }

  if (upstream.body) {
    Readable.fromWeb(upstream.body).pipe(res);
  } else {
    res.end();
  }
}

module.exports = { handleProxy };
