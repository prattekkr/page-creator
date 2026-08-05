// Accessibility backfill from the live AEM rendered HTML.
// ~70% of AEM images have no alt in the JCR XML (it lives in DAM metadata, resolved only at
// render). This fetches the rendered page and fills empty imageAlt / caption / cta aria-label
// on the generated canvas by matching image filename and CTA link/text.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// basename of a path/url without query or extension, lowercased — bridges AEM path ↔ rendered src
function baseKey(s) {
  if (!s) return '';
  let b = String(s).split('?')[0].replace(/\/+$/, '').split('/').pop() || '';
  try { b = decodeURIComponent(b); } catch {}
  return b.replace(/\.[a-z0-9]{2,5}$/i, '').trim().toLowerCase();
}
const clean = t => (t || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
// rendered aria-labels often append UI hints ("Opens in same/new window/tab") — strip them
const stripUi = t => clean(t).replace(/\s*(opens in (a )?(new|same) (window|tab)|external link)\.?$/i, '').trim();

// Guard against SSRF — only public https hosts.
function assertPublicHttps(u) {
  let url; try { url = new URL(u); } catch { throw new Error('Invalid URL'); }
  if (url.protocol !== 'https:') throw new Error('Only https URLs are allowed');
  const h = url.hostname;
  if (/^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|::1)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local'))
    throw new Error('Refusing to fetch a private/loopback host');
  return url;
}

const { execFile } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function curlOnce(pageUrl) {
  return new Promise((resolve, reject) => {
    execFile('curl', [
      '-sS', '-L', '--compressed', '--max-time', '20', '--max-redirs', '5',
      '-A', UA,
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '-H', 'Accept-Language: de-CH,de;q=0.9,en;q=0.8',
      '-w', '\n__HTTP_%{http_code}__', pageUrl,
    ], { maxBuffer: 20 * 1024 * 1024, timeout: 25000 }, (err, stdout) => {
      if (err && !stdout) return reject(new Error('curl failed: ' + err.message));
      const m = /\n__HTTP_(\d+)__\s*$/.exec(stdout || '');
      const code = m ? +m[1] : 0;
      const html = (stdout || '').replace(/\n__HTTP_\d+__\s*$/, '');
      resolve({ code, html });
    });
  });
}

// abbvie's edge (Akamai/CF) blocks Node's TLS fingerprint with 403 regardless of headers,
// and even lets curl through only ~50% of the time (intermittent bot challenge). So shell
// out to curl AND retry on 403/5xx — ~4 tries pushes success past ~95%.
async function fetchRenderedHtml(pageUrl, tries = 8) {
  assertPublicHttps(pageUrl);
  let last = '?';
  for (let i = 0; i < tries; i++) {
    let r; try { r = await curlOnce(pageUrl); } catch (e) { last = e.message; await sleep(300); continue; }
    if (r.code >= 200 && r.code < 400) return r.html;
    last = 'HTTP ' + (r.code || '?');
    if (r.code === 404 || r.code === 410) break;      // genuinely missing — don't retry
    await sleep(300 + i * 250);                        // brief backoff between challenges
  }
  throw new Error(last + ' (after ' + tries + ' tries)');
}

// Parse the rendered HTML into lookup maps.
function extractA11y(html) {
  const alt = {}, caption = {}, ctaByHref = {}, ctaByText = {};
  // images: src + alt (+ figcaption if wrapped in <figure>)
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = (tag.match(/\ssrc="([^"]+)"/i) || [])[1] || (tag.match(/\sdata-src="([^"]+)"/i) || [])[1];
    const a = (tag.match(/\salt="([^"]*)"/i) || [])[1];
    const k = baseKey(src);
    if (k && a && clean(a) && !alt[k]) alt[k] = clean(a);
  }
  // <figure> … <img src> … <figcaption>caption</figcaption>
  for (const m of html.matchAll(/<figure\b[\s\S]{0,1500}?<\/figure>/gi)) {
    const block = m[0];
    const src = (block.match(/<img\b[^>]*\ssrc="([^"]+)"/i) || [])[1];
    const cap = (block.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i) || [])[1];
    const k = baseKey(src);
    if (k && cap) { const c = clean(cap.replace(/<[^>]+>/g, ' ')); if (c) caption[k] = c; }
  }
  // links/buttons carrying an aria-label
  for (const m of html.matchAll(/<a\b[^>]*\saria-label="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = stripUi(m[1]); if (!label) continue;
    const tag = m[0];
    const href = (tag.match(/\shref="([^"]+)"/i) || [])[1];
    const text = clean(m[2].replace(/<[^>]+>/g, ' '));
    const hk = baseKey(href);
    if (hk && !ctaByHref[hk]) ctaByHref[hk] = label;
    if (text && !ctaByText[text.toLowerCase()]) ctaByText[text.toLowerCase()] = label;
  }
  return { alt, caption, ctaByHref, ctaByText };
}

// Walk canvas sections[] and fill gaps. Returns counts of what was filled.
function backfillA11y(sections, maps) {
  const stats = { imageAlt: 0, caption: 0, ctaAria: 0, videoPoster: 0 };
  const visit = b => {
    if (!b || typeof b !== 'object') return;
    const p = b.props || (b.props = {});
    if (b.type === 'custom-image' || b.type === 'hero-container-item') {
      const k = baseKey(p.image);
      if (k && maps.alt[k]) {
        // hero alt is always a filename guess — override it; custom-image only if empty
        if (b.type === 'hero-container-item' || !clean(p.imageAlt)) { if (p.imageAlt !== maps.alt[k]) { p.imageAlt = maps.alt[k]; stats.imageAlt++; } }
      }
      // Fill caption from live site when: (a) no caption is set yet, OR (b) getCaptionFromDAM=true
      // (meaning the caption lives in DAM metadata — bake the resolved value in as literal text so
      // we don't rely on EDS fetching it at render time, and turn off the DAM-fetch flag).
      if (k && maps.caption[k] && (!clean(p.caption) || p.getCaptionFromDAM === 'true')) {
        p.caption = maps.caption[k];
        p.getCaptionFromDAM = 'false';
        stats.caption++;
      }
    }
    if (b.type === 'cta' && !clean(p['aria-label'])) {
      const label = maps.ctaByHref[baseKey(p.link)] || maps.ctaByText[clean(p.linkText).toLowerCase()];
      if (label) { p['aria-label'] = label; stats.ctaAria++; }
    }
    if (b.type === 'video' && !clean(p.posterAccessibilityLabel)) {
      const k = baseKey(p.placeholderImage || p.fileReference || p.image);
      if (k && maps.alt[k]) { p.posterAccessibilityLabel = maps.alt[k]; stats.videoPoster++; }
    }
    for (const c of (b.children || [])) visit(c);
  };
  for (const s of sections) { for (const b of (s.blocks || [])) visit(b); }
  return stats;
}

module.exports = { fetchRenderedHtml, extractA11y, backfillA11y, baseKey };
