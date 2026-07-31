'use strict';

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const puppeteer  = require('puppeteer');
const { XMLParser } = require('fast-xml-parser');

// ── Migration map (AEM Sites resourceType → EDS block) ───────────────────────
let migrationMap = { componentMap: {}, layoutResources: [], metaKeys: [], jcrSystemProps: [] };
try {
  migrationMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'migration-map.json'), 'utf8'));
} catch (_) { console.warn('[migration] migration-map.json not found'); }

// ── EDS component model map (loaded once at startup for typedAemValue) ────────
let _modelMapCache = {};
try {
  const _models = JSON.parse(fs.readFileSync(path.join(__dirname, 'component-models.json'), 'utf8'));
  _modelMapCache = Object.fromEntries(_models.map(m => [m.id, m]));
} catch (_) { console.warn('[config] component-models.json not found'); }

// ── EDS filter map (loaded once at startup for child-type inference) ──────────
let _filterMapCache = {};
try {
  const _filters = JSON.parse(fs.readFileSync(path.join(__dirname, 'component-filters.json'), 'utf8'));
  _filterMapCache = Object.fromEntries(_filters.map(f => [f.id, f.components || []]));
} catch (_) { console.warn('[config] component-filters.json not found'); }

// EDS block type → migration map entry (for JCR live import propRenames)
const edTypeToMapping = {};
for (const [, m] of Object.entries(migrationMap.componentMap || {})) {
  if (m.edsType) edTypeToMapping[m.edsType] = m;
}

// AEM prop names observed per resourceType during XML/JCR parsing (feeds mapping gap analysis)
const knownAemProps = {};
function recordAemProps(rt, node) {
  if (!rt) return;
  if (!knownAemProps[rt]) knownAemProps[rt] = new Set();
  for (const k of Object.keys(node)) {
    const bare = k.replace(/^@/, '');
    if (!bare.startsWith('xmlns:') && !JCR_SYS_SET.has(bare) && bare !== '#text') {
      knownAemProps[rt].add(bare);
    }
  }
}

// EDS field → AEM prop name per edsType (inverse of propRenames, for write-back)
const inversePropRenames = {};
for (const [, m] of Object.entries(migrationMap.componentMap || {})) {
  if (!m.edsType) continue;
  inversePropRenames[m.edsType] = {};
  for (const [aem, eds] of Object.entries(m.propRenames || {}))
    inversePropRenames[m.edsType][eds] = aem;
}

function typedAemValue(edsKey, val, edsType) {
  const field = (_modelMapCache[edsType]?.fields || []).find(f => f.name === edsKey);
  if (field?.component === 'boolean') return `{Boolean}${val}`;
  return val;
}

function fuzzyScore(aem, eds) {
  const norm = s => s.replace(/^(jcr:|cq:|sling:)/, '').replace(/[-_:]/g, '').toLowerCase();
  const na = norm(aem), ne = norm(eds);
  if (na === ne) return 95;
  if (na.length > 2 && ne.length > 2 && (na.includes(ne) || ne.includes(na))) return 75;
  const words = s => s.replace(/([A-Z])/g, ' $1').toLowerCase().split(/[\s_-]+/).filter(w => w.length > 1);
  const wa = new Set(words(na)), we = new Set(words(ne));
  if (wa.size === 0 || we.size === 0) return 0;
  const intersection = [...wa].filter(w => we.has(w)).length;
  return intersection > 0 ? Math.round(50 + (intersection / Math.max(wa.size, we.size)) * 35) : 0;
}

// ── Section thumbnail directory ───────────────────────────────────────────────
const THUMB_DIR = path.join(__dirname, 'public', 'section-thumbs');
fs.mkdirSync(THUMB_DIR, { recursive: true });

// ── Style map (AEM cq:styleId → EDS classes_customDynamicClass) ──────────────
let styleMap = {};
try {
  styleMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'style-map.json'), 'utf8'));
} catch (_) {}

// ── Path map (AEM → EDS path/asset transformations) ──────────────────────────
let pathMap = { contentPrefixRules: [], damPrefixRules: [], assetMap: [] };
try {
  pathMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'path-map.json'), 'utf8'));
} catch (_) { console.warn('[paths] path-map.json not found, using identity transform'); }

// Transforms a single AEM path value to its EDS equivalent.
// DAM paths: apply prefix rule first → look up updated path in assetMap for DM Open API URL → fallback to updated path.
// Content paths: apply prefix rule → fallback to original.
function transformPath(value, pm) {
  if (typeof value !== 'string') return value;
  // Normalise youtube-nocookie.com → youtube.com
  if (value.includes('youtube-nocookie.com'))
    value = value.replace(/youtube-nocookie\.com/g, 'youtube.com');
  if (!pm || !value.startsWith('/content/')) return value;

  if (value.startsWith('/content/dam/')) {
    // 1. Apply DAM prefix rule to get the updated path
    let updatedPath = value;
    for (const rule of (pm.damPrefixRules || [])) {
      if (rule.aemPrefix && value.startsWith(rule.aemPrefix)) {
        updatedPath = (rule.edsPrefix || '') + value.slice(rule.aemPrefix.length);
        break;
      }
    }
    // 2. Content fragments must never get a DM Open API URL — return prefix-substituted path only
    if (updatedPath.includes('content-fragments')) return updatedPath;
    // 3. Check asset map (keyed by updated path) for DM Open API URL
    const assetMap = pm.assetMap || {};
    const dmUrl = assetMap[updatedPath];
    return (dmUrl && dmUrl.trim()) ? dmUrl.trim() : updatedPath;
  }

  // Content paths: prefix rule only
  for (const rule of (pm.contentPrefixRules || [])) {
    if (rule.aemPrefix && value.startsWith(rule.aemPrefix)) {
      return (rule.edsPrefix || '') + value.slice(rule.aemPrefix.length);
    }
  }
  return value;
}

const xmlUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Config loader ─────────────────────────────────────────────────────────────
function loadConfig() {
  const defs    = JSON.parse(fs.readFileSync(path.join(__dirname, 'component-definition.json'), 'utf8'));
  const models  = JSON.parse(fs.readFileSync(path.join(__dirname, 'component-models.json'), 'utf8'));
  const filters = JSON.parse(fs.readFileSync(path.join(__dirname, 'component-filters.json'), 'utf8'));

  const modelMap  = Object.fromEntries(models.map(m => [m.id, m]));
  const filterMap = Object.fromEntries(filters.map(f => [f.id, f.components || []]));

  // Build flat component map from definition
  const compMap = {};
  for (const g of defs.groups) {
    for (const c of g.components) compMap[c.id] = c;
  }

  // Pre-compute modelFields as String[] per model (multi-value JCR property).
  // Skips tab/container pseudo-fields and mimetype helpers.
  const modelFieldsMap = {};
  for (const m of models) {
    modelFieldsMap[m.id] = (m.fields || [])
      .filter(f => f.component !== 'tab' && f.component !== 'container' &&
                   f.component !== 'custom-asset-namespace:custom-asset-mimetype')
      .map(f => `${f.name}@${f.component}`);
  }

  // Load content defaults from scanned real-page data
  const contentDefaultsPath = path.join(__dirname, 'content-defaults.json');
  const contentDefaults = fs.existsSync(contentDefaultsPath)
    ? JSON.parse(fs.readFileSync(contentDefaultsPath, 'utf8'))
    : {};

  return { defs, modelMap, filterMap, compMap, modelFieldsMap, contentDefaults };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/config', (_req, res) => {
  try { res.json(loadConfig()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/sections', (_req, res) => {
  try {
    const dir = path.join(__dirname, 'sections');
    if (!fs.existsSync(dir)) return res.json([]);
    const thumbFiles = new Set(fs.readdirSync(THUMB_DIR).map(f => path.parse(f).name));
    const sections = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const sec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (thumbFiles.has(sec.id)) {
          const ext = [...fs.readdirSync(THUMB_DIR)]
            .find(tf => path.parse(tf).name === sec.id);
          sec.thumbnailUrl = ext ? `/section-thumbs/${ext}` : null;
        }
        return sec;
      });
    res.json(sections);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sections', (req, res) => {
  try {
    const { id, title, description, section, sections } = req.body;
    if (!id || !title || (!section && !sections))
      return res.status(400).json({ error: 'id, title and section (or sections array) are required' });
    const safeId   = id.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const filePath = path.join(__dirname, 'sections', `${safeId}.json`);
    if (fs.existsSync(filePath)) return res.status(409).json({ error: `Template "${safeId}" already exists. Choose a different name.` });
    const data = { id: safeId, title, description: description || '', icon: '⊞' };
    if (sections) data.sections = sections; else data.section = section;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    res.json({ ok: true, id: safeId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/health', async (req, res) => {
  const { aemHost, username, password } = req.body;
  if (!aemHost || !username || !password)
    return res.status(400).json({ error: 'aemHost, username and password required' });
  try {
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const r = await fetch(`${aemHost}/libs/granite/core/content/login.html`, {
      headers: { Authorization: `Basic ${auth}` },
      redirect: 'manual'
    });
    const ok = r.status === 200 || r.status === 302 || r.status === 301;
    res.json(ok
      ? { ok: true,  message: 'Connected to AEM successfully' }
      : { ok: false, error: `HTTP ${r.status}` });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.post('/api/pages', async (req, res) => {
  const { aemHost, username, password, parentPath, pageName, meta, sections } = req.body;
  if (!aemHost || !username || !password || !parentPath || !pageName)
    return res.status(400).json({ error: 'Missing required fields' });

  const auth    = Buffer.from(`${username}:${password}`).toString('base64');
  const hdrs    = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  const fullPath = `${parentPath}/${pageName}`;

  // Pre-check: does this page already exist?
  try {
    const chk = await fetch(`${aemHost}${fullPath}.1.json`, {
      headers: { Authorization: `Basic ${auth}` }
    });
    if (chk.ok) {
      return res.status(409).json({ ok: false, error: `Page already exists at ${fullPath}. Choose a different page name.` });
    }
  } catch (_) { /* network error — proceed */ }

  // Step 1 — create page shell via WCM command
  const step1 = new URLSearchParams({
    cmd:      'createPage',
    parentPath,
    title:    meta['jcr:title'] || pageName,
    label:    pageName,
    template: '/libs/core/franklin/templates/page'
  });
  const r1 = await fetch(`${aemHost}/bin/wcmcommand`, { method: 'POST', headers: hdrs, body: step1.toString() });
  if (!r1.ok) {
    const txt = await r1.text();
    const detail = /<html/i.test(txt)
      ? `AEM rejected the request — check that the parent path "${parentPath}" exists and you have create permission`
      : txt.slice(0, 300);
    return res.status(502).json({ ok: false, error: `Page shell creation failed (${r1.status}): ${detail}` });
  }

  // Step 2 — import full content into jcr:content
  const { compMap, modelFieldsMap, contentDefaults } = loadConfig();
  const jcrContent = buildJcr(meta, sections, compMap, modelFieldsMap, contentDefaults);

  const step2 = new URLSearchParams({
    ':operation':         'import',
    ':contentType':       'json',
    ':replace':           'true',
    ':replaceProperties': 'true',
    ':content':           JSON.stringify(jcrContent)
  });

  // Retry once — AEM sometimes needs a moment after createPage
  let r2 = await fetch(`${aemHost}${fullPath}/jcr:content`, { method: 'POST', headers: hdrs, body: step2.toString() });
  if (r2.status === 409) {
    await new Promise(ok => setTimeout(ok, 1500));
    r2 = await fetch(`${aemHost}${fullPath}/jcr:content`, { method: 'POST', headers: hdrs, body: step2.toString() });
  }
  if (!r2.ok) {
    const txt = await r2.text();
    const detail = /<html/i.test(txt) ? `AEM rejected the content import (${r2.status})` : txt.slice(0, 300);
    return res.status(502).json({ ok: false, error: `Content import failed (${r2.status}): ${detail}` });
  }

  res.json({
    ok:        true,
    path:      fullPath,
    authorUrl: `${aemHost}/editor.html${fullPath}`
  });
});

// ── JCR builder ───────────────────────────────────────────────────────────────
// Rules:
//   1. grid-sections are siblings of grid-container under root (flat structure)
//   2. modelFields is a String[] (multi-value) — omitted when empty
//   3. Empty strings / nulls / empty arrays are stripped before merging so that
//      component-definition template defaults (e.g. name:"Grid Section") are
//      never clobbered by empty model field defaults
function buildJcr(meta, sections, compMap, modelFieldsMap, contentDefaults = {}) {
  const jcr = {
    'jcr:primaryType':    'cq:PageContent',
    'sling:resourceType': 'core/franklin/components/page/v1/page',
    'cq:template':        '/libs/core/franklin/templates/page',
    ...meta,
    root: {
      'jcr:primaryType':   'nt:unstructured',
      'sling:resourceType':'core/franklin/components/root/v1/root'
    }
  };

  let rootIdx = 0;

  for (const sec of sections) {
    const secKey  = `${safe(sec.type)}_${rootIdx++}`;
    jcr.root[secKey] = makeNode(sec, 'section', compMap, modelFieldsMap, contentDefaults);

    if (sec.type === 'grid-container') {
      // grid-sections emitted as root-level siblings, not children of grid-container
      for (const gs of (sec.blocks || [])) {
        const gsNode = makeNode(gs, 'section', compMap, modelFieldsMap, contentDefaults);
        let i = 0;
        for (const blk of (gs.children || [])) {
          gsNode[`${safe(blk.type)}_${i++}`] = makeBlockNode(blk, compMap, modelFieldsMap, contentDefaults);
        }
        jcr.root[`${safe(gs.type)}_${rootIdx++}`] = gsNode;
      }
      continue;
    }

    // Normal section — blocks nested inside
    let blkIdx = 0;
    for (const blk of (sec.blocks || [])) {
      jcr.root[secKey][`${safe(blk.type)}_${blkIdx++}`] = makeBlockNode(blk, compMap, modelFieldsMap, contentDefaults);
    }
  }

  return jcr;
}

function makeNode(item, kind, compMap, modelFieldsMap, contentDefaults) {
  const comp = compMap[item.type];
  const tpl  = comp?.plugins?.xwalk?.page?.template || {};
  const mf   = modelFieldsMap[item.type];
  const defaultRt = kind === 'section'
    ? 'core/franklin/components/section/v1/section'
    : 'core/franklin/components/block/v1/block';
  return {
    'jcr:primaryType':    'nt:unstructured',
    'sling:resourceType': comp?.plugins?.xwalk?.page?.resourceType || defaultRt,
    model:          item.type,
    aueComponentId: item.type,
    ...(mf?.length ? { modelFields: mf } : {}),
    ...stripEmpty(tpl),
    ...stripEmpty(contentDefaults[item.type]),
    ...stripEmpty(item.props)
  };
}

function makeBlockNode(blk, compMap, modelFieldsMap, contentDefaults) {
  const node = makeNode(blk, 'block', compMap, modelFieldsMap, contentDefaults);
  let i = 0;
  for (const child of (blk.children || [])) {
    const comp = compMap[child.type];
    const tpl  = comp?.plugins?.xwalk?.page?.template || {};
    const mf   = modelFieldsMap[child.type];
    node[`${safe(child.type)}_${i++}`] = {
      'jcr:primaryType':    'nt:unstructured',
      'sling:resourceType': comp?.plugins?.xwalk?.page?.resourceType || 'core/franklin/components/block/v1/block/item',
      model:          child.type,
      aueComponentId: child.type,
      ...(mf?.length ? { modelFields: mf } : {}),
      ...stripEmpty(tpl),
      ...stripEmpty(contentDefaults[child.type]),
      ...stripEmpty(child.props)
    };
  }
  return node;
}

// Strip empty strings, nulls and empty arrays so component-definition template
// defaults are never overridden by blank model field defaults from makeItem().
// Preserves false, 0, and any other non-empty value.
function stripEmpty(obj) {
  if (!obj || typeof obj !== 'object') return {};
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) =>
      v !== '' && v !== null && v !== undefined &&
      !(Array.isArray(v) && v.length === 0)
    )
  );
}

function safe(id) { return (id || '').replace(/-/g, '_'); }

// ── JCR import ────────────────────────────────────────────────────────────────
const JCR_SYS_PROPS = new Set([
  'jcr:primaryType','jcr:mixinTypes','jcr:uuid','jcr:created','jcr:createdBy',
  'jcr:lastModified','jcr:lastModifiedBy','cq:lastModified','cq:lastModifiedBy',
  'cq:lastPublished','cq:lastPublishedBy','cq:lastReplicated','cq:lastReplicatedBy',
  'cq:lastReplicationAction','sling:resourceType','model','aueComponentId','modelFields',
  'name','identifier','filter'
]);

// Derive component type from a JCR node.
// Priority: model → aueComponentId → filter → last meaningful sling:resourceType segment.
// AEM EDS convention: rolled-out sections carry filter:"section"/"grid-container" etc.
// without model/aueComponentId, so filter must be checked before resourceType.
function deriveType(v) {
  if (v.model) return v.model;
  if (v.aueComponentId) return v.aueComponentId;
  if (v.filter) return v.filter;
  const rt = v['sling:resourceType'] || '';
  if (!rt) return null;
  // Strip trailing version+name, e.g. "/v1/block" → keep what came before
  const clean = rt.replace(/\/v\d+\/[^/]+$/, '');
  const last = clean.split('/').filter(Boolean).pop() || '';
  // Franklin components (section, grid-container, grid-section, etc.) are all valid types
  if (rt.includes('franklin/components/')) return last || null;
  // For legacy AEM components, skip generic words that don't identify a useful type
  const skip = new Set(['block', 'root', 'page', 'item', 'blocks', 'core']);
  return skip.has(last) ? null : last;
}

// Section-level nodes (root children).
// UE-authored sections carry model/aueComponentId; AEM-rolled-out sections may only
// have filter or sling:resourceType — accept all three forms so nothing is silently dropped.
function isCompNode(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (v.model || v.aueComponentId) return true;
  const rt = v['sling:resourceType'] || '';
  return !!v.filter || rt.includes('franklin/components/');
}

// Block-level nodes (section children) — also accept sling:resourceType as fallback
// for pages that were content-migrated rather than created via Universal Editor.
function isBlockNode(v) {
  return v && typeof v === 'object' && !Array.isArray(v) &&
    (!v['jcr:primaryType'] || v['jcr:primaryType'] === 'nt:unstructured') &&
    deriveType(v) !== null;
}

function extractJcrProps(node) {
  const props = {};
  for (const [k, v] of Object.entries(node)) {
    if (JCR_SYS_PROPS.has(k) || (v !== null && typeof v === 'object')) continue;
    props[k] = transformPath(v, pathMap);
  }
  return props;
}

function applyMigrationMapping(type, rt, rawProps) {
  const mapping = migrationMap?.componentMap?.[rt] || edTypeToMapping?.[type];
  if (!mapping) return rawProps;
  const skipSet = new Set(mapping.skipProps || []);
  const renames = mapping.propRenames || {};
  const result = {};
  for (const [k, v] of Object.entries(rawProps)) {
    if (skipSet.has(k)) continue;
    result[renames[k] || k] = v;
  }
  return result;
}

// When deriveType returns a generic Franklin type ("item", "block") or null for a
// block child node, score each allowed child type from the filter map against the
// child's actual properties. The type whose model fields overlap the most wins.
// Falls back to the first allowed type if no props match (so we at least get the right type).
function guessChildType(parentType, childNode) {
  const allowed = _filterMapCache[parentType] || [];
  if (!allowed.length) return null;
  const childProps = extractJcrProps(childNode);
  let best = null, bestScore = -1;
  for (const ct of allowed) {
    const fields = (_modelMapCache[ct]?.fields || [])
      .filter(f => f.component !== 'tab' && f.component !== 'container');
    const score = fields.filter(f => childProps[f.name] !== undefined).length;
    if (score > bestScore) { bestScore = score; best = ct; }
  }
  return best || allowed[0];
}

// Returns block-level children using the more lenient isBlockNode detector.
// Also recurses one extra level to handle pages with an intermediate container
// node ("par" parsys pattern common in older AEM migrations).
function extractJcrBlocks(node, label) {
  const directEntries = Object.entries(node).filter(([, v]) => isBlockNode(v));
  if (directEntries.length > 0) {
    const blocks = directEntries.map(([key, v]) => {
      const rawType = deriveType(v);
      const rawRt   = v['sling:resourceType'] || '';
      recordAemProps(rawRt || rawType, v);
      return {
        type:     rawType,
        _jcrKey:  key,
        props:    applyMigrationMapping(rawType, rawRt, extractJcrProps(v)),
        children: (() => {
            const childCandidates = Object.entries(v).filter(([, c]) =>
              c && typeof c === 'object' && !Array.isArray(c) &&
              (!c['jcr:primaryType'] || c['jcr:primaryType'] === 'nt:unstructured'));
            console.log(`[import]   block "${rawType}" has ${childCandidates.length} child candidate(s):`,
              childCandidates.map(([ck, c]) => `${ck}(model=${c.model||'-'} aueId=${c.aueComponentId||'-'} rt=${c['sling:resourceType']||'-'} props=${Object.keys(c).filter(k=>typeof c[k]!=='object').join(',')})`));
            return childCandidates.map(([ck, c]) => {
              let ct = deriveType(c);
              const crt = c['sling:resourceType'] || '';
              if (!ct || ct === 'item' || ct === 'block') ct = guessChildType(rawType, c) || ct;
              console.log(`[import]     child "${ck}": derivedType=${deriveType(c)} → finalType=${ct}`);
              if (!ct) return null;
              return { type: ct, _jcrKey: ck, props: applyMigrationMapping(ct, crt, extractJcrProps(c)), children: [] };
            }).filter(Boolean);
          })()
      };
    });
    if (label) console.log(`[import]   ${label} block types: [${blocks.map(b => b.type).join(', ')}]`);
    return blocks;
  }
  // Fallback: one level deeper
  const containers = Object.entries(node).filter(
    ([, v]) => v && typeof v === 'object' && !Array.isArray(v) && !isBlockNode(v) &&
               (!v['jcr:primaryType'] || v['jcr:primaryType'] === 'nt:unstructured')
  );
  for (const [, ct] of containers) {
    const nestedEntries = Object.entries(ct).filter(([, v]) => isBlockNode(v));
    if (nestedEntries.length > 0) {
      const blocks = nestedEntries.map(([key, v]) => {
        const rawType = deriveType(v);
        const rawRt   = v['sling:resourceType'] || '';
        return {
          type:     rawType,
          _jcrKey:  key,
          props:    applyMigrationMapping(rawType, rawRt, extractJcrProps(v)),
          children: Object.entries(v)
            .filter(([, c]) => c && typeof c === 'object' && !Array.isArray(c) &&
                               (!c['jcr:primaryType'] || c['jcr:primaryType'] === 'nt:unstructured'))
            .map(([ck, c]) => {
              let ct2 = deriveType(c);
              const crt = c['sling:resourceType'] || '';
              if (!ct2 || ct2 === 'item' || ct2 === 'block') ct2 = guessChildType(rawType, c) || ct2;
              if (!ct2) return null;
              return { type: ct2, _jcrKey: ck, props: applyMigrationMapping(ct2, crt, extractJcrProps(c)), children: [] };
            }).filter(Boolean)
        };
      });
      if (label) console.log(`[import]   ${label} block types (nested): [${blocks.map(b => b.type).join(', ')}]`);
      return blocks;
    }
  }
  return [];
}

function parseRootNode(root) {
  // Log ALL root keys with their detection status for diagnostics
  for (const [k, v] of Object.entries(root)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const detected = isCompNode(v);
    const type = deriveType(v);
    const rt = v['sling:resourceType'] || '(none)';
    console.log(`[import] root key "${k}": isCompNode=${detected}, type=${type}, filter=${v.filter||'(none)'}, model=${v.model||'(none)'}, rt=${rt}`);
  }

  const entries = Object.entries(root).filter(([, v]) => isCompNode(v));
  console.log(`[import] root has ${entries.length} component nodes:`,
    entries.map(([k, v]) => `${k}(${deriveType(v)})`).join(', '));

  // Container types that should become their own canvas sections, not blocks
  const SECTION_CONTAINER_TYPES = new Set(['section', 'grid-container', 'grid-section']);

  const sections = [];
  let i = 0;
  while (i < entries.length) {
    const [k, node] = entries[i];
    const type = deriveType(node);
    if (type === 'grid-container') {
      const nodeProps = extractJcrProps(node);
      const gridSections = [];
      i++;
      while (i < entries.length && deriveType(entries[i][1]) === 'grid-section') {
        const [gsk, gsNode] = entries[i];
        const gsBlocks = extractJcrBlocks(gsNode, gsk);
        console.log(`[import]   grid-section ${gsk} blocks: ${gsBlocks.length}`);
        gridSections.push({ type: 'grid-section', _jcrKey: gsk, props: extractJcrProps(gsNode), children: gsBlocks });
        i++;
      }
      if (gridSections.length > 0) {
        sections.push({ type: 'grid-container', _jcrKey: k, props: nodeProps, blocks: gridSections });
      } else {
        // No grid-section siblings: extract blocks placed directly inside the container node
        // (e.g. section_10 has a video block, section_2 has a teaser block directly inside)
        const directBlocks = extractJcrBlocks(node, k);
        console.log(`[import] ${k}(grid-container) no grid-sections, direct blocks: ${directBlocks.length}`);
        sections.push({ type: 'grid-container', _jcrKey: k, props: nodeProps, blocks: directBlocks });
      }
    } else {
      const allBlocks = extractJcrBlocks(node, k);
      // Split: content blocks vs nested section containers (sub-sections with video, etc.)
      const contentBlocks  = allBlocks.filter(b => !SECTION_CONTAINER_TYPES.has(b.type));
      const nestedSections = allBlocks.filter(b =>  SECTION_CONTAINER_TYPES.has(b.type));
      console.log(`[import] section(${type}) key=${k} contentBlocks=${contentBlocks.length}, nestedSections=${nestedSections.length}`);
      sections.push({ type, _jcrKey: k, props: extractJcrProps(node), blocks: contentBlocks });
      // Promote nested section containers to their own top-level canvas sections
      for (const nested of nestedSections) {
        const nestedBlocks = nested.children || [];
        console.log(`[import]   promoted nested ${nested.type} with ${nestedBlocks.length} blocks: [${nestedBlocks.map(b => b.type).join(', ')}]`);
        sections.push({ type: nested.type, _jcrKey: nested._jcrKey, props: nested.props, blocks: nestedBlocks });
      }
      i++;
    }
  }
  return sections;
}

// Debug endpoint — full deep view of root structure for diagnosing block detection
app.post('/api/debug-page', async (req, res) => {
  const { aemHost, username, password, pagePath } = req.body;
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const cleanPath = pagePath.replace(/\.(html|json|xml)$/i, '').replace(/\/+$/, '');
  const url = `${aemHost.replace(/\/+$/, '')}${cleanPath}/jcr:content.infinity.json`;
  const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok) return res.json({ error: `HTTP ${r.status}`, url });
  const jcr = await r.json();
  const root = jcr.root || {};

  function describeNode(v, depth = 0) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const children = {};
    for (const [ck, cv] of Object.entries(v)) {
      if (cv && typeof cv === 'object' && !Array.isArray(cv)) {
        if (depth < 3) children[ck] = describeNode(cv, depth + 1);
      }
    }
    return {
      'jcr:primaryType': v['jcr:primaryType'],
      model: v.model,
      aueComponentId: v.aueComponentId,
      'sling:resourceType': v['sling:resourceType'],
      filter: v.filter,
      scalarProps: Object.fromEntries(Object.entries(v).filter(([, val]) => typeof val !== 'object')),
      isCompNode: !!(v.model || v.aueComponentId),
      isBlockNode: isBlockNode(v),
      derivedType: deriveType(v),
      children: Object.keys(children).length ? children : undefined
    };
  }

  const rootKeys = Object.keys(root);
  const deep = {};
  for (const k of rootKeys) {
    deep[k] = describeNode(root[k]);
  }

  res.json({ url, rootKeyCount: rootKeys.length, deep });
});

app.post('/api/import-page', async (req, res) => {
  const { aemHost, username, password, pagePath } = req.body;
  if (!aemHost || !username || !password || !pagePath)
    return res.status(400).json({ error: 'aemHost, username, password and pagePath required' });
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  try {
    const cleanPath = pagePath.replace(/\.(html|json|xml)$/i, '').replace(/\/+$/, '');
    // Use depth-4 instead of infinity to avoid AEM's silent node-count truncation
    // on large pages. Depth: jcr:content(0) → root(1) → sections(2) → blocks(3) → block-children(4)
    const url = `${aemHost.replace(/\/+$/, '')}${cleanPath}/jcr:content.4.json`;
    console.log(`[import] fetching ${url}`);
    const r   = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) return res.status(r.status).json({ error: `AEM returned HTTP ${r.status} — check path and credentials` });
    const jcr = await r.json();
    if (!jcr.root) return res.status(422).json({ error: 'No root node found — is this an EDS page?' });
    const META_KEYS = ['jcr:title','navTitle','eyebrowText','pageSubtitle','cardTitle','cardDescription',
                       'ctaText','publicationDate','readWatchTime','storyReadTime','storyWatchTime'];
    const meta = {};
    for (const k of META_KEYS) { if (jcr[k] !== undefined) meta[k] = jcr[k]; }
    const sections = parseRootNode(jcr.root);
    console.log(`[import] total sections: ${sections.length}, total blocks: ${sections.reduce((n,s) => n + (s.blocks||[]).length, 0)}`);
    res.json({ ok: true, sections, meta });
  } catch (err) {
    console.error('[import] error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── JCR XML migration parser ──────────────────────────────────────────────────
const JCR_XML_PARSER = new XMLParser({
  ignoreAttributes:    false,
  attributeNamePrefix: '@',
  parseAttributeValue: false,   // keep all values as strings
  trimValues:          true,
  isArray:             () => false,
});

const JCR_SYS_SET = new Set(migrationMap.jcrSystemProps || []);

function isMigrationLayout(rt) {
  if (!rt) return true;
  if (migrationMap.layoutResources.includes(rt)) return true;
  const last = rt.split('/').pop().toLowerCase();
  return last === 'parsys' || last === 'iparsys' || last === 'responsivegrid' ||
    rt.startsWith('wcm/foundation/') || rt.startsWith('foundation/components/') ||
    rt.startsWith('core/wcm/');
}

function extractPropsFromXmlNode(attrs, mapping, pm) {
  const renames    = mapping?.propRenames    || {};
  // AEM_WRITEBACK_SKIP drops cq:styleIds and other AEM-classic props that must never
  // land on an EDS page (cq:styleIds is translated to classes_customDynamicClass separately).
  const skipSet    = new Set([...(mapping?.skipProps || []), ...JCR_SYS_SET, ...AEM_WRITEBACK_SKIP]);
  const invertSet  = new Set(mapping?.invertBoolProps || []);
  const props = {};
  for (const [k, v] of Object.entries(attrs)) {
    const key = k.replace(/^@/, '');  // strip attribute prefix
    if (skipSet.has(key)) continue;
    if (key.startsWith('xmlns:')) continue;
    if (key.startsWith('cq:')) continue;   // drop ALL classic-AEM cq:* props (never valid on EDS)
    const targetKey = renames[key] || key;
    let val = typeof v === 'string' ? v.replace(/^\{[A-Za-z]+\}/, '') : v;
    if (val !== null && typeof val === 'object') continue; // child nodes, not attributes
    if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).trim();
    }
    if (invertSet.has(key)) {
      if (val === 'true')  val = 'false';
      else if (val === 'false') val = 'true';
    }
    if (val !== '' && val !== null && val !== undefined) props[targetKey] = transformPath(val, pm);
  }
  return props;
}

// Collect XML child nodes of an accordion-style component into typed child items.
// Only props listed in childPropRenames are included; everything else is ignored.
function collectChildItems(node, mapping) {
  const childPropRen = mapping.childPropRenames;
  const childSkip = new Set([...JCR_SYS_SET, 'cq:styleIds', 'textIsRich']);
  const items = [];
  // If items live inside a named wrapper node (e.g. linklist → <pages>), look there instead
  const source = (mapping.childContainer && node[mapping.childContainer] && typeof node[mapping.childContainer] === 'object')
    ? node[mapping.childContainer]
    : node;
  for (const [k, v] of Object.entries(source)) {
    if (k.startsWith('@') || k === '#text') continue;
    if (!v || typeof v !== 'object') continue;
    const itemProps = {};
    for (const [pk, pv] of Object.entries(v)) {
      const bareKey = pk.replace(/^@/, '');
      if (childSkip.has(bareKey) || bareKey.startsWith('xmlns:')) continue;
      if (Object.prototype.hasOwnProperty.call(childPropRen, bareKey) && pv !== '' && pv !== null && pv !== undefined) {
        let cleanPv = typeof pv === 'string' ? pv.replace(/^\{[A-Za-z]+\}/, '') : pv;
        if (typeof cleanPv === 'string' && cleanPv.startsWith('[') && cleanPv.endsWith(']')) {
          cleanPv = cleanPv.slice(1, -1).trim();
        }
        itemProps[childPropRen[bareKey]] = transformPath(cleanPv, pathMap);
      }
    }
    items.push({ type: mapping.childType, props: itemProps, children: [] });
  }
  return items;
}

function walkXmlNode(node, ordered, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 20) return;
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('@') || key === '#text') continue;
    if (!child || typeof child !== 'object') continue;
    const rt = (child['@sling:resourceType'] || '').trim();
    if (!rt || isMigrationLayout(rt)) {
      // Layout containers with backgroundImageReference serve as AEM hero sections.
      // Emit a hero-container-item so fill-from-XML can populate image + style classes.
      const bgImg = child['@backgroundImageReference'];
      if (bgImg) {
        const filename = bgImg.split('/').pop().replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
        const heroProps = { image: transformPath(bgImg, pathMap), backgroundVariant: 'image', imageAlt: filename };
        const rawStyleIds = child['@cq:styleIds'];
        if (rawStyleIds && Object.keys(styleMap).length) {
          const ids = String(rawStyleIds).replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
          const edsClasses = ids.map(id => styleMap[id]?.edsClass).filter(Boolean);
          if (edsClasses.length) heroProps['classes_customDynamicClass'] = edsClasses.join(',');
        }
        ordered.push({ type: 'hero-container-item', resourceType: rt, props: heroProps, children: [] });
      }
      walkXmlNode(child, ordered, depth + 1);
      continue;
    }
    const mapping  = migrationMap.componentMap[rt];
    recordAemProps(rt, child);
    const props    = extractPropsFromXmlNode(child, mapping, pathMap);
    // Allow a prop value to select a different EDS block type (e.g. videoType=youtube → "video")
    const propEdsType = mapping?.propEdsType;
    const rawPropVal  = propEdsType ? (child[`@${propEdsType.prop}`] || '').trim() : '';
    const type = (propEdsType?.map?.[rawPropVal]) || mapping?.edsType || rt.split('/').pop();
    // Translate AEM cq:styleIds → EDS classes_customDynamicClass via style-map
    const rawStyleIds = child['@cq:styleIds'];
    if (rawStyleIds && Object.keys(styleMap).length) {
      const ids = String(rawStyleIds).replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
      const edsClasses = ids.map(id => styleMap[id]?.edsClass).filter(Boolean);
      if (edsClasses.length) props['classes_customDynamicClass'] = edsClasses.join(',');
    }

    // Count child component nodes and store as a prop (e.g. totalSlides for carousel)
    if (mapping?.countChildrenAsProp) {
      const childCount = Object.entries(child).filter(([k, v]) =>
        !k.startsWith('@') && k !== '#text' && v && typeof v === 'object' && v['@sling:resourceType']
      ).length;
      props[mapping.countChildrenAsProp] = String(childCount);
    }

    // Accordion-style: collect XML children as typed sub-items; do not recurse further
    if (mapping?.childType && mapping?.childPropRenames) {
      const childItems = collectChildItems(child, mapping);
      ordered.push({ type, resourceType: rt, props, children: childItems });
    // If this component should render its main content as a child block
    } else if (mapping?.childType && mapping?.childProp && props[mapping.childProp] !== undefined) {
      const childVal = props[mapping.childProp];
      delete props[mapping.childProp];
      ordered.push({
        type, resourceType: rt, props,
        children: [{ type: mapping.childType, props: { [mapping.childProp]: childVal }, children: [] }]
      });
      walkXmlNode(child, ordered, depth + 1);
    } else {
      ordered.push({ type, resourceType: rt, props, children: [] });
      walkXmlNode(child, ordered, depth + 1);
    }
  }
}

// Collect every sling:resourceType found in the tree (for diagnostics)
function collectAllResourceTypes(node, found = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 30) return found;
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('@') || key === '#text') continue;
    if (!child || typeof child !== 'object') continue;
    // Try both possible attribute key forms
    const rt = child['@sling:resourceType'] || child['sling:resourceType'] || '';
    if (rt) found.add(rt.trim());
    collectAllResourceTypes(child, found, depth + 1);
  }
  return found;
}

app.post('/api/parse-jcr-xml', xmlUpload.single('jcrFile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const xml  = req.file.buffer.toString('utf8');
    const tree = JCR_XML_PARSER.parse(xml);

    // Log top-level keys to help diagnose structure issues
    const topKeys = Object.keys(tree);
    console.log('[parse-jcr-xml] top-level keys:', topKeys);

    // Handle both jcr:root wrapping cq:Page, and bare jcr:content
    const jcrRoot    = tree['jcr:root'] || tree;
    const jcrContent = jcrRoot['jcr:content'] || jcrRoot;

    // Log jcr:content keys
    const contentKeys = Object.keys(jcrContent);
    console.log('[parse-jcr-xml] jcr:content keys:', contentKeys.slice(0, 30));

    // Extract page-level metadata
    const meta = {};
    const metaKeySet = new Set(migrationMap.metaKeys || []);
    for (const [k, v] of Object.entries(jcrContent)) {
      if (!k.startsWith('@')) continue;
      const key = k.replace(/^@/, '');
      if (metaKeySet.has(key) && v) meta[key] = v;
    }

    // Walk the content tree
    const ordered = [];
    walkXmlNode(jcrContent, ordered);

    if (ordered.length === 0) {
      // Collect all resource types found for diagnostics
      const allRt = [...collectAllResourceTypes(jcrContent)].sort();
      console.log('[parse-jcr-xml] all resourceTypes found:', allRt);
      return res.status(422).json({
        error: 'No migratable components found.',
        hint:  'See allResourceTypes below — add any content types to migration-map.json',
        allResourceTypes: allRt,
        topLevelKeys: contentKeys.slice(0, 40),
      });
    }

    // Build summary (grouped by type with count)
    const typeIndex = {};
    for (const blk of ordered) {
      if (!typeIndex[blk.type]) typeIndex[blk.type] = { type: blk.type, resourceType: blk.resourceType, count: 0, blocks: [] };
      typeIndex[blk.type].count++;
      typeIndex[blk.type].blocks.push({ props: blk.props, children: blk.children });
    }
    const summary = Object.values(typeIndex).sort((a, b) => b.count - a.count);

    res.json({ ok: true, sourceType: 'sites-xml', meta, ordered, summary });
  } catch (err) {
    console.error('[parse-jcr-xml] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk XML parse ────────────────────────────────────────────────────────────
app.post('/api/bulk-parse-xmls', xmlUpload.array('xmlFiles', 100), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
  const results = [];
  for (const file of req.files) {
    try {
      const xml  = file.buffer.toString('utf8');
      const tree = JCR_XML_PARSER.parse(xml);
      const jcrRoot    = tree['jcr:root'] || tree;
      const jcrContent = jcrRoot['jcr:content'] || jcrRoot;
      const ordered    = [];
      walkXmlNode(jcrContent, ordered);
      const pageTitle = String(jcrContent['@jcr:title'] || '').trim()
        || file.originalname.replace(/\.content\.xml$/i, '');
      const slug = file.originalname.replace(/\.content\.xml$/i, '').replace(/\.[^.]+$/, '');
      results.push({ fileName: file.originalname, slug, pageTitle, ordered, ok: true });
    } catch (err) {
      results.push({ fileName: file.originalname, slug: '', pageTitle: '', ordered: [], ok: false, error: err.message });
    }
  }
  res.json({ ok: true, results });
});

// ── Bulk parse from a local folder ────────────────────────────────────────────
// AEM stores each page as a FOLDER containing `.content.xml` (the file is always
// named `.content.xml`; the page name is the folder). This reads each DIRECT
// subfolder of `folder` as one page — page name = folder name — so a whole set of
// same-layout pages (e.g. our-leaders/*) can be created in one go.
app.post('/api/bulk-parse-folder', (req, res) => {
  const rel = String(req.body?.folder || '').trim().replace(/^["']|["']$/g, '');
  if (!rel) return res.status(400).json({ error: 'folder is required' });
  const projRoot = path.resolve(__dirname);
  const abs = path.resolve(projRoot, rel);
  // Path-traversal guard: only allow folders inside the project directory.
  if (abs !== projRoot && !abs.startsWith(projRoot + path.sep))
    return res.status(400).json({ error: 'folder must be inside the project directory' });
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
  catch (e) { return res.status(404).json({ error: `Cannot read folder "${rel}": ${e.message}` }); }

  const metaKeySet = new Set(migrationMap.metaKeys || []);
  const results = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const cxml = path.join(abs, ent.name, '.content.xml');
    if (!fs.existsSync(cxml)) continue;
    try {
      const tree       = JCR_XML_PARSER.parse(fs.readFileSync(cxml, 'utf8'));
      const jcrRoot     = tree['jcr:root'] || tree;
      const jcrContent  = jcrRoot['jcr:content'] || jcrRoot;
      const meta = {};
      for (const [k, v] of Object.entries(jcrContent)) {
        if (!k.startsWith('@')) continue;
        const key = k.replace(/^@/, '');
        if (metaKeySet.has(key) && v) meta[key] = v;
      }
      const ordered = [];
      walkXmlNode(jcrContent, ordered);
      const pageTitle = String(jcrContent['@jcr:title'] || meta['jcr:title'] || '').trim() || ent.name;
      results.push({ folderName: ent.name, slug: ent.name, pageTitle, meta, ordered, ok: true });
    } catch (err) {
      results.push({ folderName: ent.name, slug: ent.name, pageTitle: ent.name, meta: {}, ordered: [], ok: false, error: err.message });
    }
  }
  results.sort((a, b) => a.folderName.localeCompare(b.folderName));
  res.json({ ok: true, folder: rel, count: results.length, results });
});

// ── Path map endpoints ────────────────────────────────────────────────────────
app.get('/api/path-map', (_req, res) => res.json(pathMap));

app.post('/api/path-map', express.json(), (req, res) => {
  try {
    const updated = {
      contentPrefixRules: req.body.contentPrefixRules || [],
      damPrefixRules:     req.body.damPrefixRules     || [],
      assetMap:           pathMap.assetMap             || {}, // preserve existing asset map (flat object)
    };
    fs.writeFileSync(path.join(__dirname, 'path-map.json'), JSON.stringify(updated, null, 2), 'utf8');
    Object.assign(pathMap, updated);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CSV format (from asset-map export):
//   path, uuid, scene7Name, scene7File, damStatus, openApiUrl
//   col 0: path       — updated DAM path (/content/dam/corporate/abbvie-com2/...)
//   col 5: openApiUrl — DM Open API URL (https://...). If it's a /content/ path or blank, treated as no DM URL.
// Also accepts a simple 2-column format: path, openApiUrl
app.post('/api/path-map/import-csv', xmlUpload.single('csvFile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const lines = req.file.buffer.toString('utf8')
      .split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    // Skip header row if first cell looks like a column name
    const firstLower = (lines[0] || '').toLowerCase();
    const start = (firstLower.startsWith('path') || firstLower.startsWith('newdampath') || firstLower.startsWith('dam')) ? 1 : 0;
    const existing = (pathMap.assetMap && !Array.isArray(pathMap.assetMap)) ? { ...pathMap.assetMap } : {};
    let imported = 0;
    let withDmUrl = 0;
    for (let i = start; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim());
      const damPath = cols[0] || '';
      if (!damPath || !damPath.startsWith('/')) continue;
      // col 6 = isCF flag (7-col format); content fragments must never get a DM URL
      const isCF = (cols[6] || '').toLowerCase() === 'true';
      // Prefer col 5 (openApiUrl from 6/7-col export), fall back to col 1 (simple 2-col format)
      const rawUrl = cols.length >= 6 ? (cols[5] || '') : (cols[1] || '');
      // Only use as DM URL if it's a real https URL and not a content fragment
      const dmUrl = (!isCF && rawUrl.startsWith('https://')) ? rawUrl : '';
      existing[damPath] = dmUrl;
      if (dmUrl) withDmUrl++;
      imported++;
    }
    pathMap.assetMap = existing;
    fs.writeFileSync(path.join(__dirname, 'path-map.json'), JSON.stringify(pathMap, null, 2), 'utf8');
    res.json({ ok: true, imported, withDmUrl, total: Object.keys(existing).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Migration map endpoint (served to client for auto-suggest) ────────────────
app.get('/api/migration-map', (_req, res) => res.json(migrationMap));

app.post('/api/migration-map', express.json(), (req, res) => {
  try {
    const existing = JSON.parse(fs.readFileSync(path.join(__dirname, 'migration-map.json'), 'utf8'));
    existing.componentMap = req.body.componentMap || existing.componentMap;
    fs.writeFileSync(path.join(__dirname, 'migration-map.json'), JSON.stringify(existing, null, 2), 'utf8');
    migrationMap.componentMap = existing.componentMap; // reload in memory immediately
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// AEM-specific props that must never be written back from EDS canvas to AEM
const AEM_WRITEBACK_SKIP = new Set([
  'cq:styleIds', 'textIsRich', 'cq:lastModified', 'cq:lastModifiedBy',
  'cq:template', 'cq:designPath', 'cq:tags',
]);

app.post('/api/write-to-aem', express.json(), async (req, res) => {
  try {
  const { aemHost, username, password, changes } = req.body;
  if (!aemHost || !username || !password || !Array.isArray(changes))
    return res.status(400).json({ error: 'aemHost, username, password and changes[] required' });
  const auth = Buffer.from(`${username}:${password}`).toString('base64');

  // Load component config once — needed for sling:resourceType, aueComponentId, modelFields, filter
  let compMap = {}, modelFieldsMap = {}, filterMap = {};
  try { ({ compMap, modelFieldsMap, filterMap } = loadConfig()); } catch (_) {}

  const results = [];
  for (const change of changes) {
    const inv  = inversePropRenames[change.blockType] || {};
    const body = new URLSearchParams();

    if (change.isNew) {
      const isSection = !!change.isSection;
      const comp      = compMap[change.blockType] || {};
      const defaultRt = isSection
        ? 'core/franklin/components/section/v1/section'
        : 'core/franklin/components/block/v1/block';

      // 1. Structural props required by Universal Editor
      body.set('jcr:primaryType', 'nt:unstructured');
      body.set('sling:resourceType', comp?.plugins?.xwalk?.page?.resourceType || defaultRt);
      if (change.blockType) {
        body.set('model', change.blockType);
        body.set('aueComponentId', change.blockType);
      }

      // 2. modelFields — multi-value String[] of "fieldName@componentType"
      const mf = modelFieldsMap[change.blockType];
      if (mf?.length) {
        for (const f of mf) body.append('modelFields', f);
        body.set('modelFields@TypeHint', 'String[]');
      }

      // 3. Template defaults from component-definition.json
      //    This is the same object makeNode() spreads when generating a new page.
      //    It carries: name (UE content tree label), filter (allowed children),
      //    language, blockId, and any other block-specific defaults.
      const tpl = comp?.plugins?.xwalk?.page?.template || {};
      for (const [k, v] of Object.entries(tpl)) {
        if (v === null || v === undefined) continue;
        if (typeof v === 'boolean') {
          body.set(k, `{Boolean}${v}`);
        } else if (Array.isArray(v)) {
          for (const item of v) body.append(k, String(item));
          if (v.length) body.set(`${k}@TypeHint`, 'String[]');
        } else if (String(v) !== '') {
          body.set(k, String(v));
        }
      }

      // 4. filter — sections need this so UE knows which blocks are allowed inside.
      //    Blocks that are containers (accordion, cards, etc.) get their filter from
      //    the template above; we only add a fallback here for plain sections.
      if (isSection && !body.has('filter')) {
        body.set('filter', filterMap[change.blockType] !== undefined ? change.blockType : 'section');
      }

      // 5. Actual field props (override template defaults with canvas values)
      for (const [edsKey, val] of Object.entries(change.newProps || {})) {
        if (String(edsKey).startsWith('_')) continue;
        const aemKey = inv[edsKey] || edsKey;
        if (AEM_WRITEBACK_SKIP.has(aemKey) || AEM_WRITEBACK_SKIP.has(edsKey)) continue;
        body.set(aemKey, typedAemValue(edsKey, String(val ?? ''), change.blockType));
      }
    } else {
      // Updating existing node — only send changed props
      for (const [edsKey, { new: newVal }] of Object.entries(change.changedProps || {})) {
        const aemKey = inv[edsKey] || edsKey;
        if (AEM_WRITEBACK_SKIP.has(aemKey) || AEM_WRITEBACK_SKIP.has(edsKey)) continue;
        body.set(aemKey, typedAemValue(edsKey, String(newVal ?? ''), change.blockType));
      }
    }

    try {
      const url = `${aemHost.replace(/\/+$/, '')}${change.jcrPath}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      results.push({ jcrPath: change.jcrPath, ok: r.ok, status: r.status });
    } catch (e) {
      results.push({ jcrPath: change.jcrPath, ok: false, error: e.message });
    }
  }
  res.json({ results });
  } catch (err) {
    console.error('[write-to-aem] unhandled error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/mapping-gap', (req, res) => {
  try {
    const { rt, edsType } = req.query;
    const { modelMap } = loadConfig();
    const mapping = migrationMap.componentMap?.[rt] || {};
    const renames = mapping.propRenames || {};

    // All known AEM props: observed during parsing + explicit renames + skipProps
    const seen = knownAemProps[rt] ? [...knownAemProps[rt]] : [];
    const allAemProps = [...new Set([...seen, ...Object.keys(renames), ...(mapping.skipProps || [])])].sort();

    // EDS fields for this type
    const model = modelMap[edsType];
    const edsFields = (model?.fields || [])
      .filter(f => f.component !== 'tab' && f.component !== 'container' &&
                   f.component !== 'custom-asset-namespace:custom-asset-mimetype')
      .map(f => ({ name: f.name, label: f.label || f.name, component: f.component }));

    const mappedEdsValues = new Set(Object.values(renames));
    const mappedAemKeys   = new Set(Object.keys(renames));
    const skippedAem      = new Set(mapping.skipProps || []);

    const unmappedAemRaw = allAemProps.filter(p => !mappedAemKeys.has(p) && !skippedAem.has(p));
    const unmappedEdsRaw = edsFields.filter(f => !mappedEdsValues.has(f.name));

    // Fuzzy suggestions (greedy best-match)
    const suggestions = [];
    const usedEds = new Set();
    for (const aemProp of unmappedAemRaw) {
      let bestMatch = null, bestScore = 0;
      for (const edsField of unmappedEdsRaw) {
        if (usedEds.has(edsField.name)) continue;
        const score = fuzzyScore(aemProp, edsField.name);
        if (score > bestScore) { bestScore = score; bestMatch = edsField.name; }
      }
      if (bestMatch && bestScore >= 40) {
        suggestions.push({ aemProp, edsField: bestMatch, score: bestScore });
        usedEds.add(bestMatch);
      }
    }

    const suggestedAem = new Set(suggestions.map(s => s.aemProp));
    const suggestedEds = new Set(suggestions.map(s => s.edsField));

    res.json({
      aemProps: allAemProps,
      edsFields,
      currentRenames: renames,
      suggestions,
      unmappedAem: unmappedAemRaw.filter(p => !suggestedAem.has(p)),
      unmappedEds: unmappedEdsRaw.filter(f => !suggestedEds.has(f.name))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Section thumbnail helpers ─────────────────────────────────────────────────

// Convert a section template JSON def into the sections[] array buildJcr expects
function buildSectionsFromDef(def) {
  if (def.sections) return def.sections;   // bundle — all parts
  if (def.section)  return [def.section];  // single section
  return [];
}

// ── Section thumbnail endpoints ───────────────────────────────────────────────
app.get('/api/section-thumbs', (_req, res) => {
  try {
    const available = fs.readdirSync(THUMB_DIR).map(f => path.parse(f).name);
    res.json({ available });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/section-thumbs/auto-generate', express.json(), async (req, res) => {
  const { parentPath, folderName = 'section-samples', aemHost, username, password,
          sectionIds, overwrite = false } = req.body;
  if (!parentPath || !aemHost || !username || !password)
    return res.status(400).json({ error: 'parentPath, aemHost, username, password required' });

  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const hdrs = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  const host = aemHost.replace(/\/+$/, '');

  // Load all section defs
  const secDir = path.join(__dirname, 'sections');
  let defs = fs.readdirSync(secDir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(secDir, f), 'utf8')));
  if (sectionIds?.length) defs = defs.filter(d => sectionIds.includes(d.id));

  const { compMap, modelFieldsMap, contentDefaults } = loadConfig();
  const results = [];
  const thumbExts = ['jpg','jpeg','png','webp'];

  // Ensure parent folder exists (ignore 409)
  try {
    const folderParams = new URLSearchParams({
      cmd: 'createPage', parentPath, title: 'Section Samples', label: folderName,
      template: '/libs/core/franklin/templates/page'
    });
    await fetch(`${host}/bin/wcmcommand`, { method: 'POST', headers: hdrs, body: folderParams.toString() });
  } catch (_) {}

  // Phase 1: create / update pages on AEM
  for (const def of defs) {
    // Skip if thumb exists and !overwrite
    if (!overwrite && thumbExts.some(e => fs.existsSync(path.join(THUMB_DIR, `${def.id}.${e}`)))) {
      results.push({ id: def.id, status: 'skipped' });
      continue;
    }
    try {
      const sections = buildSectionsFromDef(def);
      const jcr = buildJcr({ 'jcr:title': def.title }, sections, compMap, modelFieldsMap, contentDefaults);

      // Create page shell (ignore 409 — already exists)
      const pageParams = new URLSearchParams({
        cmd: 'createPage', parentPath: `${parentPath}/${folderName}`,
        title: def.title, label: def.id,
        template: '/libs/core/franklin/templates/page'
      });
      await fetch(`${host}/bin/wcmcommand`, { method: 'POST', headers: hdrs, body: pageParams.toString() });

      // Import content
      const importParams = new URLSearchParams({
        ':operation': 'import', ':contentType': 'json',
        ':replace': 'true', ':replaceProperties': 'true',
        ':content': JSON.stringify(jcr)
      });
      const r = await fetch(`${host}${parentPath}/${folderName}/${def.id}/jcr:content`,
        { method: 'POST', headers: hdrs, body: importParams.toString() });
      if (!r.ok) {
        const txt = await r.text();
        results.push({ id: def.id, status: 'error', error: `import ${r.status}: ${txt.slice(0,120)}` });
      } else {
        results.push({ id: def.id, status: 'created' });
      }
    } catch (err) {
      results.push({ id: def.id, status: 'error', error: err.message });
    }
  }

  // Phase 2: screenshot all successfully created pages
  const toShot = results.filter(r => r.status === 'created');
  let screenshotted = 0;
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    // setExtraHTTPHeaders sends Basic auth on every request (including initial HTML loads)
    // page.authenticate() only responds to 401 challenges — AEM redirects to login page instead
    await page.setExtraHTTPHeaders({
      'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    });
    await page.setViewport({ width: 1440, height: 900 });

    for (const entry of toShot) {
      const url = `${host}${parentPath}/${folderName}/${entry.id}.html`;
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        // Small extra wait for late-rendered components
        await new Promise(r => setTimeout(r, 1500));
        const thumbPath = path.join(THUMB_DIR, `${entry.id}.jpg`);
        const el = await page.$('main > div.section, main > div');
        if (el) {
          await el.screenshot({ path: thumbPath, type: 'jpeg', quality: 80 });
        } else {
          await page.screenshot({ path: thumbPath, type: 'jpeg', quality: 80,
            clip: { x: 0, y: 0, width: 1440, height: 600 } });
        }
        entry.status = 'done';
        entry.thumbUrl = `/section-thumbs/${entry.id}.jpg`;
        screenshotted++;
      } catch (err) {
        entry.status = 'screenshot-failed';
        entry.error = err.message;
      }
    }
    await browser.close();
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    // Mark all remaining toShot entries as failed
    for (const e of toShot) if (e.status === 'created') { e.status = 'screenshot-failed'; e.error = err.message; }
  }

  const failed = results.filter(r => r.status === 'error' || r.status === 'screenshot-failed').length;
  res.json({ ok: true, results, created: toShot.length, screenshotted, skipped: results.filter(r => r.status === 'skipped').length, failed });
});

app.post('/api/section-thumbs/capture', express.json(), async (req, res) => {
  const { url, selector = 'main > div', sectionIds = [] } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!sectionIds.length) return res.status(400).json({ error: 'sectionIds is required' });
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const elements = await page.$$(selector);
    const n = Math.min(elements.length, sectionIds.length);
    for (let i = 0; i < n; i++) {
      const thumbPath = path.join(THUMB_DIR, `${sectionIds[i]}.jpg`);
      await elements[i].screenshot({ path: thumbPath, type: 'jpeg', quality: 80 });
    }
    await browser.close();
    res.json({ captured: n, ids: sectionIds.slice(0, n) });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(422).json({ error: err.message });
  }
});

app.post('/api/section-thumbs/upload/:id', xmlUpload.single('thumb'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const id = req.params.id.replace(/[^a-z0-9-]/g, '-');
  try {
    const ext = req.file.mimetype === 'image/png' ? 'png'
              : req.file.mimetype === 'image/webp' ? 'webp' : 'jpg';
    // Remove any existing thumbnail for this id
    ['jpg', 'jpeg', 'png', 'webp'].forEach(e => {
      const f = path.join(THUMB_DIR, `${id}.${e}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
    const thumbPath = path.join(THUMB_DIR, `${id}.${ext}`);
    fs.writeFileSync(thumbPath, req.file.buffer);
    res.json({ ok: true, url: `/section-thumbs/${id}.${ext}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/section-thumbs/:id', (req, res) => {
  const id = req.params.id.replace(/[^a-z0-9-]/g, '-');
  try {
    ['jpg', 'jpeg', 'png', 'webp'].forEach(e => {
      const f = path.join(THUMB_DIR, `${id}.${e}`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Mapping analyzer ─────────────────────────────────────────────────────────

const AEM_XML_ROOT = path.join(__dirname, 'content-xml');
const EDS_XML_ROOT = path.join(__dirname, 'eds-jcr-xml');

// Layout/structural resource types that should not be collected as content blocks
const EDS_LAYOUT_RT = new Set([
  'core/franklin/components/section/v1/section',
  'core/franklin/components/page/v1/page',
  'core/franklin/components/root/v1/root',
  'core/franklin/components/columns/v1/columns',
  'core/franklin/components/container/v1/container',
]);

function normalizeVal(v) {
  if (typeof v !== 'string') return '';
  // Strip JCR type prefix like {Long}42 or {Boolean}true
  const stripped = v.replace(/^\{[A-Za-z:]+\}/, '').trim().toLowerCase();
  return stripped;
}

function isTrivial(v) {
  if (!v || v.length <= 1) return true;
  if (v === 'true' || v === 'false') return true;
  if (/^\d{1,2}$/.test(v)) return true;  // single/double-digit numbers
  return false;
}

// Collect all content components from AEM XML tree (regardless of migration-map)
function walkAllComponents(node, components, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 20) return;
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('@') || key === '#text') continue;
    if (!child || typeof child !== 'object') continue;
    const rt = (child['@sling:resourceType'] || '').trim();
    if (rt && !isMigrationLayout(rt)) {
      const props = {};
      for (const [k, v] of Object.entries(child)) {
        const attrKey = k.replace(/^@/, '');
        if (attrKey.startsWith('xmlns:') || JCR_SYS_SET.has(attrKey) || k === '#text') continue;
        if (v !== null && typeof v === 'object') continue;
        if (v !== '' && v !== null && v !== undefined) props[attrKey] = String(v);
      }
      components.push({ rt, props });
    }
    walkAllComponents(child, components, depth + 1);
  }
}

// Collect EDS content blocks from EDS XML tree
function walkEdsComponents(node, blocks, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 20) return;
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('@') || key === '#text') continue;
    if (!child || typeof child !== 'object') continue;
    const model = (child['@model'] || '').trim();
    const rt    = (child['@sling:resourceType'] || '').trim();
    let blockType = null;
    if (model) {
      blockType = model;
    } else if (rt && !EDS_LAYOUT_RT.has(rt)) {
      const rtLast = rt.split('/').pop();
      const skip = new Set(['block', 'section', 'root', 'page', 'item', 'container', 'blocks', 'franklin', 'core']);
      if (!skip.has(rtLast)) blockType = rtLast;
    }
    if (blockType) {
      const props = {};
      for (const [k, v] of Object.entries(child)) {
        const attrKey = k.replace(/^@/, '');
        if (attrKey.startsWith('xmlns:') || k === '#text') continue;
        // For EDS keep all non-system props (we want raw EDS prop names)
        const skipEds = new Set(['jcr:primaryType','jcr:mixinTypes','jcr:uuid','jcr:created','jcr:createdBy',
          'jcr:lastModified','jcr:lastModifiedBy','cq:lastModified','cq:lastModifiedBy',
          'sling:resourceType','model','aueComponentId','modelFields','name','filter','cq:template']);
        if (skipEds.has(attrKey)) continue;
        if (v !== null && typeof v === 'object') continue;
        if (v !== '' && v !== null && v !== undefined) props[attrKey] = String(v);
      }
      blocks.push({ blockType, props });
    }
    walkEdsComponents(child, blocks, depth + 1);
  }
}

// Recursively find all .content.xml files under a root dir
// Returns [{name: leafFolderName, filePath}]
function findContentXmlFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name === '.content.xml') {
        results.push({ name: path.basename(d).toLowerCase(), filePath: path.join(d, e.name) });
      }
    }
  }
  walk(dir);
  return results;
}

app.get('/api/analyze-mappings', (_req, res) => {
  try {
    const aemFiles = findContentXmlFiles(AEM_XML_ROOT);
    const edsFiles = findContentXmlFiles(EDS_XML_ROOT);

    const aemMap = {};
    for (const f of aemFiles) aemMap[f.name] = f.filePath;
    const edsMap = {};
    for (const f of edsFiles) edsMap[f.name] = f.filePath;

    const allAemNames = new Set(Object.keys(aemMap));
    const allEdsNames = new Set(Object.keys(edsMap));
    const pairedNames = [...allAemNames].filter(n => allEdsNames.has(n));

    // ── Phase 1: Build type-keyed inventories across ALL pages ────────────────
    // aemInventory[rt]         = [ {propName: rawValue, …}, … ]  one entry per component instance
    // edsInventory[blockType]  = [ {propName: rawValue, …}, … ]  one entry per block instance
    const aemInventory = {};  // rt → [{propName: value}]
    const edsInventory = {};  // blockType → [{propName: value}]
    const parseErrors = [];

    for (const name of [...allAemNames]) {
      const fp = aemMap[name];
      let xml;
      try { xml = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
      let tree;
      try { tree = JCR_XML_PARSER.parse(xml); } catch (e) { parseErrors.push(`AEM ${name}: ${e.message}`); continue; }
      const comps = [];
      walkAllComponents(tree['jcr:root'] || tree, comps);
      for (const { rt, props } of comps) {
        if (!aemInventory[rt]) aemInventory[rt] = [];
        aemInventory[rt].push(props);
      }
    }

    for (const name of [...allEdsNames]) {
      const fp = edsMap[name];
      let xml;
      try { xml = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
      let tree;
      try { tree = JCR_XML_PARSER.parse(xml); } catch (e) { parseErrors.push(`EDS ${name}: ${e.message}`); continue; }
      const blocks = [];
      walkEdsComponents(tree['jcr:root'] || tree, blocks);
      for (const { blockType, props } of blocks) {
        if (!edsInventory[blockType]) edsInventory[blockType] = [];
        edsInventory[blockType].push(props);
      }
    }

    // ── Phase 2: For each known rt→edsType pair, compare all prop instances ──
    // propVotes[rt][aemProp][edsProp] = count of value matches
    // propTotal[rt][aemProp]          = total cross-instance comparisons where a match was possible
    const propVotes = {};
    const propTotal = {};
    const cmap = migrationMap.componentMap || {};

    // Build the set of (rt, edsType) pairs to compare:
    // a) from migration-map  b) name-similarity for unmapped rts
    const typePairs = [];
    for (const [rt, mapping] of Object.entries(cmap)) {
      if (mapping.edsType && aemInventory[rt] && edsInventory[mapping.edsType]) {
        typePairs.push({ rt, edsType: mapping.edsType, source: 'map' });
      }
    }
    // Name-similarity for AEM rts not yet in migration-map
    const mappedRts = new Set(Object.keys(cmap));
    const edsBlockTypes = Object.keys(edsInventory);
    for (const rt of Object.keys(aemInventory)) {
      if (mappedRts.has(rt)) continue;
      const rtLast = rt.split('/').pop().toLowerCase();
      // Find EDS block types whose name contains the AEM type's last segment or vice-versa
      for (const bt of edsBlockTypes) {
        const btNorm = bt.toLowerCase().replace(/-/g, '');
        const rtNorm = rtLast.replace(/-/g, '');
        if (btNorm.includes(rtNorm) || rtNorm.includes(btNorm)) {
          typePairs.push({ rt, edsType: bt, source: 'similarity' });
        }
      }
    }

    for (const { rt, edsType } of typePairs) {
      const aemInstances = aemInventory[rt] || [];
      const edsInstances = edsInventory[edsType] || [];
      if (!aemInstances.length || !edsInstances.length) continue;

      // Pre-compute normalized EDS values: edsNorm[i][ek] = normalizedVal
      const edsNorm = edsInstances.map(inst =>
        Object.fromEntries(Object.entries(inst).map(([k, v]) => [k, normalizeVal(v)]))
      );

      // For each AEM instance, compare against every EDS instance
      for (const aemInst of aemInstances) {
        for (const [ak, av] of Object.entries(aemInst)) {
          const nav = normalizeVal(av);
          if (isTrivial(nav) || nav.length < 3) continue;
          // Check if this value appears in any EDS instance of this type
          for (let j = 0; j < edsInstances.length; j++) {
            for (const [ek, nev] of Object.entries(edsNorm[j])) {
              if (nav === nev) {
                if (!propVotes[rt]) propVotes[rt] = {};
                if (!propVotes[rt][ak]) propVotes[rt][ak] = {};
                propVotes[rt][ak][ek] = (propVotes[rt][ak][ek] || 0) + 1;
                if (!propTotal[rt]) propTotal[rt] = {};
                propTotal[rt][ak] = (propTotal[rt][ak] || 0) + 1;
              }
            }
          }
        }
      }
    }

    // ── Phase 3: Build suggestions ────────────────────────────────────────────
    const suggestions = [];
    // Only report rts that are in migration-map (improving known mappings)
    // or that have similarity-based type pairs
    const reportedRts = new Set([
      ...Object.keys(cmap),
      ...typePairs.filter(p => p.source === 'similarity').map(p => p.rt)
    ]);

    for (const rt of reportedRts) {
      if (!propVotes[rt] && cmap[rt]) {
        // Known mapping but no prop matches found — still report with empty renames
        const existing = cmap[rt];
        if (existing.edsType) {
          suggestions.push({
            rt,
            edsType: existing.edsType,
            edsTypeConf: 100,
            propRenames: {},
            propConfs: {},
            status: 'no-data',
            existingEdsType: existing.edsType,
            aemInstances: (aemInventory[rt] || []).length,
            edsInstances: (edsInventory[existing.edsType] || []).length,
          });
        }
        continue;
      }
      if (!propVotes[rt]) continue;

      // Determine edsType: from migration-map (preferred) or best similarity match
      const existing = cmap[rt];
      let edsType = existing?.edsType;
      let edsTypeConf = 100;
      let status = 'existing';

      if (!edsType) {
        // Pick the edsType from similarity pairs that has the most prop votes
        const candidatePairs = typePairs.filter(p => p.rt === rt && p.source === 'similarity');
        let bestCount = 0;
        for (const { edsType: bt } of candidatePairs) {
          const count = Object.values(propVotes[rt] || {})
            .reduce((s, ekMap) => s + (ekMap[bt] || 0), 0);
          if (count > bestCount) { bestCount = count; edsType = bt; }
        }
        edsTypeConf = 50;
        status = 'new';
      }

      const propRenames = {};
      const propConfs   = {};
      for (const [ak, ekVotes] of Object.entries(propVotes[rt] || {})) {
        const total  = propTotal[rt]?.[ak] || 0;
        const sorted = Object.entries(ekVotes).sort((a, b) => b[1] - a[1]);
        const [bestEk, bestCount] = sorted[0];
        const conf = Math.round((bestCount / total) * 100);
        if (bestCount >= 2 && conf >= 40) {
          propRenames[ak] = bestEk;
          propConfs[ak]   = conf;
        }
      }

      // Only include if there's something useful to show
      if (Object.keys(propRenames).length === 0 && status === 'existing') continue;

      suggestions.push({
        rt, edsType, edsTypeConf, propRenames, propConfs, status,
        existingEdsType: existing?.edsType || null,
        aemInstances: (aemInventory[rt] || []).length,
        edsInstances: (edsInventory[edsType] || []).length,
      });
    }

    // Sort: new first, then existing with renames, skip no-data
    const order = { new: 0, existing: 1, 'no-data': 2 };
    suggestions.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || a.rt.localeCompare(b.rt));

    res.json({
      ok: true,
      aemCount:    allAemNames.size,
      edsCount:    allEdsNames.size,
      pairedCount: pairedNames.length,
      aemTypes:    Object.keys(aemInventory).length,
      edsTypes:    Object.keys(edsInventory).length,
      parseErrors: parseErrors.slice(0, 10),
      suggestions
    });
  } catch (err) {
    console.error('[analyze-mappings]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/apply-mapping-analysis', express.json(), (req, res) => {
  try {
    const { accepted = [] } = req.body;
    if (!accepted.length) return res.json({ ok: true, applied: 0 });

    const mm = JSON.parse(fs.readFileSync(path.join(__dirname, 'migration-map.json'), 'utf8'));
    if (!mm.componentMap) mm.componentMap = {};

    let applied = 0;
    for (const { rt, edsType, propRenames } of accepted) {
      if (!rt) continue;
      if (!mm.componentMap[rt]) {
        mm.componentMap[rt] = { edsType, propRenames: propRenames || {}, skipProps: [] };
      } else {
        mm.componentMap[rt].edsType = edsType;
        const existing = mm.componentMap[rt].propRenames || {};
        mm.componentMap[rt].propRenames = { ...existing, ...(propRenames || {}) };
      }
      applied++;
    }

    fs.writeFileSync(path.join(__dirname, 'migration-map.json'), JSON.stringify(mm, null, 2), 'utf8');
    Object.assign(migrationMap, mm);
    res.json({ ok: true, applied });
  } catch (err) {
    console.error('[apply-mapping-analysis]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Block style configs endpoint ──────────────────────────────────────────────
let _blockStyleConfigsCache = null;

function loadBlockStyleConfigs() {
  if (_blockStyleConfigsCache) return _blockStyleConfigsCache;
  const configDir = path.join(__dirname, 'config');
  const result = {};
  try {
    const dirs = fs.readdirSync(configDir).filter(d => d.endsWith('-picklist-config'));
    for (const dir of dirs) {
      const xmlPath = path.join(configDir, dir, '.content.xml');
      if (!fs.existsSync(xmlPath)) continue;
      const xml = fs.readFileSync(xmlPath, 'utf8');

      // Match multi-line self-closing row elements
      const rowRe = /<row_[\s\S]*?\/>/g;
      const attrRe = /([\w:]+)="([^"]*)"/g;
      const rows = [];
      let m;
      while ((m = rowRe.exec(xml)) !== null) {
        const attrs = {};
        let a;
        attrRe.lastIndex = 0;
        while ((a = attrRe.exec(m[0])) !== null) attrs[a[1]] = a[2];
        const rawName  = attrs['Style_x0020_Name']  || '';
        const cssClass = attrs['Style_x0020_Class'] || '';
        const multiRaw = attrs['Select_x0020_Multiple'] || '';
        if (!rawName || !cssClass) continue;
        const colonIdx = rawName.indexOf(':');
        const group = colonIdx > -1 ? rawName.slice(0, colonIdx).trim() : 'General';
        const label = colonIdx > -1 ? rawName.slice(colonIdx + 1).trim() : rawName;
        rows.push({ group, label, cssClass, multiSelect: multiRaw.includes('true') });
      }

      // Group rows
      const groupMap = {};
      for (const row of rows) {
        if (!groupMap[row.group]) groupMap[row.group] = { group: row.group, multiSelect: false, options: [] };
        if (row.multiSelect) groupMap[row.group].multiSelect = true;
        groupMap[row.group].options.push({ label: row.label, cssClass: row.cssClass });
      }
      result[dir] = Object.values(groupMap);
    }
  } catch (err) {
    console.error('[block-style-configs]', err.message);
  }
  _blockStyleConfigsCache = result;
  return result;
}

app.get('/api/block-style-configs', (_req, res) => res.json(loadBlockStyleConfigs()));

// ── Style map endpoints ───────────────────────────────────────────────────────
app.get('/api/style-map', (_req, res) => res.json(styleMap));

app.post('/api/style-map', express.json(), (req, res) => {
  try {
    // Mark all incoming entries as manually saved so rebuilds won't overwrite them
    for (const [id, entry] of Object.entries(req.body)) {
      styleMap[id] = { ...(styleMap[id] || {}), ...entry, source: 'manual' };
    }
    fs.writeFileSync(path.join(__dirname, 'style-map.json'), JSON.stringify(styleMap, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Walks a parsed XML tree and collects every node with @cq:styleId
function collectAemStyles(node, result = {}, groupLabel = '', depth = 0) {
  if (!node || typeof node !== 'object' || depth > 15) return result;
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('@') || key === '#text' || !child || typeof child !== 'object') continue;
    const childGroup = child['@cq:styleGroupLabel'] || groupLabel;
    const styleId    = child['@cq:styleId'];
    if (styleId) {
      result[String(styleId)] = {
        aemLabel:   child['@cq:styleLabel']   || '',
        aemClass:   child['@cq:styleClasses'] || '',
        groupLabel: childGroup,
        edsClass:   '',
        confidence: 0,
      };
    }
    collectAemStyles(child, result, childGroup, depth + 1);
  }
  return result;
}

// Collect (styleId[], edsClasses[]) observations from paired AEM+EDS trees
function collectStyleObservations(aemNode, edsNode, observations = [], depth = 0) {
  if (!aemNode || !edsNode || depth > 20) return observations;
  for (const [key, aemChild] of Object.entries(aemNode)) {
    if (key.startsWith('@') || key === '#text' || !aemChild || typeof aemChild !== 'object') continue;
    const aemRt      = (aemChild['@sling:resourceType'] || '').trim();
    const rawIds     = aemChild['@cq:styleIds'];
    if (!rawIds || !aemRt) { collectStyleObservations(aemChild, edsNode, observations, depth + 1); continue; }
    const mapping    = migrationMap.componentMap[aemRt];
    const edsType    = mapping?.edsType || aemRt.split('/').pop();
    // find a matching EDS node by edsType (model attribute)
    const edsMatch   = findEdsNodeByModel(edsNode, edsType);
    if (edsMatch) {
      const rawClasses = edsMatch['@classes_customDynamicClass'] || '';
      const ids        = String(rawIds).replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
      const classes    = rawClasses.split(',').map(c => c.trim()).filter(Boolean);
      if (ids.length && classes.length) observations.push({ ids, classes });
    }
    collectStyleObservations(aemChild, edsNode, observations, depth + 1);
  }
  return observations;
}

function findEdsNodeByModel(node, model, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 20) return null;
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('@') || key === '#text' || !child || typeof child !== 'object') continue;
    if ((child['@model'] || '').toLowerCase() === model.toLowerCase()) return child;
    const found = findEdsNodeByModel(child, model, depth + 1);
    if (found) return found;
  }
  return null;
}

app.get('/api/build-style-map', async (req, res) => {
  try {
    const confPath = req.query.confPath;
    if (!confPath || !fs.existsSync(confPath)) {
      return res.status(400).json({ error: 'confPath not found: ' + confPath });
    }

    // Phase 1 — parse conf → AEM style definitions
    const confXml   = fs.readFileSync(confPath, 'utf8');
    const confTree  = JCR_XML_PARSER.parse(confXml);
    const aemStyles = collectAemStyles(confTree);
    console.log(`[build-style-map] found ${Object.keys(aemStyles).length} style IDs in conf`);

    // Phase 2 — collect all known EDS class names from EDS pages
    const edsDir = req.query.edsDir || path.join(__dirname, 'eds-jcr-xml');
    const edsFiles = findContentXmlFiles(edsDir);
    const edsClasses = new Set();
    for (const ef of edsFiles) {
      try {
        const raw = fs.readFileSync(ef.filePath, 'utf8');
        for (const m of raw.matchAll(/classes_customDynamicClass="([^"]+)"/g)) {
          m[1].split(',').forEach(c => { const t = c.trim(); if (t) edsClasses.add(t); });
        }
      } catch (_) {}
    }
    const edsClassList = [...edsClasses];
    console.log(`[build-style-map] found ${edsClassList.length} distinct EDS classes`);

    // Phase 3 — map each AEM style to an EDS class:
    // 3a: AEM CSS class name directly exists as an EDS class (high confidence)
    // 3b: normalised label matches an EDS class name (medium confidence)
    for (const [, entry] of Object.entries(aemStyles)) {
      const aemCls = (entry.aemClass || '').trim().toLowerCase();
      // 3a: direct name match
      if (aemCls && edsClassList.includes(aemCls)) {
        entry.edsClass = aemCls; entry.confidence = 90; continue;
      }
      // 3b: label similarity
      const label = entry.aemLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const exact = edsClassList.find(c => c === label || c.endsWith('-' + label) || c.startsWith(label + '-'));
      if (exact) { entry.edsClass = exact; entry.confidence = 65; continue; }
      const words = label.split('-').filter(w => w.length > 2);
      const partial = edsClassList.find(c => words.length >= 2 && words.every(w => c.includes(w)));
      if (partial) { entry.edsClass = partial; entry.confidence = 45; }
    }

    // Merge: always use new auto-mapping, but preserve manually-saved edsClass values
    for (const [id, entry] of Object.entries(aemStyles)) {
      entry.source = 'auto';
      const existing = styleMap[id];
      if (existing?.source === 'manual' && existing.edsClass) {
        // user manually set this — keep their value, just refresh metadata
        styleMap[id] = { ...entry, edsClass: existing.edsClass, confidence: existing.confidence, source: 'manual' };
      } else {
        styleMap[id] = entry;
      }
    }

    fs.writeFileSync(path.join(__dirname, 'style-map.json'), JSON.stringify(styleMap, null, 2), 'utf8');

    const total    = Object.keys(styleMap).length;
    const mapped   = Object.values(styleMap).filter(e => e.edsClass).length;
    res.json({ ok: true, total, mapped, unmapped: total - mapped, styleMap });
  } catch (err) {
    console.error('[build-style-map]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Find similar pages by STRUCTURE across regional sites (content-agnostic) ───
// Signature = ordered component TYPE sequence (+ layout containers); prop VALUES are
// ignored, so the same page in different languages/regions matches. Pages are scoped
// by "canonical path" = path after <country>/<lang>, so migrating who-we-are only
// compares who-we-are across regions. No dependency on EDS/migration state.
const SIM_ROOT = path.join(__dirname, 'content-xml');
const SIM_INDEX_FILE = path.join(__dirname, 'structure-index.json');
const SIM_DROP = new Set(['responsivegrid', 'parsys', 'iparsys', 'remotepage', 'root', 'page', 'xf']);
let simIndex = null;

function pageStructureSig(xml) {
  let t; try { t = JCR_XML_PARSER.parse(xml); } catch (_) { return []; }
  const jc = (t['jcr:root'] || t)['jcr:content'] || t;
  const seq = [];
  (function w(n) {
    for (const [k, v] of Object.entries(n || {})) {
      if (k.startsWith('@') || k === '#text' || !v || typeof v !== 'object') continue;
      const rt = (v['@sling:resourceType'] || '').trim();
      if (rt) { const s = rt.split('/').filter(Boolean).pop().toLowerCase(); if (!SIM_DROP.has(s)) seq.push(s); }
      w(v);
    }
  })(jc);
  return seq;
}
function buildSimIndex(force = false) {
  if (simIndex && !force) return simIndex;
  if (!force && fs.existsSync(SIM_INDEX_FILE)) {
    try { const j = JSON.parse(fs.readFileSync(SIM_INDEX_FILE, 'utf8')); if (j && j.pages) { simIndex = j; return simIndex; } } catch (_) {}
  }
  const pages = [];
  (function walk(dir) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name === '.content.xml') {
        const rel = path.relative(SIM_ROOT, path.dirname(f)).split(path.sep).join('/');
        const seg = rel.split('/');
        if (seg.length < 3) continue;                      // need country/lang/rest
        let xml = ''; try { xml = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
        const sig = pageStructureSig(xml);
        if (sig.length < 3) continue;
        pages.push({ rel, region: seg.slice(0, 2).join('/'), canon: seg.slice(2).join('/'), sig });
      }
    }
  })(SIM_ROOT);
  const byCanon = {}, df = {};
  pages.forEach((p, i) => { (byCanon[p.canon] = byCanon[p.canon] || []).push(i); new Set(p.sig).forEach(tok => df[tok] = (df[tok] || 0) + 1); });
  const N = pages.length || 1, idf = {};
  for (const [tok, d] of Object.entries(df)) idf[tok] = Math.log(N / (1 + d));
  simIndex = { pages, byCanon, idf, N: pages.length };
  try { fs.writeFileSync(SIM_INDEX_FILE, JSON.stringify(simIndex)); } catch (_) {}
  return simIndex;
}
// idf-weighted LCS similarity (0-100) — distinctive shared structure dominates.
function simScore(a, b, idf) {
  const n = a.length, m = b.length; if (!n || !m) return 0;
  let prev = new Float64Array(m + 1), cur = new Float64Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + (idf[a[i - 1]] || 0.1) : Math.max(prev[j], cur[j - 1]);
    const t = prev; prev = cur; cur = t;
  }
  const W = arr => arr.reduce((s, tk) => s + (idf[tk] || 0.1), 0);
  return Math.round(100 * prev[m] / (Math.max(W(a), W(b)) || 1));
}
function groupByStructure(items, idf, threshold) {
  const groups = [];
  for (const it of items) {
    const g = groups.find(gr => simScore(gr.repSig, it.sig, idf) >= threshold);
    if (g) g.regions.push(it.region); else groups.push({ repSig: it.sig, repRel: it.rel, regions: [it.region] });
  }
  groups.sort((a, b) => b.regions.length - a.regions.length);
  return groups;
}

app.get('/api/similar/info', (req, res) => {
  try {
    const idx = buildSimIndex(req.query.refresh === '1');
    const regions = [...new Set(idx.pages.map(p => p.region))].sort();
    const sampleCanons = Object.entries(idx.byCanon).sort((a, b) => b[1].length - a[1].length).slice(0, 80).map(([c]) => c);
    res.json({ ok: true, indexed: idx.pages.length, regions, canonCount: Object.keys(idx.byCanon).length, sampleCanons });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One page → the SAME page across all regions, ranked by structural match %.
// Returns page paths + % only (review manually, import yourself). No EDS involved.
app.post('/api/similar/page', (req, res) => {
  const idx = buildSimIndex();
  const input = String(req.body?.path || '').trim().replace(/^\/+|\/+$/g, '');
  if (!input) return res.status(400).json({ error: 'path is required' });
  let canon = input, queryRegion = null;
  const asRel = idx.pages.find(p => p.rel === input);
  if (asRel) { canon = asRel.canon; queryRegion = asRel.region; }
  else { const seg = input.split('/'); if (seg.length >= 3 && idx.byCanon[seg.slice(2).join('/')]) { canon = seg.slice(2).join('/'); queryRegion = seg.slice(0, 2).join('/'); } }
  const idxs = idx.byCanon[canon];
  if (!idxs || !idxs.length) return res.status(404).json({ error: `No page "${canon}" found in any region.` });
  const items = idxs.map(i => idx.pages[i]);
  // Reference page = the queried region's page, or (if only a canon was given) prefer us/en.
  let ref = queryRegion ? items.find(p => p.region === queryRegion) : null;
  if (!ref) { ref = items.find(p => p.region === 'us/en') || items[0]; queryRegion = ref.region; }
  const matches = items
    .filter(p => p.region !== queryRegion)
    .map(p => ({ rel: p.rel, region: p.region, score: simScore(ref.sig, p.sig, idx.idf) }))
    .sort((a, b) => b.score - a.score);
  res.json({ ok: true, canon, queryRegion, queryRel: `${queryRegion}/${canon}`, total: items.length, matches });
});

// Whole site (a region) → every page, how many regions share its structure.
app.post('/api/similar/site', (req, res) => {
  const idx = buildSimIndex();
  const region = String(req.body?.region || '').trim().replace(/^\/+|\/+$/g, '');
  const threshold = Math.max(50, Math.min(100, Number(req.body?.threshold) || 88));
  if (!region) return res.status(400).json({ error: 'region is required' });
  const inRegion = idx.pages.filter(p => p.region === region);
  if (!inRegion.length) return res.status(404).json({ error: `No pages found for region "${region}".` });
  const rows = inRegion.map(p => {
    const items = idx.byCanon[p.canon].map(i => idx.pages[i]);
    const groups = groupByStructure(items, idx.idf, threshold);
    const mine = groups.find(g => g.regions.includes(region)) || groups[0];
    return { canon: p.canon, regions: items.length, variants: groups.length, shared: mine.regions.length };
  }).sort((a, b) => b.shared - a.shared || a.canon.localeCompare(b.canon));
  res.json({ ok: true, region, threshold, count: rows.length, rows: rows.slice(0, 2000) });
});

// ── Migrate Full Site: for every page in a locale, find its best ALREADY-MIGRATED
// structural match (among user-configured migrated regions) to reuse as the canvas. ──
app.post('/api/migrate-site/plan', (req, res) => {
  const idx = buildSimIndex();
  const locale = String(req.body?.locale || '').trim().replace(/^\/+|\/+$/g, '');
  const migrated = new Set((Array.isArray(req.body?.migratedRegions) ? req.body.migratedRegions : [])
    .map(s => String(s).trim().replace(/^\/+|\/+$/g, '')).filter(Boolean));
  const edsPrefix = (String(req.body?.edsPrefix || '').trim() || '/content/abbvie-nextgen-eds/corporate/abbvie-com').replace(/\/+$/, '');
  if (!locale) return res.status(400).json({ error: 'locale is required' });
  if (!migrated.size) return res.status(400).json({ error: 'Configure at least one migrated region.' });
  const pagesInLocale = idx.pages.filter(p => p.region === locale);
  if (!pagesInLocale.length) return res.status(404).json({ error: `No pages found for locale "${locale}".` });

  // Candidate pool for the fallback = all pages in migrated regions (any path).
  const migPages = idx.pages.filter(p => migrated.has(p.region) && p.region !== locale);
  const mk = c => ({ region: c.region, canon: c.canon, score: simScore(pagesInLocale, c, idx.idf), edsPath: `${edsPrefix}/${c.region}/${c.canon}` });
  const rows = pagesInLocale.map(src => {
    // 1) Primary: same path hierarchy (same canon) in a migrated region.
    let scored = (idx.byCanon[src.canon] || []).map(i => idx.pages[i])
      .filter(p => migrated.has(p.region) && p.region !== locale)
      .map(c => ({ region: c.region, canon: c.canon, score: simScore(src.sig, c.sig, idx.idf), edsPath: `${edsPrefix}/${c.region}/${c.canon}`, sameHierarchy: true }))
      .sort((a, b) => b.score - a.score);
    let fallback = false;
    // 2) Fallback: no same-path match (localized slug/hierarchy) → best structural match anywhere in migrated sites.
    if (!scored.length) {
      fallback = true;
      const lo = src.sig.length * 0.55, hi = src.sig.length * 1.6;
      scored = migPages.filter(c => c.sig.length >= lo && c.sig.length <= hi)
        .map(c => ({ region: c.region, canon: c.canon, score: simScore(src.sig, c.sig, idx.idf), edsPath: `${edsPrefix}/${c.region}/${c.canon}`, sameHierarchy: false }))
        .sort((a, b) => b.score - a.score).slice(0, 8);
    }
    return { canon: src.canon, sourceRel: src.rel, fallback, best: scored[0] || null, matches: scored.slice(0, 8) };
  }).sort((a, b) => (b.best ? b.best.score : -1) - (a.best ? a.best.score : -1));

  res.json({ ok: true, locale, total: rows.length, withMatch: rows.filter(r => r.best).length, rows });
});

// Detect already-migrated regions by querying the live AEM instance under the EDS
// content root (depth-2 → country/lang), intersected with known content-xml locales.
app.post('/api/migrate-site/detect-regions', async (req, res) => {
  const { aemHost, username, password } = req.body || {};
  const edsPrefix = (String(req.body?.edsPrefix || '').trim() || '/content/abbvie-nextgen-eds/corporate/abbvie-com').replace(/\/+$/, '');
  if (!aemHost || !username || !password) return res.status(400).json({ error: 'aemHost, username and password are required (Connection tab).' });
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const url = `${aemHost.replace(/\/+$/, '')}${edsPrefix}.2.json`;
  let json;
  try {
    const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!r.ok) return res.status(502).json({ error: `AEM returned ${r.status} for ${edsPrefix}.2.json` });
    json = await r.json();
  } catch (e) { return res.status(502).json({ error: `Could not reach AEM: ${e.message}` }); }
  const SYS = /^(jcr:|rep:|cq:|sling:|:)/;
  const edsRegions = new Set();
  for (const [country, cval] of Object.entries(json)) {
    if (SYS.test(country) || !cval || typeof cval !== 'object') continue;
    for (const [lang, lval] of Object.entries(cval)) {
      if (SYS.test(lang) || !lval || typeof lval !== 'object') continue;
      edsRegions.add(`${country}/${lang}`);
    }
  }
  const known = new Set(buildSimIndex().pages.map(p => p.region));
  const regions = [...edsRegions].filter(r => known.has(r)).sort();
  res.json({ ok: true, edsFound: edsRegions.size, regions });
});

// Parse one local source page (content-xml/<rel>/.content.xml) into a content pool
// used to fill an imported EDS canvas during Migrate Full Site.
app.post('/api/parse-local-xml', (req, res) => {
  const rel = String(req.body?.rel || '').trim().replace(/^\/+|\/+$/g, '');
  if (!rel) return res.status(400).json({ error: 'rel is required' });
  const abs = path.resolve(SIM_ROOT, rel, '.content.xml');
  if (!abs.startsWith(path.resolve(SIM_ROOT) + path.sep)) return res.status(400).json({ error: 'path outside content-xml' });
  let xml; try { xml = fs.readFileSync(abs, 'utf8'); } catch (e) { return res.status(404).json({ error: `Cannot read ${rel}: ${e.message}` }); }
  try {
    const tree = JCR_XML_PARSER.parse(xml);
    const jcrContent = (tree['jcr:root'] || tree)['jcr:content'] || tree;
    const meta = {};
    const metaKeySet = new Set(migrationMap.metaKeys || []);
    for (const [k, v] of Object.entries(jcrContent)) {
      if (!k.startsWith('@')) continue;
      const key = k.replace(/^@/, '');
      if (metaKeySet.has(key) && v) meta[key] = v;
    }
    const ordered = [];
    walkXmlNode(jcrContent, ordered);
    const pageTitle = String(jcrContent['@jcr:title'] || meta['jcr:title'] || '').trim() || rel.split('/').pop();
    res.json({ ok: true, rel, pageTitle, meta, ordered });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`AEM Page Builder -> http://localhost:${PORT}`));
