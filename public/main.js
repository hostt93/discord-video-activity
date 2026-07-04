// Accepts either a raw URL or a full <iframe ...> embed snippet pasted by
// the user, extracts the target link, and routes it through our own
// /proxy endpoint so it can be loaded regardless of what domain it's on.
function extractUrl(input) {
  const trimmed = input.trim();
  const iframeMatch = trimmed.match(/<iframe[^>]*\ssrc=["']([^"']+)["']/i);
  return iframeMatch ? iframeMatch[1] : trimmed;
}

function toAbsolute(url) {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

function loadVideo(rawInput) {
  const url = toAbsolute(extractUrl(rawInput));
  if (!url) return;
  document.getElementById('player').src = `/proxy?url=${encodeURIComponent(url)}`;
  localStorage.setItem('lastEmbedUrl', rawInput);
}

const input = document.getElementById('url-input');
const btn = document.getElementById('load-btn');

btn.addEventListener('click', () => loadVideo(input.value));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadVideo(input.value);
});

const last = localStorage.getItem('lastEmbedUrl');
if (last) {
  input.value = last;
  loadVideo(last);
}

async function initDiscordSdk() {
  try {
    const res = await fetch('/config');
    const { clientId } = await res.json();
    if (!clientId) return;

    const { DiscordSDK } = await import('https://esm.sh/@discord/embedded-app-sdk@1');
    const discordSdk = new DiscordSDK(clientId);
    await discordSdk.ready();
    console.log('Discord Activity SDK ready');
  } catch (err) {
    console.warn('Discord Activity SDK did not initialize:', err);
  }
}

initDiscordSdk();
