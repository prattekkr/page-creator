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
  let attempted = 0;
  for (let i = 0; i < tries; i++) {
    attempted++;
    let r; try { r = await curlOnce(pageUrl); } catch (e) { last = e.message; await sleep(300); continue; }
    if (r.code >= 200 && r.code < 400) return r.html;
    last = 'HTTP ' + (r.code || '?');
    if (r.code === 404 || r.code === 410) break;      // genuinely missing — don't retry
    await sleep(300 + i * 250);                        // brief backoff between challenges
  }
  throw new Error(last + ' (after ' + attempted + ' tr' + (attempted === 1 ? 'y' : 'ies') + ')');
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
      // (meaning the caption lives in DAM metadata — always fetch the live resolved value even when
      // AEM itself set getCaptionFromDAM=true, because the DAM metadata is not in the JCR XML).
      // we don't rely on EDS fetching it at render time, and turn off the DAM-fetch flag).
        if (k && maps.caption[k] && (!clean(p.caption) || p.getCaptionFromDAM === 'true')) {
        p.caption = maps.caption[k];
        p.getCaptionFromDAM = '{Boolean}false';
        // Always enable the display flag when a caption is present. When the image
        // was authored with getCaptionFromDAM=true the JCR XML carries no caption text,
        // so displayCaptionBelowImage was never set at parse time — set it now.
        p.displayCaptionBelowImage = '{Boolean}false';
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

// ── DAM metadata caption fallback ────────────────────────────────────────────
// Called AFTER backfillA11y() (XML fill + live scraping).
// For every custom-image block that still has no caption but has an image prop,
// fetch dc:description (fallback dc:title) from the AEM DAM asset metadata.
// Only runs when aemHost + auth are provided.  Results are limited to
// MAX_DAM_LOOKUPS unique assets to avoid hammering the author instance.

const MAX_DAM_LOOKUPS = 40;

// Extract a /content/dam/... path from the image prop value.
// Handles:
//   1. Raw DAM path:          /content/dam/foo/image.jpg
//   2. DM Open API URL:       https://delivery-p*.adobeaemcloud.com/adobe/assets/urn:...
//      → reverse-lookup via assetMap (dmUrl → damPath) built from pathMap.assetMap
//   3. Full AEM URL with dam:  https://author.aem.com/content/dam/foo/image.jpg
// Returns the /content/dam/... path, or null if not resolvable.
function damPathFromImageProp(val, reverseAssetMap) {
  if (!val || typeof val !== 'string') return null;
  const s = val.trim().split('?')[0];
  // 1. Already a /content/dam/ path
  const idx = s.indexOf('/content/dam/');
  if (idx >= 0) return s.slice(idx);
  // 2. DM Open API delivery URL — reverse-lookup in assetMap
  if (reverseAssetMap && s.startsWith('https://')) {
    const found = reverseAssetMap.get(s);
    if (found) return found;
    // Also try without trailing slash / query (already stripped above)
    // Some entries have trailing slashes in the map
    const foundSlash = reverseAssetMap.get(s + '/');
    if (foundSlash) return foundSlash;
  }
  return null;
}

// Fetch DAM asset metadata JSON from a full URL.
// Returns the parsed JSON object, or null on any failure.
async function fetchDamMetaUrl(fullUrl, auth) {
  try {
    const r = await fetch(fullUrl, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(10000),
    });
    console.log(`[dam-meta]   GET ${fullUrl} → HTTP ${r.status}`);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.log(`[dam-meta]   GET ${fullUrl} → ERROR: ${e.message}`);
    return null;
  }
}

async function backfillCaptionsFromDam(sections, aemHost, auth) {
  const host = (aemHost || '').trim().replace(/\/+$/, '');
  if (!host || !auth) return { captionFromDam: 0 };

  // Build reverse asset map: DM Open API URL → /content/dam/... path
  // Used to resolve delivery-domain image URLs back to their DAM path for metadata lookup.
  const reverseAssetMap = new Map();
  try {
    const fs = require('fs');
    const nodePath = require('path');
    const pmPath = nodePath.join(__dirname, 'path-map.json');
    if (fs.existsSync(pmPath)) {
      const pm = JSON.parse(fs.readFileSync(pmPath, 'utf8'));
      const assetMap = pm.assetMap || {};
      // assetMap format: { "/content/dam/...": "https://delivery-p*.adobeaemcloud.com/..." }
      for (const [damPath, dmUrl] of Object.entries(assetMap)) {
        if (dmUrl && typeof dmUrl === 'string' && dmUrl.startsWith('https://')) {
          reverseAssetMap.set(dmUrl.trim().split('?')[0], damPath);
        }
      }
      console.log(`[dam-caption] built reverse asset map: ${reverseAssetMap.size} DM URL → DAM path entries`);
    }
  } catch (e) {
    console.warn(`[dam-caption] could not build reverse asset map: ${e.message}`);
  }

  // Collect all custom-image blocks that still have no caption.
  // NOTE: do NOT check p['jcr:title'] here — that's a JCR system property,
  // not the rendered caption field. Only check p.caption (the EDS prop).
  const targets = [];
  const visit = (b, depth = 0, path = '') => {
    if (!b || typeof b !== 'object') return;
    const p = b.props || (b.props = {});
    const myPath = `${path}/${b.type || '?'}`;
    const childCount  = (b.children || []).length;
    const blocksCount = (b.blocks   || []).length;
    if (depth <= 2) {
      console.log(`[dam-scan] ${'  '.repeat(depth)}${myPath} (children:${childCount} blocks:${blocksCount})`);
    }
    if (b.type === 'custom-image') {
      const hasCaption = !!clean(p.caption || '');
      const imgVal = p.image || p.imageReference || p.fileReference || '';
      const damPath = damPathFromImageProp(imgVal, reverseAssetMap);
      console.log(`[dam-scan] ${'  '.repeat(depth)}  → custom-image: image="${imgVal}" caption="${p.caption||''}" hasCaption=${hasCaption} damPath=${damPath}`);
      if (!hasCaption && damPath) targets.push({ block: b, damPath });
      else if (hasCaption) console.log(`[dam-scan] ${'  '.repeat(depth)}  (skipped — caption already set)`);
      else if (!damPath)   console.log(`[dam-scan] ${'  '.repeat(depth)}  (skipped — no DAM path resolvable from image value; image="${imgVal}")`);
    }
    // recurse into children AND nested blocks (grid-section stores content in children;
    // some composed structures store nested blocks in .blocks)
    for (const c of (b.children || [])) visit(c, depth + 1, myPath);
    for (const c of (b.blocks   || [])) visit(c, depth + 1, myPath);
  };
  console.log(`[dam-scan] scanning ${(sections||[]).length} sections for custom-image blocks without captions`);
  for (const s of (sections || [])) {
    console.log(`[dam-scan] section type=${s.type} blocks=${(s.blocks||[]).length} children=${(s.children||[]).length}`);
    for (const b of (s.blocks || [])) visit(b, 1, `[${s.type}]`);
    for (const b of (s.children || [])) visit(b, 1, `[${s.type}]`);
  }

  if (!targets.length) return { captionFromDam: 0 };

  // Deduplicate DAM paths — fetch each asset only once.
  const uniquePaths = [...new Set(targets.map(t => t.damPath))].slice(0, MAX_DAM_LOOKUPS);
  console.log(`[dam-caption] ${targets.length} image(s) need caption, ${uniquePaths.length} unique DAM path(s):`);
  uniquePaths.forEach((p, i) => console.log(`  [${i+1}] ${p}`));

  const metaMap = new Map(); // damPath → caption string | null
  await Promise.all(uniquePaths.map(async damPath => {
    // AEM supports both URL forms for jcr:content — try both.
    // Standard Sling URL: /content/dam/foo/image.jpg/_jcr_content/metadata.json
    // Raw JCR path:       /content/dam/foo/image.jpg/jcr:content/metadata.json
    const p = damPath.split('?')[0].replace(/\/+$/, '');

    const url1 = `${host}${p}/_jcr_content/metadata.json`;
    const url2 = `${host}${p}/jcr:content/metadata.json`;
    const url3 = `${host}${p}.json`;

    console.log(`[dam-caption] trying: ${url1}`);
    let meta = await fetchDamMetaUrl(url1, auth);
    if (meta) {
      console.log(`[dam-caption]   ✓ got metadata from url1, keys: [${Object.keys(meta).join(', ')}]`);
    } else {
      console.log(`[dam-caption]   ✗ url1 returned nothing, trying: ${url2}`);
      meta = await fetchDamMetaUrl(url2, auth);
      if (meta) {
        console.log(`[dam-caption]   ✓ got metadata from url2, keys: [${Object.keys(meta).join(', ')}]`);
      } else {
        console.log(`[dam-caption]   ✗ url2 returned nothing, trying: ${url3}`);
        meta = await fetchDamMetaUrl(url3, auth);
        if (meta && typeof meta === 'object') {
          const nested = meta['jcr:content']?.metadata || meta['_jcr_content']?.metadata;
          if (nested) {
            console.log(`[dam-caption]   ✓ got nested metadata from url3, keys: [${Object.keys(nested).join(', ')}]`);
            meta = nested;
          } else if (!meta['dc:description'] && !meta['dc:title']) {
            console.log(`[dam-caption]   ✗ url3 has no dc:description/dc:title, keys: [${Object.keys(meta).join(', ')}]`);
            meta = null;
          } else {
            console.log(`[dam-caption]   ✓ got metadata from url3 (flat), keys: [${Object.keys(meta).join(', ')}]`);
          }
        } else {
          console.log(`[dam-caption]   ✗ all 3 URLs failed for: ${p}`);
        }
      }
    }

    if (!meta) { metaMap.set(damPath, null); return; }

    const desc = Array.isArray(meta['dc:description']) ? meta['dc:description'][0]
               : typeof meta['dc:description'] === 'string' ? meta['dc:description'] : null;
    const title = Array.isArray(meta['dc:title']) ? meta['dc:title'][0]
                : typeof meta['dc:title'] === 'string' ? meta['dc:title'] : null;
    const val = desc || title || null;

    console.log(`[dam-caption]   dc:description="${desc}" | dc:title="${title}" → using: "${val}"`);
    metaMap.set(damPath, val ? String(val).trim() : null);
  }));

  // Apply to blocks.
  let captionFromDam = 0;
  for (const { block, damPath } of targets) {
    const cap = metaMap.get(damPath);
    if (cap) {
      console.log(`[dam-caption] ✓ filled caption for "${damPath}" → "${cap}"`);
      block.props.caption = cap;
      block.props.displayCaptionBelowImage = '{Boolean}false';
      captionFromDam++;
    } else {
      console.log(`[dam-caption] ✗ no caption found for "${damPath}"`);
    }
  }
  console.log(`[dam-caption] summary: ${captionFromDam}/${targets.length} captions filled`);
  return { captionFromDam };
}

module.exports = { fetchRenderedHtml, extractA11y, backfillA11y, backfillCaptionsFromDam, baseKey };
