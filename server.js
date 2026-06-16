'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');

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
    props[k] = v;
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

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`AEM Page Builder -> http://localhost:${PORT}`));
