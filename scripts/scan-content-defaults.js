'use strict';
/**
 * Scans all child pages under our-people/ in AEM, extracts real component
 * content (by model type), and writes content-defaults.json.
 *
 * Run: node scripts/scan-content-defaults.js
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const BASE   = 'https://author-p157365-e1665873.adobeaemcloud.com';
const PARENT = '/content/abbvie-nextgen-eds/corporate/abbvie-com/language-masters/en/science/our-people';
const CREDS  = Buffer.from('migration:migration').toString('base64');

// Properties that are structural/metadata — never include in content defaults
const STRIP = new Set([
  'jcr:primaryType','jcr:mixinTypes','jcr:created','jcr:createdBy',
  'jcr:lastModified','jcr:lastModifiedBy','jcr:uuid','jcr:baseVersion',
  'jcr:isCheckedOut','jcr:versionHistory','jcr:description',
  'cq:lastModified','cq:lastModifiedBy','cq:lastRolledout','cq:lastRolledoutBy',
  'cq:lastReplicationAction','cq:lastReplicated','cq:lastReplicatedBy',
  'cq:lastReplicatedBy_publish','cq:lastReplicatedBy_preview',
  'cq:lastReplicated_publish','cq:lastReplicated_preview',
  'cq:lastReplicationAction_publish','cq:lastReplicationAction_preview',
  'cq:isDelivered','cq:template','cq:tags',
  'sling:resourceType','sling:resourceSuperType',
  'model','aueComponentId','filter','language','blockId','modelFields',
  'name','identifier',':type','jcr:title',
]);

// Also skip these patterns
function shouldStrip(key) {
  return STRIP.has(key) || /^(jcr:|cq:|sling:|rep:|:)/.test(key);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Basic ${CREDS}` } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed for ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// Walk JCR tree, collect { model -> [candidate props, ...] }
function walkNode(node, collected) {
  if (!node || typeof node !== 'object') return;

  const modelType = node['model'];
  if (modelType) {
    const props = {};
    let filled = 0;
    for (const [k, v] of Object.entries(node)) {
      if (shouldStrip(k)) continue;
      if (typeof v === 'object') continue; // skip child nodes
      // Only include if non-empty
      if (v === '' || v === null || v === undefined) continue;
      // Skip default/boring values
      if (v === 'none' || v === false) continue;
      props[k] = v;
      filled++;
    }
    if (filled > 0) {
      if (!collected[modelType]) collected[modelType] = [];
      collected[modelType].push({ props, score: filled });
    }
  }

  // Recurse into children
  for (const [k, v] of Object.entries(node)) {
    if (shouldStrip(k) || typeof v !== 'object' || Array.isArray(v)) continue;
    walkNode(v, collected);
  }
}

// Pick the candidate with the most filled fields for each model type
function pickBest(collected) {
  const result = {};
  for (const [modelType, candidates] of Object.entries(collected)) {
    candidates.sort((a, b) => b.score - a.score);
    result[modelType] = candidates[0].props;
  }
  return result;
}

async function main() {
  // 1. Get child page names
  console.log('Fetching child pages…');
  const parentJson = await fetchJson(`${BASE}${PARENT}.1.json`);
  const childNames = Object.keys(parentJson).filter(k =>
    typeof parentJson[k] === 'object' && !k.startsWith('jcr:') && !k.startsWith('rep:') && !k.startsWith(':')
  );
  console.log(`Found ${childNames.length} child pages: ${childNames.join(', ')}`);

  const collected = {};

  // 2. Also scan the our-people page itself
  const pages = ['', ...childNames.map(n => `/${n}`)];

  for (const suffix of pages) {
    const url = `${BASE}${PARENT}${suffix}/jcr:content.infinity.json`;
    console.log(`Scanning ${PARENT}${suffix}…`);
    try {
      const pageJson = await fetchJson(url);
      // Walk root node (sections are under root)
      const root = pageJson.root || pageJson;
      walkNode(root, collected);
      // Also capture page-level metadata from jcr:content top level
      if (!suffix) {
        // skip for now — page metadata is handled separately
      }
    } catch (e) {
      console.warn(`  ⚠ Skipped (${e.message})`);
    }
  }

  // 3. Pick best candidate per model type
  const defaults = pickBest(collected);

  // 4. Report
  const types = Object.keys(defaults).sort();
  console.log(`\nCollected defaults for ${types.length} component types:`);
  types.forEach(t => {
    const keys = Object.keys(defaults[t]);
    console.log(`  ${t}: [${keys.join(', ')}]`);
  });

  // 5. Write output
  const outPath = path.join(__dirname, '..', 'content-defaults.json');
  fs.writeFileSync(outPath, JSON.stringify(defaults, null, 2), 'utf8');
  console.log(`\n✔ Written to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
