'use strict';

const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const multer    = require('multer');
const { XMLParser } = require('fast-xml-parser');

// ── Migration map (AEM Sites resourceType → EDS block) ───────────────────────
let migrationMap = { componentMap: {}, layoutResources: [], metaKeys: [], jcrSystemProps: [] };
try {
  migrationMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'migration-map.json'), 'utf8'));
} catch (_) { console.warn('[migration] migration-map.json not found'); }

// ── Path map (AEM → EDS path/asset transformations) ──────────────────────────
let pathMap = { contentPrefixRules: [], damPrefixRules: [], assetMap: [] };
try {
  pathMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'path-map.json'), 'utf8'));
} catch (_) { console.warn('[paths] path-map.json not found, using identity transform'); }

// Transforms a single AEM path value to its EDS equivalent.
// DAM paths: apply prefix rule first → look up updated path in assetMap for DM Open API URL → fallback to updated path.
// Content paths: apply prefix rule → fallback to original.
function transformPath(value, pm) {
  if (!pm || typeof value !== 'string' || !value.startsWith('/content/')) return value;

  if (value.startsWith('/content/dam/')) {
    // 1. Apply DAM prefix rule to get the updated path
    let updatedPath = value;
    for (const rule of (pm.damPrefixRules || [])) {
      if (rule.aemPrefix && value.startsWith(rule.aemPrefix)) {
        updatedPath = (rule.edsPrefix || '') + value.slice(rule.aemPrefix.length);
        break;
      }
    }
    // 2. Check asset map (keyed by updated path) for DM Open API URL
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
    const sections = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
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
    return res.status(502).json({ ok: false, error: `Page shell creation failed (${r1.status}): ${txt.slice(0, 300)}` });
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
    return res.status(502).json({ ok: false, error: `Content import failed (${r2.status}): ${txt.slice(0, 300)}` });
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
// Priority: model → aueComponentId → last meaningful sling:resourceType segment.
function deriveType(v) {
  if (v.model) return v.model;
  if (v.aueComponentId) return v.aueComponentId;
  const rt = v['sling:resourceType'] || '';
  if (!rt) return null;
  // Strip trailing version+name, e.g. "/v1/block" → keep what came before
  const clean = rt.replace(/\/v\d+\/[^/]+$/, '');
  const last = clean.split('/').filter(Boolean).pop() || '';
  const skip = new Set(['block', 'section', 'root', 'page', 'item', 'container', 'blocks', 'franklin', 'core']);
  return skip.has(last) ? null : last;
}

// Section-level nodes (root children) — must carry model or aueComponentId
function isCompNode(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && (v.model || v.aueComponentId);
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

// Returns block-level children using the more lenient isBlockNode detector.
// Also recurses one extra level to handle pages with an intermediate container
// node ("par" parsys pattern common in older AEM migrations).
function extractJcrBlocks(node) {
  const direct = Object.values(node).filter(isBlockNode);
  if (direct.length > 0) {
    return direct.map(v => ({
      type:     deriveType(v),
      props:    extractJcrProps(v),
      children: Object.values(v).filter(isBlockNode)
                 .map(c => ({ type: deriveType(c), props: extractJcrProps(c), children: [] }))
    }));
  }
  // Fallback: one level deeper
  const containers = Object.values(node).filter(
    v => v && typeof v === 'object' && !Array.isArray(v) && !isBlockNode(v) &&
         (!v['jcr:primaryType'] || v['jcr:primaryType'] === 'nt:unstructured')
  );
  for (const ct of containers) {
    const nested = Object.values(ct).filter(isBlockNode);
    if (nested.length > 0) {
      return nested.map(v => ({
        type:     deriveType(v),
        props:    extractJcrProps(v),
        children: Object.values(v).filter(isBlockNode)
                   .map(c => ({ type: deriveType(c), props: extractJcrProps(c), children: [] }))
      }));
    }
  }
  return [];
}

function parseRootNode(root) {
  // Section-level nodes still require model/aueComponentId
  const entries = Object.entries(root).filter(([, v]) => isCompNode(v));
  console.log(`[import] root has ${entries.length} component nodes:`,
    entries.map(([k, v]) => `${k}(${deriveType(v)})`).join(', '));

  const sections = [];
  let i = 0;
  while (i < entries.length) {
    const [, node] = entries[i];
    const type = deriveType(node);
    if (type === 'grid-container') {
      const sec = { type: 'grid-container', props: extractJcrProps(node), blocks: [] };
      i++;
      while (i < entries.length && deriveType(entries[i][1]) === 'grid-section') {
        const [, gsNode] = entries[i];
        const gsBlocks = extractJcrBlocks(gsNode);
        console.log(`[import]   grid-section blocks: ${gsBlocks.length}`);
        sec.blocks.push({ type: 'grid-section', props: extractJcrProps(gsNode), children: gsBlocks });
        i++;
      }
      sections.push(sec);
    } else {
      const blocks = extractJcrBlocks(node);
      console.log(`[import] section(${type}) blocks: ${blocks.length}`);
      sections.push({ type, props: extractJcrProps(node), blocks });
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
    const url = `${aemHost.replace(/\/+$/, '')}${cleanPath}/jcr:content.infinity.json`;
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
  const renames  = mapping?.propRenames  || {};
  const skipSet  = new Set([...(mapping?.skipProps || []), ...JCR_SYS_SET]);
  const props = {};
  for (const [k, v] of Object.entries(attrs)) {
    const key = k.replace(/^@/, '');  // strip attribute prefix
    if (skipSet.has(key)) continue;
    if (key.startsWith('xmlns:')) continue;
    const targetKey = renames[key] || key;
    if (v !== '' && v !== null && v !== undefined) props[targetKey] = transformPath(v, pm);
  }
  return props;
}

function walkXmlNode(node, ordered, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 20) return;
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('@') || key === '#text') continue;
    if (!child || typeof child !== 'object') continue;
    const rt = (child['@sling:resourceType'] || '').trim();
    if (!rt || isMigrationLayout(rt)) {
      // skip this node but descend into its children
      walkXmlNode(child, ordered, depth + 1);
      continue;
    }
    const mapping = migrationMap.componentMap[rt];
    const type    = mapping?.edsType || rt.split('/').pop();
    const props   = extractPropsFromXmlNode(child, mapping, pathMap);

    // If this component should render its main content as a child block
    if (mapping?.childType && mapping?.childProp && props[mapping.childProp] !== undefined) {
      const childVal = props[mapping.childProp];
      delete props[mapping.childProp];
      ordered.push({
        type, resourceType: rt, props,
        children: [{ type: mapping.childType, props: { [mapping.childProp]: childVal }, children: [] }]
      });
    } else {
      ordered.push({ type, resourceType: rt, props, children: [] });
    }
    walkXmlNode(child, ordered, depth + 1);
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
      // Prefer col 5 (openApiUrl from 6-col export), fall back to col 1 (simple 2-col format)
      const rawUrl = cols.length >= 6 ? (cols[5] || '') : (cols[1] || '');
      // Only use as DM URL if it's a real https URL (not a /content/ fallback path)
      const dmUrl = rawUrl.startsWith('https://') ? rawUrl : '';
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
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`AEM Page Builder -> http://localhost:${PORT}`));
