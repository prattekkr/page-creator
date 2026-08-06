'use strict';
/**
 * validate-page.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-layer page validation: Visual (Puppeteer + pixelmatch) + Content +
 * Structure + Accessibility.
 *
 * Scoring weights:
 *   Visual Similarity  40%
 *   Content Match      30%
 *   Structure Match    20%
 *   A11y Match         10%
 */

const puppeteer = require('puppeteer');
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');
const path = require('path');
const fs = require('fs');

// ── Viewport configurations ───────────────────────────────────────────────────
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile',  width: 375,  height: 812,  isMobile: true },
];

// ── Screenshot capture ────────────────────────────────────────────────────────
/**
 * Captures a full-page screenshot of a URL.
 * Returns { buffer, width, height, error }
 */
async function captureScreenshot(url, viewport = VIEWPORTS[0]) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({
      width:  viewport.width,
      height: viewport.height,
      isMobile: viewport.isMobile || false,
    });

    // Inject CSS to disable animations and hide dynamic elements
    await page.setExtraHTTPHeaders({ 'Cache-Control': 'no-cache' });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Suppress animations and transitions to get stable screenshots
    await page.addStyleTag({ content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
      video, iframe[src*="youtube"], iframe[src*="vimeo"] {
        visibility: hidden !important;
      }
    ` });

    // Wait for lazy images to load
    await page.evaluate(() => {
      return new Promise(resolve => {
        const imgs = document.querySelectorAll('img[loading="lazy"]');
        if (!imgs.length) { resolve(); return; }
        let count = 0;
        imgs.forEach(img => {
          img.loading = 'eager';
          if (img.complete) { if (++count === imgs.length) resolve(); }
          else { img.onload = img.onerror = () => { if (++count === imgs.length) resolve(); }; }
        });
        setTimeout(resolve, 3000); // fallback
      });
    });

    await new Promise(r => setTimeout(r, 800)); // final paint
    const buffer = await page.screenshot({ fullPage: true });
    const png    = PNG.sync.read(buffer);
    return { buffer, width: png.width, height: png.height, png };
  } catch (e) {
    return { buffer: null, error: e.message };
  } finally {
    if (browser) await browser.close();
  }
}

// ── Visual comparison ─────────────────────────────────────────────────────────
/**
 * Compares two PNG images using pixelmatch.
 * Returns { similarity (0-100), diffPng, diffPixels, totalPixels }
 */
function compareImages(png1, png2) {
  // Resize smaller to larger so dimensions match
  const maxW = Math.max(png1.width, png2.width);
  const maxH = Math.max(png1.height, png2.height);

  function padPng(png, w, h) {
    if (png.width === w && png.height === h) return png;
    const out = new PNG({ width: w, height: h });
    // Fill with white
    out.data.fill(255);
    PNG.bitblt(png, out, 0, 0, Math.min(png.width, w), Math.min(png.height, h), 0, 0);
    return out;
  }

  const a = padPng(png1, maxW, maxH);
  const b = padPng(png2, maxW, maxH);
  const diff = new PNG({ width: maxW, height: maxH });

  const diffPixels = pixelmatch(a.data, b.data, diff.data, maxW, maxH, {
    threshold: 0.15,
    includeAA: false,    // ignore anti-aliasing differences
  });

  const totalPixels = maxW * maxH;
  const similarity  = Math.round((1 - diffPixels / totalPixels) * 100 * 10) / 10;

  return {
    similarity,
    diffPixels,
    totalPixels,
    diffPng: diff,
    diffPercent: Math.round((diffPixels / totalPixels) * 1000) / 10,
  };
}

// ── DOM structure capture ─────────────────────────────────────────────────────
/**
 * Extracts structural metrics from a URL.
 * Returns heading hierarchy, landmark counts, link/button counts, image alts, etc.
 */
async function captureStructure(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    const structure = await page.evaluate(() => {
      const $ = s => [...document.querySelectorAll(s)];

      // Heading hierarchy
      const headings = $('h1,h2,h3,h4,h5,h6').map(h => ({
        level: parseInt(h.tagName[1]),
        text:  h.innerText.trim().slice(0, 80),
      }));

      // Landmarks
      const landmarks = {
        nav:     $('nav').length,
        main:    $('main').length,
        footer:  $('footer').length,
        section: $('section').length,
        article: $('article').length,
      };

      // Text content
      const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();

      // Images
      const images = $('img').map(img => ({
        src:    img.src,
        alt:    img.alt || '',
        hasAlt: !!img.alt,
      }));

      // Links
      const links = $('a[href]').map(a => ({
        href: a.href,
        text: a.innerText.trim().slice(0, 60),
        isInternal: a.href.startsWith(location.origin),
      }));

      // Buttons / CTAs
      const buttons = $('button, a.btn, [role="button"]').map(b => b.innerText.trim().slice(0, 60));

      // Videos
      const videos = $('video, iframe[src*="youtube"], iframe[src*="brightcove"]').length;

      // A11y signals
      const ariaLabels  = $('[aria-label]').length;
      const ariaLandmarks = $('[role="main"],[role="navigation"],[role="banner"],[role="contentinfo"]').length;
      const skipLinks   = $('a[href="#main"],[href="#content"],[href^="#skip"]').length;

      return {
        headings,
        headingTree: headings.map(h => `h${h.level}`).join('>'),
        landmarks,
        textLength: bodyText.length,
        textPreview: bodyText.slice(0, 200),
        images: { total: images.length, withAlt: images.filter(i => i.hasAlt).length },
        links:  { total: links.length,  internal: links.filter(l => l.isInternal).length },
        buttons: buttons.slice(0, 20),
        videos,
        a11y: { ariaLabels, ariaLandmarks, skipLinks },
      };
    });

    return { ok: true, ...structure };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (browser) await browser.close();
  }
}

// ── Content comparison ────────────────────────────────────────────────────────
function scoreContent(aem, eds) {
  const issues = [];
  let score = 100;

  // Text length similarity (within ±20% is fine for translations/minor edits)
  if (aem.textLength && eds.textLength) {
    const ratio = Math.min(aem.textLength, eds.textLength) / Math.max(aem.textLength, eds.textLength);
    const textScore = Math.round(ratio * 100);
    if (textScore < 80) {
      issues.push(`Text length mismatch: AEM ${aem.textLength} chars vs EDS ${eds.textLength} chars (${textScore}% similar)`);
      score -= (100 - textScore) * 0.5;
    }
  }

  // Heading count
  const aemH = aem.headings?.length || 0, edsH = eds.headings?.length || 0;
  if (aemH !== edsH) {
    const diff = Math.abs(aemH - edsH);
    issues.push(`Heading count: AEM has ${aemH}, EDS has ${edsH} (+${diff} diff)`);
    score -= diff * 3;
  }

  // Image count
  const aemI = aem.images?.total || 0, edsI = eds.images?.total || 0;
  if (Math.abs(aemI - edsI) > 1) {
    issues.push(`Image count: AEM has ${aemI}, EDS has ${edsI}`);
    score -= Math.abs(aemI - edsI) * 4;
  }

  // Image alt text coverage
  const aemAltPct = aemI ? Math.round((aem.images?.withAlt || 0) / aemI * 100) : 100;
  const edsAltPct = edsI ? Math.round((eds.images?.withAlt || 0) / edsI * 100) : 100;
  if (edsAltPct < 80) {
    issues.push(`Low alt text coverage in EDS: ${edsAltPct}% (${eds.images?.withAlt}/${edsI} images)`);
    score -= (80 - edsAltPct) * 0.3;
  }

  // Link count (allow ±20%)
  const aemL = aem.links?.total || 0, edsL = eds.links?.total || 0;
  if (aemL && edsL) {
    const ratio = Math.min(aemL, edsL) / Math.max(aemL, edsL);
    if (ratio < 0.8) {
      issues.push(`Link count: AEM ${aemL} vs EDS ${edsL} (${Math.round(ratio * 100)}% similar)`);
      score -= (1 - ratio) * 20;
    }
  }

  return { score: Math.max(0, Math.round(score)), issues };
}

// ── Structure comparison ──────────────────────────────────────────────────────
function scoreStructure(aem, eds) {
  const issues = [];
  let score = 100;

  // Heading hierarchy (h1>h2>h3…)
  const aemTree = aem.headingTree || '', edsTree = eds.headingTree || '';
  if (aemTree && edsTree && aemTree !== edsTree) {
    // Levenshtein-based similarity for the tree strings
    const sim = strSimilarity(aemTree, edsTree);
    if (sim < 0.9) {
      issues.push(`Heading hierarchy differs: AEM "${aemTree}" vs EDS "${edsTree}"`);
      score -= (1 - sim) * 40;
    }
  } else if (aemTree && !edsTree) {
    issues.push('EDS page has no headings');
    score -= 30;
  }

  // Main landmark
  if ((aem.landmarks?.main || 0) > 0 && (eds.landmarks?.main || 0) === 0) {
    issues.push('EDS page is missing <main> landmark');
    score -= 10;
  }

  // Video count
  if ((aem.videos || 0) !== (eds.videos || 0)) {
    issues.push(`Video count: AEM ${aem.videos} vs EDS ${eds.videos}`);
    score -= 5;
  }

  // Button/CTA count
  const aemB = aem.buttons?.length || 0, edsB = eds.buttons?.length || 0;
  if (aemB && edsB && Math.abs(aemB - edsB) > 2) {
    issues.push(`Button/CTA count: AEM ${aemB} vs EDS ${edsB}`);
    score -= Math.abs(aemB - edsB) * 2;
  }

  return { score: Math.max(0, Math.round(score)), issues };
}

// ── A11y comparison ───────────────────────────────────────────────────────────
function scoreA11y(aem, eds) {
  const issues = [];
  let score = 100;

  // Image alt coverage
  const edsI = eds.images?.total || 0;
  const edsAltPct = edsI ? Math.round((eds.images?.withAlt || 0) / edsI * 100) : 100;
  if (edsAltPct < 90) {
    issues.push(`Image alt coverage: ${edsAltPct}% (should be ≥90%)`);
    score -= (90 - edsAltPct) * 0.5;
  }

  // ARIA landmarks
  const aemA = aem.a11y?.ariaLandmarks || 0, edsA = eds.a11y?.ariaLandmarks || 0;
  if (aemA > 0 && edsA === 0) {
    issues.push('EDS page has no ARIA landmarks');
    score -= 15;
  }

  // Skip links
  const aemSkip = aem.a11y?.skipLinks || 0, edsSkip = eds.a11y?.skipLinks || 0;
  if (aemSkip > 0 && edsSkip === 0) {
    issues.push('EDS page is missing skip-to-content links');
    score -= 5;
  }

  return { score: Math.max(0, Math.round(score)), issues };
}

// ── Final scoring ─────────────────────────────────────────────────────────────
function computeFinalScore(visual, content, structure, a11y) {
  return Math.round(visual * 0.40 + content * 0.30 + structure * 0.20 + a11y * 0.10);
}

function scoreLabel(score) {
  if (score >= 95) return { label: 'Excellent', color: '#15803d' };
  if (score >= 85) return { label: 'Good',      color: '#ca8a04' };
  if (score >= 70) return { label: 'Fair',       color: '#d97706' };
  return                 { label: 'Poor',        color: '#dc2626' };
}

// ── String similarity helper ──────────────────────────────────────────────────
function strSimilarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length < b.length ? a : b;
  if (longer.length === 0) return 1;
  return (longer.length - editDistance(longer, shorter)) / longer.length;
}
function editDistance(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = a[i - 1] === b[j - 1] ? dp[j - 1] : Math.min(dp[j - 1] + 1, prev + 1, dp[j] + 1);
      dp[j - 1] = prev;
      prev = cur;
    }
    dp[b.length] = prev;
  }
  return dp[b.length];
}

// ── Cache helpers ─────────────────────────────────────────────────────────────
const CACHE_DIR = path.join(__dirname, '.validation-cache');
function ensureCache() { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }); }

function cacheKey(url, viewport) {
  return encodeURIComponent(url.replace(/https?:\/\//, '')) + '_' + viewport + '.png';
}

function saveDiffImage(diffPng, id) {
  ensureCache();
  const buf = PNG.sync.write(diffPng);
  const file = path.join(CACHE_DIR, `diff_${id}.png`);
  fs.writeFileSync(file, buf);
  return `/api/validate-page/diff/${id}.png`;
}

function saveScreenshot(buffer, id, side) {
  ensureCache();
  const file = path.join(CACHE_DIR, `${id}_${side}.png`);
  fs.writeFileSync(file, buffer);
  return `/api/validate-page/screenshot/${id}_${side}.png`;
}

// ── Main validation function ──────────────────────────────────────────────────
/**
 * Runs full validation between aemUrl and edsUrl.
 * @param {string} aemUrl - Live AEM page URL
 * @param {string} edsUrl - EDS page URL (live or preview)
 * @param {object} opts   - { id, viewports: ['desktop','mobile'] }
 * @returns Validation result object
 */
async function validatePage(aemUrl, edsUrl, opts = {}) {
  const id        = opts.id || Date.now().toString();
  const vpNames   = opts.viewports || ['desktop'];
  const viewports = vpNames.map(n => VIEWPORTS.find(v => v.name === n) || VIEWPORTS[0]);

  const result = {
    id,
    aemUrl,
    edsUrl,
    timestamp: new Date().toISOString(),
    viewports: {},
    structure: null,
    finalScore: null,
    scores: {},
    issues: [],
    screenshotUrls: {},
    diffUrls: {},
    ok: false,
    error: null,
  };

  try {
    // ── 1. Screenshot + Visual for each viewport ───────────────────────────
    const visualScores = [];
    for (const vp of viewports) {
      const [aemShot, edsShot] = await Promise.all([
        captureScreenshot(aemUrl, vp),
        captureScreenshot(edsUrl, vp),
      ]);

      if (aemShot.error || edsShot.error) {
        result.issues.push(`Screenshot failed (${vp.name}): ${aemShot.error || edsShot.error}`);
        continue;
      }

      // Save screenshots
      result.screenshotUrls[`${vp.name}_aem`] = saveScreenshot(aemShot.buffer, id, `${vp.name}_aem`);
      result.screenshotUrls[`${vp.name}_eds`] = saveScreenshot(edsShot.buffer, id, `${vp.name}_eds`);

      // Visual comparison
      const cmp = compareImages(aemShot.png, edsShot.png);
      result.viewports[vp.name] = {
        similarity: cmp.similarity,
        diffPixels: cmp.diffPixels,
        totalPixels: cmp.totalPixels,
        diffPercent: cmp.diffPercent,
      };
      result.diffUrls[vp.name] = saveDiffImage(cmp.diffPng, `${id}_${vp.name}`);
      visualScores.push(cmp.similarity);

      if (cmp.similarity < 95) {
        result.issues.push(`[${vp.name}] Visual similarity: ${cmp.similarity}% (${cmp.diffPixels.toLocaleString()} different pixels)`);
      }
    }

    const visualScore = visualScores.length
      ? Math.round(visualScores.reduce((a, b) => a + b, 0) / visualScores.length * 10) / 10
      : 0;

    // ── 2. DOM Structure ──────────────────────────────────────────────────
    const [aemStruct, edsStruct] = await Promise.all([
      captureStructure(aemUrl),
      captureStructure(edsUrl),
    ]);

    result.structure = { aem: aemStruct, eds: edsStruct };

    const contentResult   = (aemStruct.ok && edsStruct.ok) ? scoreContent(aemStruct, edsStruct)   : { score: 0, issues: ['Could not analyse content'] };
    const structureResult = (aemStruct.ok && edsStruct.ok) ? scoreStructure(aemStruct, edsStruct) : { score: 0, issues: ['Could not analyse structure'] };
    const a11yResult      = edsStruct.ok                   ? scoreA11y(aemStruct, edsStruct)      : { score: 0, issues: ['Could not analyse a11y'] };

    result.scores = {
      visual:    visualScore,
      content:   contentResult.score,
      structure: structureResult.score,
      a11y:      a11yResult.score,
    };

    result.issues.push(...contentResult.issues, ...structureResult.issues, ...a11yResult.issues);

    // ── 3. Final score ────────────────────────────────────────────────────
    result.finalScore = computeFinalScore(
      visualScore,
      contentResult.score,
      structureResult.score,
      a11yResult.score,
    );
    result.scoreLabel = scoreLabel(result.finalScore);
    result.ok = true;

  } catch (e) {
    result.error = e.message;
  }

  return result;
}

// ── Cached diff/screenshot file server ───────────────────────────────────────
function serveCachedFile(filename) {
  const file = path.join(CACHE_DIR, filename);
  if (!fs.existsSync(file)) return null;
  return file;
}

module.exports = { validatePage, serveCachedFile, CACHE_DIR };
