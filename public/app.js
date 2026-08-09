'use strict';

// ── State ────────────────────────────────────────────────────────────────────
const S = {
  config:         null,   // { defs, modelMap, filterMap, compMap }
  migrationMap:   null,   // loaded from /api/migration-map
  pathMap:        null,   // loaded from /api/path-map
  xmlPool:        null,   // [{ type, props, children }] from last XML parse — drives pool picker
  conn:           { aemHost: '', username: '', password: '', parentPath: '', pageName: '', ueOrg: 'abbviecommercial', ok: false },
  meta:           {},     // page metadata values (jcr:title, navTitle, …)
  sections:       [],     // [{ id, type, props, blocks: [{ id, type, props, children: [] }] }]
  collapsed:      new Set(), // secIds that are collapsed
  sel:            null,   // { secId, blkId?, childId? } — selected item
  modal:          null,   // 'settings' | 'block-picker' | 'preview'
  pickCtx:        null,   // { secId, blkId? } — where to add picked item
  result:         null,
  creating:       false,
  saveTplSecId:   null,
  paletteTab:     'sections',  // 'components' | 'sections'
  sectionsLib:    [],     // predefined sections loaded from /api/sections
  bulkTemplate:   null,   // deep clone of S.sections used as layout template for bulk import
  bulkPages:      [],     // [{ fileName, slug, pageTitle, edsPath, sections, filled, skipped, status, error }]
  findSimilar:    { info: null, mode: 'page', path: '', region: '', threshold: 88, busy: false, result: null, error: null, expanded: {} },
  compareModal:   null,   // { liveUrl, migratedUrl, canon } — split-view comparison modal
  migrateSite:    { edsPrefix: '/content/abbvie-nextgen-eds/corporate/abbvie-com', regionSel: [], targetRoot: '', locale: '', minScore: 80, liveBase: '', a11yBackfill: true, busy: false, plan: null, error: null, editIdx: null },
};

let _uid = 0;
const uid = () => `id_${++_uid}`;

function deepCloneWithNewIds(item) {
  const clone = JSON.parse(JSON.stringify(item));
  function reId(obj) {
    obj.id = uid();
    delete obj._jcrKey;
    for (const ch of obj.children || []) reId(ch);
    for (const blk of obj.blocks   || []) reId(blk);
  }
  reId(clone);
  return clone;
}

let _settingsTab = 'connection';
let _styleEntries = null; // { styleId: { aemLabel, aemClass, groupLabel, edsClass, confidence } }
let _blockStyleConfigs = {}; // { "accordion-picklist-config": [{ group, multiSelect, options:[{label,cssClass}] }] }
let _mappingExpanded = null; // currently expanded resourceType string
let _gapData = {};           // rt → gap analysis result from /api/mapping-gap
let _view = 'canvas'; // 'canvas' | 'settings' | 'help'


// ── Canvas persistence ────────────────────────────────────────────────────────
const CANVAS_KEY   = 'aem_canvas_draft';
const MIGRATE_KEY  = 'aem_migrate_plan';

// ── Migrate-plan persistence ──────────────────────────────────────────────────
function saveMigratePlan() {
  try {
    const ms = S.migrateSite;
    if (!ms.plan) { localStorage.removeItem(MIGRATE_KEY); return; }
    // Strip heavy sections[] from done rows to keep storage lean; keep them for
    // ready rows so they can still be published after a refresh.
    const rows = ms.plan.rows.map(r => {
      const row = { ...r };
      if (r.status === 'done') delete row.sections;
      return row;
    });
    const payload = {
      plan:       { ...ms.plan, rows },
      edsPrefix:  ms.edsPrefix,
      regionSel:  ms.regionSel,
      targetRoot: ms.targetRoot,
      locale:     ms.locale,
      minScore:   ms.minScore,
      liveBase:   ms.liveBase,
      a11yBackfill: ms.a11yBackfill,
    };
    localStorage.setItem(MIGRATE_KEY, JSON.stringify(payload));
  } catch (_) {}
}

function loadMigratePlan() {
  try {
    const raw = localStorage.getItem(MIGRATE_KEY);
    if (!raw) return false;
    const payload = JSON.parse(raw);
    if (!payload || !payload.plan) return false;
    Object.assign(S.migrateSite, {
      plan:       payload.plan,
      edsPrefix:  payload.edsPrefix  ?? S.migrateSite.edsPrefix,
      regionSel:  payload.regionSel  ?? S.migrateSite.regionSel,
      targetRoot: payload.targetRoot ?? S.migrateSite.targetRoot,
      locale:     payload.locale     ?? S.migrateSite.locale,
      minScore:   payload.minScore   ?? S.migrateSite.minScore,
      liveBase:   payload.liveBase   ?? S.migrateSite.liveBase,
      a11yBackfill: payload.a11yBackfill ?? S.migrateSite.a11yBackfill,
    });
    return true;
  } catch (_) {}
  return false;
}

function saveCanvas() {
  try {
    localStorage.setItem(CANVAS_KEY, JSON.stringify({
      sections:  S.sections,
      meta:      S.meta,
      collapsed: [...S.collapsed],
    }));
  } catch (_) {}
}

// Enforce Standard/no-line separators + standard,bold eyebrows on a canvas in place (mirrors
// server aem-canvas.normalizeBlock). Runs automatically wherever a canvas is loaded for review,
// so the user never has to click a button for it. Returns {sep, eb} counts.
function normalizeCanvasBlocks(sections) {
  let sep = 0, eb = 0;
  const visit = b => {
    if (b && b.props) {
      if (b.type === 'separator') {
        // Keep height/variant classes derived from AEM style IDs. Use 24px only
        // for a separator that has no source styling at all.
        const before = (b.props.classes_customDynamicClass || '') + '|' + b.props.showLine;
        const cls = String(b.props.classes_customDynamicClass || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!cls.length) cls.unshift('separator-height-24');
        b.props.classes_customDynamicClass = cls.join(','); b.props.showLine = '{Boolean}false';
        if (before !== (b.props.classes_customDynamicClass + '|' + b.props.showLine)) sep++;
      }
      // Eyebrow variation is derived from the AEM header styleId at generation time; do NOT force
      // it here (post-hoc the styleIds are gone and the block already carries its correct variation).
    }
    (b.children || []).forEach(visit);
  };
  for (const s of (sections || [])) for (const b of (s.blocks || [])) visit(b);
  return { sep, eb };
}

function loadCanvas() {
  try {
    const raw = localStorage.getItem(CANVAS_KEY);
    if (!raw) return false;
    const { sections, meta, collapsed } = JSON.parse(raw);
    if (Array.isArray(sections) && sections.length > 0) {
      normalizeCanvasBlocks(sections);   // auto-fix old drafts built before the normalize rules
      S.sections  = sections;
      S.meta      = meta || {};
      S.collapsed = new Set(collapsed || []);
      // keep _uid ahead of any restored ids
      sections.forEach(function bump(sec) {
        const n = parseInt((sec.id || '').replace('id_', ''), 10);
        if (n > _uid) _uid = n;
        (sec.blocks || []).forEach(b => {
          const nb = parseInt((b.id || '').replace('id_', ''), 10);
          if (nb > _uid) _uid = nb;
          (b.children || []).forEach(c => {
            const nc = parseInt((c.id || '').replace('id_', ''), 10);
            if (nc > _uid) _uid = nc;
          });
        });
      });
      return true;
    }
  } catch (_) {}
  return false;
}

// ── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  // Restore saved connection settings
  try {
    const saved = localStorage.getItem('aem_conn');
    if (saved) Object.assign(S.conn, JSON.parse(saved));
  } catch (_) {}
  const hasDraft = loadCanvas();
  loadMigratePlan();

  const [configRes, sectionsRes, migrRes, pathMapRes] = await Promise.all([
    fetch('/api/config'), fetch('/api/sections'), fetch('/api/migration-map'), fetch('/api/path-map')
  ]);
  if (configRes.ok)    S.config       = await configRes.json();
  if (sectionsRes.ok)  S.sectionsLib  = await sectionsRes.json();
  if (migrRes.ok)      S.migrationMap = await migrRes.json();
  if (pathMapRes.ok)   S.pathMap      = await pathMapRes.json();

  // Eagerly load block style configs so props panel can render dropdowns immediately
  fetch('/api/block-style-configs').then(r => r.json()).then(d => { _blockStyleConfigs = d; render(); }).catch(() => {});

  if (hasDraft) S.sel = S.sections.length > 0 ? { secId: S.sections[0].id } : null;
  S._draftRestored = hasDraft;
  render();
})();

// ── Render ───────────────────────────────────────────────────────────────────
function render() {
  saveCanvas();
  saveMigratePlan();
  document.getElementById('root').innerHTML = html();
  bind();
}

function html() {
  return `
    ${S.result ? resultOverlayHtml() : ''}
    ${S.modal === 'block-picker'      ? blockPickerModalHtml()     : ''}
    ${S.modal === 'save-template'     ? saveTemplateModalHtml()    : ''}
    ${S.modal === 'bundle-save'       ? bundleSaveModalHtml()      : ''}
    ${S.modal === 'publish-aem'       ? renderPublishModal(S._publishChanges || []) : ''}
    ${S.modal === 'validation-detail' ? validationDetailModalHtml()                 : ''}
    ${S.modal === 'a11y-warning'      ? a11yWarningModalHtml(S._a11yIssues || [], S._a11yPendingAction || '') : ''}
    ${S.compareModal                  ? compareModalHtml()                                                    : ''}
    ${topbarHtml()}
    ${S._draftRestored ? `<div class="draft-banner" id="draft-banner">
      Draft restored — ${S.sections.length} section${S.sections.length !== 1 ? 's' : ''} reloaded from your last session.
      <button class="draft-dismiss" id="btn-dismiss-draft">✕</button>
    </div>` : ''}
    ${S.xmlPool ? `<div class="draft-banner migr-banner">
      XML pool ready (<strong>${S.xmlPool.length} item${S.xmlPool.length !== 1 ? 's' : ''}</strong> from <em>${x(S._xmlFileName || '')}</em>) — select any block to manually correct its content.
      <button class="draft-dismiss" id="btn-dismiss-xml-pool">✕</button>
    </div>` : ''}
    ${S._migrResult ? `<div class="draft-banner migr-banner">
      ✓ Filled <strong>${S._migrResult.filled} block${S._migrResult.filled !== 1 ? 's' : ''}</strong> from <em>${x(S._migrResult.fileName)}</em>${S._migrResult.skipped > 0 ? ` — ${S._migrResult.skipped} skipped (no XML match)` : ''}. Review the canvas then click Create.
      <button class="draft-dismiss" id="btn-dismiss-migr">✕</button>
    </div>` : ''}
    ${(S.migrateSite && S.migrateSite.editIdx != null && S.migrateSite.plan) ? `<div class="draft-banner migr-banner" style="background:#ede9fe;border-color:#c4b5fd">
      Reviewing migration canvas for <strong>${x(S.migrateSite.plan.rows[S.migrateSite.editIdx].canon)}</strong> — edit as needed, then save.
      <button class="btn btn-xs btn-ghost" id="btn-fill-a11y" style="margin-left:8px" title="Fill image alt/caption/CTA aria from the live AEM page (separators + eyebrows are normalized automatically during canvas filling)">${S._a11yBusy ? '⏳ Working…' : '♿ Fill accessibility'}</button>
      <button class="btn btn-xs btn-primary" id="btn-mig-save-canvas" style="margin-left:8px">💾 Save &amp; back to Migrate Full Site</button>
      ${S._a11yMsg ? `<span style="margin-left:8px;font-size:.72rem;color:${S._a11yErr ? 'var(--danger)' : 'var(--brand)'}">${x(S._a11yMsg)}</span>` : ''}
    </div>` : ''}
<div class="workspace">
      ${paletteHtml()}
      ${_view === 'canvas' ? canvasHtml() + propsHtml() : _view === 'help' ? helpViewHtml() : settingsViewHtml()}
    </div>`;
}

function topbarHtml() {
  return `<div class="topbar">
    <h1>⚡ EDS Page Builder</h1>
    <div class="view-tabs">
      <button class="vtab ${_view === 'canvas' ? 'vtab-active' : ''}" id="vtab-canvas">Canvas</button>
      <button class="vtab ${_view === 'settings' ? 'vtab-active' : ''}" id="vtab-settings">⚙ Settings</button>
      <button class="vtab ${_view === 'help' ? 'vtab-active' : ''}" id="vtab-help">? Help</button>
    </div>
    ${S.conn.pageName
      ? `<span class="page-slug">${x(S.conn.parentPath)}/<strong>${x(S.conn.pageName)}</strong></span>`
      : `<span class="page-slug" style="opacity:.5">no page name set</span>`}
    <span class="conn-badge ${S.conn.ok ? 'ok' : 'idle'}" style="margin-left:4px">
      ${S.conn.ok ? '✓ Connected' : '○ Not tested'}
    </span>
    ${S.sections.length > 0 ? `<button class="btn btn-ghost btn-sm draft-clear-btn" id="btn-clear-draft" title="Discard all sections">✕ Clear</button>` : ''}
    ${S._importedFromAem ? `<button class="btn btn-sm btn-publish-aem" id="btn-publish-aem" title="Write changed properties back to AEM">↑ Publish to AEM</button>` : ''}
    <button class="btn btn-primary btn-sm" id="btn-create" ${S.creating ? 'disabled' : ''}>
      ${S.creating ? '<span class="spinner"></span> Creating…' : '▶ Create Page'}
    </button>
  </div>`;
}

// ── Palette ───────────────────────────────────────────────────────────────────
const COMP_ICONS = {
  section: '▣', 'grid-container': '⊞', 'grid-section': '▤',
  accordion: '☰', 'accordion-item': '↳', breadcrumb: '🔢',
  'brightcove-video': '▶', 'brightcove-podcast-player': '🎙', video: '▶',
  cards: '🃏', card: '↳', carousel: '🎠', cta: '🔗', 'custom-embed': '⌗',
  'custom-image': '🖼', 'custom-title': 'T', 'editorial-feed': '📰',
  'eyebrow-text': '✏', 'fact-card': '📋', fragment: '⧉',
  'hero-container': '🦸', 'hero-container-item': '↳', hero: '🦸',
  linklist: '🔗', 'linklist-item': '↳', 'navigation-content': '🧭',
  'news-feed': '📰', pipeline: '⚗', 'pipeline-utility-nav': '⚗',
  'press-releases': '📣', 'product-listing': '📦', quote: '"',
  'search-input': '🔍', 'search-results': '🔍', search: '🔍',
  separator: '⸺', 'social-media': '🌐', 'social-link': '↳',
  'stock-ticker': '📈', 'story-card': '🃏', 'story-cards': '🃏',
  table: '⊟', tabs: '⬜', teaser: '📌', 'tag-utility-nav': '🏷',
  'text-container': '📝', 'text-container-text': '↳', 'text-container-image': '↳',
};

// Derived live from component-definition.json groups — no hardcoding needed.
function getPaletteGroups() {
  const groups = S.config?.defs?.groups || [];
  return groups.map(g => ({
    label: g.title || g.id,
    ids:   (g.components || []).map(c => c.id),
  }));
}

function paletteHtml() {
  const isLib = S.paletteTab === 'sections';
  return `<aside class="palette">
    <div class="palette-tabs">
      <button class="ptab ${isLib ? '' : 'active'}" data-ptab="components">EDS Blocks</button>
      <button class="ptab ${isLib ? 'active' : ''}" data-ptab="sections">
        Sections ${S.sectionsLib.length ? `<span class="ptab-count">${S.sectionsLib.length}</span>` : ''}
      </button>
    </div>
    ${isLib ? sectionLibHtml() : componentsTabHtml()}
  </aside>`;
}

function componentsTabHtml() {
  const groups = getPaletteGroups().map(g => {
    const items = g.ids.map(id => {
      const comp = S.config?.compMap?.[id];
      const label = comp?.title || id;
      const icon  = COMP_ICONS[id] || '□';
      return `<div class="palette-item" data-add="${id}" data-label="${(label).toLowerCase()}">
        <span class="pi-icon">${icon}</span>
        <span class="pi-label">${x(label)}</span>
      </div>`;
    }).join('');
    return `<div class="palette-group" data-group>
      <div class="palette-group-title">${g.label}</div>
      ${items}
    </div>`;
  }).join('');
  return `
    <input class="palette-search" id="comp-search" placeholder="Search EDS blocks…" autocomplete="off" style="margin:6px 8px 2px;width:calc(100% - 16px);box-sizing:border-box"/>
    <div class="palette-scroll" id="comp-scroll">${groups}</div>`;
}

function sectionThumbnailSvg(def) {
  const W = 110, H = 62;
  // Multi-section bundle: show stacked mini-rows
  if (def?.sections) {
    const n = def.sections.length;
    const rowH = Math.floor((H - 4 - (n - 1) * 2) / n);
    let body = `<rect width="${W}" height="${H}" fill="#eef1fb" rx="3"/>`;
    def.sections.forEach((s, i) => {
      const y = 2 + i * (rowH + 2);
      const bg = s.props?.['style_bg-color'] ? '#dce9fe' : (s.type === 'grid-container' ? '#e8f0fe' : '#f0f4ff');
      body += `<rect x="3" y="${y}" width="${W-6}" height="${rowH}" fill="${bg}" rx="2"/>`;
      const blocks = s.blocks || [];
      if (s.type === 'grid-container') {
        const cols = blocks.map(b => { const m = (b.props?.style_customDynamicClass||'').match(/grid-cols-(\d+)/); return m ? +m[1] : 1; });
        const total = cols.reduce((a,b)=>a+b,0)||12;
        let cx = 5; const avail = W-10;
        cols.forEach((c,ci) => {
          const cw = Math.round((c/total)*avail);
          body += `<rect x="${cx}" y="${y+2}" width="${cw-1}" height="${rowH-4}" fill="${['#4f8ef7','#6366f1','#8b5cf6'][ci%3]}" rx="1"/>`;
          cx += cw;
        });
      } else {
        blocks.slice(0,3).forEach((b,bi) => {
          body += `<rect x="5" y="${y+2+bi*Math.floor((rowH-4)/Math.max(blocks.length,1))}" width="${W-10}" height="${Math.max(Math.floor((rowH-4)/Math.max(blocks.length,1))-1,2)}" fill="#7aabfa" rx="1"/>`;
        });
      }
    });
    // Bundle badge
    body += `<rect x="${W-18}" y="2" width="16" height="10" fill="#4f8ef7" rx="2"/><text x="${W-10}" y="10" font-size="6" fill="#fff" text-anchor="middle" font-family="sans-serif">${n}×</text>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
  }
  const sec = def?.section;
  if (!sec) return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#eef1fb" rx="3"/></svg>`;
  const blocks = sec.blocks || [];
  const inner = { x: 3, y: 3, w: W - 6, h: H - 6 };
  const BLOCK_COLOR = {
    'hero-container': '#1e40af', 'hero-container-item': '#1e40af',
    'breadcrumb': '#94a3b8', 'custom-title': '#3b82f6',
    'text-container': '#93c5fd', 'text-container-text': '#bfdbfe',
    'accordion': '#8b5cf6', 'brightcove-video': '#ec4899',
    'video': '#ec4899', 'quote': '#10b981', 'cta': '#f97316',
    'linklist': '#60a5fa', 'linklist-item': '#93c5fd',
    'separator': '#cbd5e1', 'custom-image': '#4ade80',
    'story-cards': '#c084fc', 'story-card': '#d8b4fe',
    'fact-card': '#fb923c', 'teaser': '#2dd4bf',
    'eyebrow-text': '#94a3b8', 'carousel': '#8b5cf6',
  };
  const COL_FILLS = ['#3b82f6','#6366f1','#8b5cf6','#06b6d4','#0ea5e9','#4f46e5'];
  let body = '';

  if (sec.type === 'grid-container') {
    const bgProp = sec.props?.['style_bg-color'] || '';
    const bgMap = { 'bg-8a2ecc': '#ede9fe', 'bg-071d49': '#dbeafe', 'bg-f1f3ff': '#eef1fb', 'bg-f4f4f4': '#f3f4f6' };
    const bg = bgMap[bgProp] || '#eef4ff';
    body += `<rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${inner.h}" fill="${bg}" rx="3"/>`;
    const cols = blocks.map(b => { const m = (b.props?.style_gridCols || 'grid-cols-1').match(/grid-cols-(\d+)/); return m ? +m[1] : 1; });
    const total = cols.reduce((a, b) => a + b, 0) || 12;
    const GAP = 2, pad = 4;
    const avail = inner.w - pad * 2 - GAP * (cols.length - 1);
    let cx = inner.x + pad;
    cols.forEach((c, i) => {
      const cw = Math.round((c / total) * avail);
      const ch = blocks[i]?.children || [];
      const fill = ch.length ? COL_FILLS[i % COL_FILLS.length] : '#d1dafe';
      body += `<rect x="${cx}" y="${inner.y + 5}" width="${cw}" height="${inner.h - 10}" rx="2" fill="${fill}"/>`;
      ch.slice(0, 3).forEach((kid, li) => {
        const lc = BLOCK_COLOR[kid.type] || '#fff';
        const rowH = Math.floor((inner.h - 14) / Math.max(ch.length, 1));
        body += `<rect x="${cx+2}" y="${inner.y + 7 + li * (rowH + 1)}" width="${cw - 4}" height="${Math.max(rowH - 1, 3)}" rx="1" fill="${lc}" opacity=".8"/>`;
      });
      cx += cw + GAP;
    });
  } else {
    body += `<rect x="${inner.x}" y="${inner.y}" width="${inner.w}" height="${inner.h}" fill="#eef4ff" rx="3"/>`;
    const count = Math.min(blocks.length, 6) || 1;
    const GAP = 2, pad = 3;
    const bh = Math.floor((inner.h - pad * 2 - GAP * (count - 1)) / count);
    for (let i = 0; i < count; i++) {
      const fill = BLOCK_COLOR[blocks[i]?.type] || '#93c5fd';
      body += `<rect x="${inner.x + pad}" y="${inner.y + pad + i * (bh + GAP)}" width="${inner.w - pad * 2}" height="${Math.max(bh, 3)}" rx="2" fill="${fill}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
}

let _slcSearch = '';

function sectionCategory(def) {
  const id = def.id || '';
  if (id.startsWith('article-'))                          return 'Article';
  if (id.startsWith('hero-'))                             return 'Hero';
  if (id.startsWith('grid-'))                             return 'Grid';
  if (id.startsWith('related-'))                          return 'Related';
  if (id.includes('cta'))                                 return 'CTA';
  if (id.includes('video') || id.includes('brightcove')) return 'Video';
  if (id.includes('accordion') || id.includes('faq'))    return 'FAQ';
  if (id.includes('story') || id.includes('carousel'))   return 'Cards';
  if (id.includes('quote'))                               return 'Quote';
  return 'Content';
}

const CAT_ORDER = ['Hero','Article','Grid','Content','Video','Cards','CTA','FAQ','Quote','Related'];

function sectionCardHtml(def) {
  const isBundle = Array.isArray(def.sections);
  const badge = isBundle ? `<span class="slc-bundle-badge">${def.sections.length} sections</span>` : '';
  const thumbHtml = def.thumbnailUrl
    ? `<img class="slc-thumb-img" src="${x(def.thumbnailUrl)}" alt="${x(def.title)}" loading="lazy"
         onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
       <div style="display:none">${sectionThumbnailSvg(def)}</div>`
    : sectionThumbnailSvg(def);
  return `<div class="section-lib-card" data-add-section="${x(def.id)}" title="${x(def.description || '')}">
    <div class="slc-thumb">
      ${thumbHtml}
      <span class="slc-add">+</span>
      <button class="slc-preview-btn" data-preview-section="${x(def.id)}" title="Preview layout">👁</button>
    </div>
    <div class="slc-body">
      <div class="slc-title">${x(def.title)}${badge}</div>
      ${def.description ? `<div class="slc-desc">${x(def.description)}</div>` : ''}
    </div>
  </div>`;
}

function sectionBlockTreeHtml(def) {
  function blockHtml(blk, depth) {
    const kids = blk.children || [];
    const pad = depth * 14;
    const col = (blk.props?.style_gridCols || blk.props?.style_customDynamicClass || '').match(/grid-cols-(\d+)/);
    const hint = col ? ` <span class="btr-hint">(${col[1]} col${col[1]>1?'s':''})</span>` : '';
    const row = `<div class="btr-row" style="padding-left:${pad}px">
      <span class="btr-caret">${kids.length ? '▾' : '·'}</span>
      <span class="btr-type">${x(blk.type || '?')}</span>${hint}
    </div>`;
    return row + kids.map(k => blockHtml(k, depth + 1)).join('');
  }
  function secHtml(sec, depth) {
    const blocks = sec.blocks || [];
    const pad = depth * 14;
    const row = `<div class="btr-row" style="padding-left:${pad}px">
      <span class="btr-caret">${blocks.length ? '▾' : '·'}</span>
      <span class="btr-type btr-sec-type">${x(sec.type || 'section')}</span>
    </div>`;
    return row + blocks.map(b => blockHtml(b, depth + 1)).join('');
  }
  if (def.sections) {
    return def.sections.map((sec, i) =>
      `<div class="btr-bundle-sec"><div class="btr-bundle-label">Part ${i + 1}</div>${secHtml(sec, 0)}</div>`
    ).join('');
  }
  const sec = def.section;
  if (!sec) return '<div class="btr-empty">No structure defined</div>';
  return secHtml(sec, 0);
}

function sectionLibHtml() {
  if (!S.sectionsLib.length) {
    return `<div class="palette-scroll"><div class="lib-empty">No predefined sections.<br>Add JSON files to the <code>sections/</code> folder.</div></div>`;
  }
  const q = _slcSearch.toLowerCase().trim();
  const filtered = q
    ? S.sectionsLib.filter(d => d.title.toLowerCase().includes(q) || (d.description||'').toLowerCase().includes(q))
    : S.sectionsLib;

  // Group by category
  const groups = {};
  for (const def of filtered) {
    const cat = sectionCategory(def);
    (groups[cat] = groups[cat] || []).push(def);
  }
  const groupsHtml = CAT_ORDER.filter(c => groups[c]).map(cat => `
    <div class="slc-group">
      <div class="slc-group-header">${cat} <span class="slc-group-count">${groups[cat].length}</span></div>
      <div class="section-lib-grid">${groups[cat].map(sectionCardHtml).join('')}</div>
    </div>`).join('');

  return `<div class="slc-search-wrap">
    <input class="slc-search" id="slc-search" type="text" placeholder="🔍  Search sections…" value="${x(_slcSearch)}"/>
  </div>
  <div class="slc-scroll">
    ${filtered.length ? groupsHtml : '<div class="lib-empty">No sections match.</div>'}
  </div>`;
}

// ── Canvas ────────────────────────────────────────────────────────────────────
function tagEditorHtml(sec) {
  const raw     = sec.props?.style_customDynamicClass || '';
  const classes = raw ? raw.split(',').map(c => c.trim()).filter(Boolean) : [];
  const pills   = classes.map(cls =>
    `<span class="tag-pill">${x(cls)}<button class="tag-remove" data-tag-rem="${x(cls)}" data-tag-sec="${sec.id}" title="Remove">×</button></span>`
  ).join('');
  return `<div class="tag-editor" data-tag-sec="${sec.id}">${pills}<input class="tag-input" data-tag-inp="${sec.id}" placeholder="${classes.length ? '' : '+ CSS class'}" /></div>`;
}

function canvasHtml() {
  const sections = S.sections.map((sec, si) => sectionHtml(sec, si)).join('');
  return `<main class="canvas">
    ${S.sections.length === 0
      ? `<div class="canvas-empty">
          <div class="ce-icon">📐</div>
          <p>Pick a predefined section from the <strong>Sections</strong> tab on the left,<br>or switch to <strong>EDS Blocks</strong> to build manually.</p>
         </div>`
      : sections}
    <div class="canvas-footer">
      <button class="add-section-btn" id="btn-add-section">+ Add Section</button>
      ${S.sections.length > 0
        ? `<button class="save-bundle-btn" id="btn-open-bundle-save">💾 Save as Template</button>`
        : ''}
    </div>
  </main>`;
}

function sectionHtml(sec, si) {
  const isSel    = S.sel?.secId === sec.id && !S.sel?.blkId;
  const isCollapsed = S.collapsed.has(sec.id);
  const name  = sec.props?.name || sec.props?.identifier || '';
  const icon  = COMP_ICONS[sec.type] || '▣';
  const label = S.config?.compMap?.[sec.type]?.title || sec.type;
  const blockCount = sec.blocks.length;

  const blocks = sec.blocks.map((blk, bi) => blockChipHtml(blk, sec, bi)).join('');
  const addBtn = sec.type === 'grid-container'
    ? `<button class="add-block-btn add-col-btn" data-add-col="${sec.id}">+ Add Column</button>`
    : ['section', 'grid-section'].includes(sec.type)
      ? `<button class="add-block-btn" data-pick-block="${sec.id}">+ Add Block</button>`
      : '';

  const collapseChevron = isCollapsed ? '▶' : '▼';
  const blockBadge = blockCount > 0 ? `<span class="sec-block-count">${blockCount}</span>` : '';

  return `<div class="section-card ${isSel ? 'selected' : ''} ${isCollapsed ? 'sec-collapsed' : ''}" data-sec="${sec.id}">
    <div class="section-head" data-sel-sec="${sec.id}">
      <button class="icon-btn sec-toggle" data-toggle-sec="${sec.id}" title="${isCollapsed ? 'Expand' : 'Collapse'}">${collapseChevron}</button>
      <span class="sh-type">${icon} ${x(label)}</span>
      ${name ? `<span class="sh-name">${x(name)}</span>` : ''}
      ${isCollapsed ? blockBadge : ''}
      <div class="section-actions">
        <button class="icon-btn save-tpl" data-save-tpl="${sec.id}" title="Save as template">💾</button>
        ${si > 0 ? `<button class="icon-btn move" data-move-sec="${sec.id}" data-dir="-1" title="Move up">↑</button>` : ''}
        ${si < S.sections.length - 1 ? `<button class="icon-btn move" data-move-sec="${sec.id}" data-dir="1" title="Move down">↓</button>` : ''}
        <button class="icon-btn" data-dup-sec="${sec.id}" title="Duplicate section">⧉</button>
        <button class="icon-btn" data-del-sec="${sec.id}" title="Remove section">×</button>
      </div>
    </div>
    ${tagEditorHtml(sec)}
    <div class="section-body">
      ${blocks}
      ${addBtn}
    </div>
  </div>`;
}

function blockChipHtml(blk, sec, bi) {
  const isSel    = S.sel?.blkId === blk.id && !S.sel?.childId;
  const icon     = COMP_ICONS[blk.type] || '□';
  const label    = S.config?.compMap?.[blk.type]?.title || blk.type;
  const hint     = getPropHint(blk);
  const allowed     = S.config?.filterMap?.[blk.type] || [];
  const isGridSec   = blk.type === 'grid-section';
  const hasChildren = isGridSec || allowed.length > 0;
  const addChildLabel = isGridSec ? '+ Add block' : '+ Add item';

  const childrenHtml = hasChildren ? `
    <div class="block-children">
      ${(blk.children || []).map((ch, ci) => childChipHtml(ch, blk, sec, ci)).join('')}
      <button class="add-child-btn" data-pick-child="${blk.id}" data-sec="${sec.id}">${addChildLabel}</button>
    </div>` : '';

  return `<div>
    <div class="block-chip ${isSel ? 'selected' : ''}" data-sel-blk="${blk.id}" data-sec="${sec.id}">
      <span class="bc-icon">${icon}</span>
      <span class="bc-label">${x(label)}</span>
      ${hint ? `<span class="bc-hint">${x(hint)}</span>` : ''}
      <div class="section-actions" style="margin-left:auto">
        ${bi > 0 ? `<button class="icon-btn move" data-move-blk="${blk.id}" data-sec="${sec.id}" data-dir="-1">↑</button>` : ''}
        ${bi < sec.blocks.length - 1 ? `<button class="icon-btn move" data-move-blk="${blk.id}" data-sec="${sec.id}" data-dir="1">↓</button>` : ''}
        <button class="icon-btn" data-dup-blk="${blk.id}" data-sec="${sec.id}" title="Duplicate block">⧉</button>
        <button class="icon-btn" data-del-blk="${blk.id}" data-sec="${sec.id}">×</button>
      </div>
    </div>
    ${childrenHtml}
  </div>`;
}

function childChipHtml(ch, blk, sec, ci) {
  const isSel = S.sel?.childId === ch.id;
  const label = S.config?.compMap?.[ch.type]?.title || ch.type;
  const hint  = getPropHint(ch);
  const allowedSub = S.config?.filterMap?.[ch.type] || [];
  const subChildrenHtml = allowedSub.length > 0 ? `
    <div class="block-children" style="margin-left:36px">
      ${(ch.children || []).map(sub => {
        const subLabel = S.config?.compMap?.[sub.type]?.title || sub.type;
        const subHint  = getPropHint(sub);
        return `<div class="child-chip" data-sel-child="${sub.id}" data-blk="${ch.id}">
          <span class="cc-label">${x(subLabel)}${subHint ? ` — <em style="font-weight:400;color:var(--muted)">${x(subHint)}</em>` : ''}</span>
          <button class="icon-btn" data-del-child="${sub.id}" data-blk="${ch.id}">×</button>
        </div>`;
      }).join('')}
      <button class="add-child-btn" data-pick-child="${ch.id}" data-sec="${sec.id}">+ Add item</button>
    </div>` : '';
  return `<div>
    <div class="child-chip ${isSel ? 'selected' : ''}" data-sel-child="${ch.id}" data-blk="${blk.id}">
      <span class="cc-label">${x(label)}${hint ? ` — <em style="font-weight:400;color:var(--muted)">${x(hint)}</em>` : ''}</span>
      <button class="icon-btn" data-dup-child="${ch.id}" data-blk="${blk.id}" data-sec="${sec.id}" title="Duplicate">⧉</button>
      <button class="icon-btn" data-del-child="${ch.id}" data-blk="${blk.id}">×</button>
    </div>
    ${subChildrenHtml}
  </div>`;
}

function getPropHint(item) {
  return item.props?.title || item.props?.['jcr:title'] || item.props?.summary || item.props?.linkText || item.props?.name || '';
}

// ── Props panel ───────────────────────────────────────────────────────────────
function propsHtml() {
  if (!S.sel) return `<aside class="props-panel"><div class="props-empty">Select an EDS block to edit its properties.</div></aside>`;

  let item, typeLabel;
  if (S.sel.childId) {
    const blk = findBlk(S.sel.blkId);
    item = blk?.children.find(c => c.id === S.sel.childId);
    typeLabel = S.config?.compMap?.[item?.type]?.title || item?.type;
  } else if (S.sel.blkId) {
    item = findBlk(S.sel.blkId);
    typeLabel = S.config?.compMap?.[item?.type]?.title || item?.type;
  } else {
    item = findSec(S.sel.secId);
    typeLabel = S.config?.compMap?.[item?.type]?.title || item?.type;
  }

  if (!item) return `<aside class="props-panel"><div class="props-empty">Select an EDS block.</div></aside>`;

  const model  = S.config?.modelMap?.[item.type];
  const fields = model?.fields || [];
  const formHtml = renderFields(fields, item.props, item.id);

  return `<aside class="props-panel">
    <div class="props-header">
      <div class="ph-type">${x(typeLabel)}</div>
    </div>
    <div class="props-scroll">
      ${formHtml || `<div class="props-empty">No editable fields for this EDS block.</div>`}
      ${(() => {
        if (!(S.sel.blkId || S.sel.childId) || !S.xmlPool?.length) return '';
        const matching = S.xmlPool
          .map((p, i) => ({ ...p, _idx: i }))
          .filter(p => p.type === item.type);
        if (!matching.length) return '';
        // Build compact prop detail rows: skip internal/style props, show up to 4 meaningful values
        // Build compact detail rows — skip system/JCR props and false/empty values
        const DETAIL_SKIP = new Set(['textIsRich','getAltFromDAM','getCaptionFromDAM',
          'imageIsDecorative','enableWarnOnLeave','displayCaptionBelowImage']);
        function poolItemDetails(pp) {
          const rows = [];
          for (const [k, v] of Object.entries(pp || {})) {
            if (k.startsWith('cq:') || DETAIL_SKIP.has(k)) continue;
            if (v === false || v === '' || v === null || v === undefined) continue;
            const raw = typeof v === 'string' ? v.replace(/<[^>]+>/g, '').trim()
                      : typeof v === 'boolean' ? 'true'
                      : typeof v === 'number'  ? String(v) : '';
            if (!raw) continue;
            rows.push(`<span class="xml-detail-row"><em>${x(k)}</em>${x(raw.slice(0, 70))}</span>`);
            if (rows.length >= 5) break;
          }
          return rows.join('');
        }
        return `<div class="xml-pool-panel">
          <div class="xml-pool-header">From XML — ${matching.length} match${matching.length !== 1 ? 'es' : ''} for <em>${x(item.type)}</em></div>
          ${matching.map((p, mi) => {
            const preview = xmlItemPreview(p);
            const details = poolItemDetails(p.props);
            return `<div class="xml-pool-item">
              <div class="xml-pool-item-top">
                <span class="xml-pool-num">${mi + 1}</span>
                <span class="xml-pool-preview" title="${x(preview)}">${x(preview)}</span>
                <button class="btn btn-ghost btn-xs" data-apply-xml="${item.id}" data-xml-idx="${p._idx}">Use</button>
              </div>
              ${details ? `<div class="xml-pool-item-detail">${details}</div>` : ''}
            </div>`;
          }).join('')}
        </div>`;
      })()}
      ${S.sel.blkId && !S.sel.childId ? (() => {
        const allowedIds = S.config?.filterMap?.[item.type] || [];
        const addItemBtn = allowedIds.length > 0
          ? `<button class="btn btn-ghost btn-sm" style="margin-bottom:8px"
               data-pick-child="${item.id}" data-sec="${S.sel.secId}">+ Add Item</button>`
          : '';
        return `<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">
          ${addItemBtn}
          <button class="btn btn-danger btn-sm" data-del-blk="${item.id}" data-sec="${S.sel.secId}">Remove block</button>
        </div>`;
      })() : ''}
      ${S.sel.childId ? (() => {
        const childAllowed = S.config?.filterMap?.[item?.type] || [];
        const childAddBtn = childAllowed.length > 0
          ? `<button class="btn btn-ghost btn-sm" style="margin-bottom:8px"
               data-pick-child="${item.id}" data-sec="${S.sel.secId}">+ Add Item</button>`
          : '';
        return `<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">
          ${childAddBtn}
          <button class="btn btn-danger btn-sm" data-del-child="${item.id}" data-blk="${S.sel.blkId}">Remove item</button>
        </div>`;
      })() : ''}
    </div>
  </aside>`;
}

function renderFields(fields, props, itemId) {
  let html = '';
  let currentGroup = '';

  for (const f of fields) {
    if (f.component === 'tab') {
      html += `<div class="field-group-title">${x(f.label)}</div>`;
      currentGroup = f.label;
      continue;
    }
    // skip mimetype helpers and container types
    if (f.component === 'custom-asset-namespace:custom-asset-mimetype') continue;
    if (f.component === 'container') continue;

    const val = props?.[f.name] !== undefined ? props[f.name] : (f.value ?? '');
    html += fieldHtml(f, val, itemId);
  }

  // Render props that exist in the imported data but have no matching model field
  const INTERNAL_PROPS = new Set(['jcr:primaryType', 'jcr:createdBy', 'cq:lastModified',
    'cq:lastModifiedBy', 'jcr:created', 'sling:resourceType', 'id', 'filter', 'model']);
  const modelFieldNames = new Set(fields.map(f => f.name));
  const extra = Object.entries(props || {})
    .filter(([k]) => !modelFieldNames.has(k) && !INTERNAL_PROPS.has(k) && !k.startsWith('_'));
  if (extra.length) {
    html += `<div class="unmapped-section">
      <div class="unmapped-header">Unmapped Properties</div>`;
    for (const [k, v] of extra) {
      html += `<div class="field">
        <label title="${x(k)}">${x(k)}</label>
        <input type="text" data-item="${x(itemId)}" data-prop="${x(k)}"
          class="field-input unmapped-prop"
          value="${x(String(v ?? ''))}" placeholder="(no model field)"/>
      </div>`;
    }
    html += `</div>`;
  }

  return html ? `<div class="field-group">${html}</div>` : '';
}

function fieldHtml(f, val, itemId) {
  const label = f.label || f.name;
  const hint  = f.description ? `<div class="hint">${x(f.description)}</div>` : '';
  const attr  = `data-item="${itemId}" data-prop="${f.name}"`;

  switch (f.component) {
    case 'boolean':
      return `<div class="field">
        <div class="checkbox-row">
          <input type="checkbox" id="f_${itemId}_${f.name}" ${attr} ${val ? 'checked' : ''}>
          <label for="f_${itemId}_${f.name}">${x(label)}</label>
        </div>${hint}
      </div>`;

    case 'select':
    case 'radio': {
      const opts = (f.options || []).map(o =>
        `<option value="${x(o.value)}" ${String(val) === String(o.value) ? 'selected' : ''}>${x(o.name || o.value)}</option>`
      ).join('');
      return `<div class="field">
        <label>${x(label)}</label>
        <select ${attr}>${opts}</select>${hint}
      </div>`;
    }

    case 'multiselect': {
      const vals = Array.isArray(val) ? val : (val ? [val] : []);
      const opts = (f.options || []).map(o =>
        `<option value="${x(o.value)}" ${vals.includes(o.value) ? 'selected' : ''}>${x(o.name || o.value)}</option>`
      ).join('');
      return `<div class="field">
        <label>${x(label)}</label>
        <select multiple ${attr} style="min-height:70px">${opts}</select>${hint}
      </div>`;
    }

    case 'number':
      return `<div class="field">
        <label>${x(label)}</label>
        <input type="number" ${attr} value="${x(String(val))}"/>${hint}
      </div>`;

    case 'richtext':
    case 'multiline-input':
      return `<div class="field">
        <label>${x(label)}</label>
        <textarea ${attr}>${x(String(val))}</textarea>${hint}
      </div>`;

    case 'aem-content':
    case 'aem-tag':
    case 'reference':
    case 'custom-asset-namespace:custom-asset':
      return `<div class="field">
        <label>${x(label)}</label>
        <input type="text" ${attr} value="${x(String(val))}" placeholder="/content/…"/>${hint}
      </div>`;

    case 'ngaem:dynamic-picklist': {
      const styleGroups = _blockStyleConfigs?.[f.sourceAEMNodeName] || null;
      if (!styleGroups?.length) {
        return `<div class="field">
          <label>${x(label)}</label>
          <input type="text" ${attr} value="${x(String(val))}" placeholder="CSS class name"/>${hint}
        </div>`;
      }
      const currentClasses = new Set((val || '').split(',').map(s => s.trim()).filter(Boolean));
      const groupWidgets = styleGroups.map(g => {
        if (g.multiSelect) {
          const checks = g.options.map(opt => `<label class="style-check-label"><input type="checkbox" class="style-cb" data-style-item="${itemId}" data-style-prop="${x(f.name)}" value="${x(opt.cssClass)}" ${currentClasses.has(opt.cssClass) ? 'checked' : ''}> ${x(opt.label)}</label>`).join('');
          return `<div class="style-group-row"><span class="style-group-label">${x(g.group)}</span><div class="style-checks">${checks}</div></div>`;
        } else {
          const sel = g.options.find(o => currentClasses.has(o.cssClass))?.cssClass || '';
          const opts = [`<option value="">—</option>`, ...g.options.map(o => `<option value="${x(o.cssClass)}" ${sel === o.cssClass ? 'selected' : ''}>${x(o.label)}</option>`)].join('');
          return `<div class="style-group-row"><span class="style-group-label">${x(g.group)}</span><select class="field-input style-group-select" data-style-item="${itemId}" data-style-prop="${x(f.name)}">${opts}</select></div>`;
        }
      }).join('');
      return `<div class="field"><label>${x(label)}</label><div class="style-groups-wrapper">${groupWidgets}</div>${hint}</div>`;
    }

    default:
      return `<div class="field">
        <label>${x(label)}</label>
        <input type="text" ${attr} value="${x(String(val))}"/>${hint}
      </div>`;
  }
}

// ── Help view ─────────────────────────────────────────────────────────────────
function helpViewHtml() {
  const sections = [
    {
      id: 'canvas',
      icon: '🖼',
      title: 'Canvas',
      summary: 'The main page builder. Drag sections onto the canvas, edit block properties, and preview the page structure before publishing.',
      items: [
        { term: 'Palette – EDS Blocks', def: 'Lists every available EDS block type. Click any EDS block to add it to the canvas. Use the search box to filter by name.' },
        { term: 'Palette – Sections', def: 'Pre-built section templates saved by you or your team. Hover a card to preview its structure; click + to add it to the canvas. You can also open the preview panel and click "Add to Canvas" from there.' },
        { term: 'Section card', def: 'A collapsible row on the canvas representing one page section. The header shows the section type, a block-count badge, and move/delete controls.' },
        { term: 'CSS class tags', def: 'Inline tag editor on every section card. Type a class name and press Enter (or comma) to add it; click ✕ on a tag to remove it. These map to the EDS style system.' },
        { term: 'Block chip', def: 'A nested row inside a section. Shows the block type, icon, and a hint of its main property value. Click to select it and open the Properties panel on the right.' },
        { term: 'Move up / down', def: 'Arrow buttons on sections and blocks reorder them within the canvas. Only appears when there is more than one item.' },
        { term: '+ Add Section', def: 'Footer button that opens the block picker filtered to section-level components.' },
        { term: '+ Add Block / + Add Item', def: 'Adds a child block (or accordion item, list item, etc.) to the selected parent.' },
        { term: 'Save as Template', def: 'Saves one or more canvas sections as a reusable template. When saving multiple sections, a bundle dialog lets you choose which ones to include.' },
        { term: 'Properties panel', def: 'Right-hand panel that appears when a block or child is selected. Fields are driven by the component model definition. Changes apply instantly — no Save button needed.' },
        { term: '▶ Create Page', def: 'Publishes the canvas to AEM via the configured connection. On success, an overlay shows the new page path and an "Open in Universal Editor" link.' },
      ],
    },
    {
      id: 'settings-connection',
      icon: '🔌',
      title: 'Settings → Connection',
      summary: 'Configure your AEM author environment and set the target page for publishing.',
      items: [
        { term: 'AEM Author Host', def: 'Base URL of your AEM author instance, e.g. https://author-p12345-e67890.adobeaemcloud.com' },
        { term: 'Username / Password', def: 'AEM author credentials. Stored in browser localStorage only — never sent to a third party.' },
        { term: 'Parent Path', def: 'The JCR path where the new page will be created, e.g. /content/my-site/en/news' },
        { term: 'UE Organisation', def: 'Your Adobe IMS organisation ID used when building the Universal Editor link after page creation.' },
        { term: 'New Page Name / Slug', def: 'The last segment of the page URL. Appears as a badge in the topbar once set.' },
        { term: 'Test Connection', def: 'Sends a lightweight health-check request to AEM to verify the credentials and host are correct.' },
        { term: 'Load Page', def: 'Fetches an existing AEM page by path and reconstructs it on the canvas. Warns you if the canvas already has unsaved sections.' },
        { term: 'Diagnose', def: 'Fetches the same page and dumps the raw JSON structure so you can debug mapping issues.' },
        { term: 'Fill from AEM Sites XML', def: 'Upload a .content.xml file exported from CRX Package Manager. The tool matches XML components to canvas blocks by type and fills in their property values. Useful after an initial migration sweep.' },
        { term: 'Page Metadata', def: 'Editable fields for standard AEM page properties (jcr:title, navTitle, cardTitle, etc.). Saved with the page on Create.' },
      ],
    },
    {
      id: 'settings-mappings',
      icon: '🗺',
      title: 'Settings → Mappings',
      summary: 'Define how AEM resource types translate to EDS block types and which properties get renamed during migration.',
      items: [
        { term: 'Migration Map table', def: 'Lists every AEM sling:resourceType and its target EDS block type. Change the dropdown to remap a type; set it to "skip" to ignore that component entirely.' },
        { term: 'Property renames', def: 'Expand a row (▼ props) to see how AEM property names map to EDS property names. Add, edit, or delete rename rules inline.' },
        { term: 'Save Mappings', def: 'Writes all changes back to migration-map.json on the server. This file drives both the canvas importer and the JCR XML filler.' },
        { term: 'Mapping Analyzer', def: 'Scans paired AEM + EDS pages already in the codebase, infers which AEM properties correspond to which EDS properties, and surfaces suggestions.' },
        { term: 'Suggestions table', def: 'Each row is a candidate mapping showing the resource type, inferred EDS type, property renames, status (NEW / existing), and how many pages were sampled. Low-confidence rows are highlighted.' },
        { term: 'Apply selected', def: 'Merges the checked suggestions into migration-map.json. Only NEW mappings are pre-checked; existing ones are opt-in so you don\'t accidentally overwrite manual edits.' },
      ],
    },
    {
      id: 'settings-paths',
      icon: '🔀',
      title: 'Settings → Paths',
      summary: 'Rewrite AEM content paths and DAM asset URLs to their EDS equivalents during migration.',
      items: [
        { term: 'Content Path Rules', def: 'Each rule has an AEM prefix and an EDS prefix. When a migrated page link starts with the AEM prefix it is rewritten to the EDS prefix. First matching rule wins.' },
        { term: 'DAM Path Rules', def: 'Same as content rules but applied specifically to /content/dam/ asset paths (images, PDFs, etc.).' },
        { term: 'Asset Mappings (DM Open API)', def: 'Import a CSV exported from AEM Assets with columns: path, uuid, scene7Name, scene7File, damStatus, openApiUrl. Any asset with an openApiUrl gets that URL injected directly — taking priority over DAM path rules.' },
        { term: 'Import CSV', def: 'Uploads the asset CSV to the server and reports how many assets were loaded and how many have a DM Open API URL.' },
        { term: 'Clear all', def: 'Removes all asset mappings from memory and disk (with confirmation). Path prefix rules are not affected.' },
        { term: 'Save Path Rules', def: 'Persists the content and DAM prefix rules to disk. Asset mappings are saved automatically on import.' },
      ],
    },
    {
      id: 'settings-styles',
      icon: '🎨',
      title: 'Settings → Styles',
      summary: 'Map AEM Style System IDs to EDS CSS class names so styles transfer automatically during migration.',
      items: [
        { term: 'AEM Conf path', def: 'Absolute path to the AEM /conf policies .content.xml file on your local machine (usually inside ui.content/src/main/content/jcr_root/conf/…/policies).' },
        { term: '▶ Build Style Map', def: 'Parses the conf XML to extract every cq:styleId, then tries to auto-match each one to an EDS class name by comparing AEM CSS class names and style labels. Results are saved to style-map.json.' },
        { term: 'Auto-mapping confidence', def: 'A direct CSS class name match earns 90% confidence (e.g. AEM class light-theme → EDS class light-theme). A label-similarity match earns 65%. Rows with no match are highlighted yellow for manual input.' },
        { term: 'Style mapping table', def: 'Shows all discovered AEM styles grouped by style group. The EDS Class column is editable — type the correct EDS class name for any unmapped row.' },
        { term: 'Save Changes', def: 'Posts your manual edits to the server. Manually-saved entries are preserved across rebuilds; only auto-mapped entries are recomputed when you rebuild.' },
        { term: 'How it applies', def: 'During JCR XML migration, any cq:styleIds attribute on an AEM component is looked up in style-map.json. Matched EDS classes are written to the classes_customDynamicClass property of the migrated block.' },
      ],
    },
    {
      id: 'settings-thumbnails',
      icon: '🖼',
      title: 'Settings → Thumbnails',
      summary: 'Manage section preview images shown in the Sections palette. Three capture methods are available.',
      items: [
        { term: 'Auto-generate from AEM', def: 'Creates a temporary AEM test page containing one instance of every section type, then screenshots each section using Puppeteer. Fastest way to bulk-populate thumbnails.' },
        { term: 'Folder name', def: 'The AEM page name used for the auto-generated test page (default: section-samples). Change it if that name conflicts with an existing page.' },
        { term: 'Overwrite existing', def: 'When checked, regenerates thumbnails even for sections that already have one. Useful after design changes.' },
        { term: 'Capture from EDS URL', def: 'Points Puppeteer at a live EDS page URL and screenshots each section element matching the CSS selector. Good when the rendered EDS output is the best reference.' },
        { term: 'Thumbnails grid', def: 'Shows all sections with their current thumbnail (or an auto-generated SVG placeholder). Use ↺ to regenerate a single thumbnail from AEM, 📷 to upload a screenshot manually, or ✕ to delete.' },
        { term: 'Palette order', def: 'Expandable list showing the order sections appear in the palette. Copy it to build a representative test page manually.' },
      ],
    },
    {
      id: 'migration',
      icon: '📦',
      title: 'JCR XML Migration (Fill from XML)',
      summary: 'Automatically extract block properties from an AEM content package XML and apply them to the canvas.',
      items: [
        { term: 'What is JCR XML?', def: 'When you export an AEM page using CRX Package Manager, the result includes a .content.xml file. This file contains every component on the page with all its properties in XML attribute form.' },
        { term: 'Fill from AEM Sites XML', def: 'Upload a .content.xml file in Settings → Connection. The server walks the XML tree, identifies each AEM component by sling:resourceType, looks it up in migration-map.json, renames properties, applies style mappings, and writes the result to matching canvas blocks.' },
        { term: 'Block matching', def: 'The filler matches XML components to canvas blocks by EDS type (first match per type). If your canvas has multiple instances of the same block type, re-run after adjusting the canvas order.' },
        { term: 'skipProps', def: 'Properties listed in migration-map.json skipProps are silently discarded (e.g. jcr:created, cq:lastModified, internal AEM system props).' },
        { term: 'propRenames', def: 'Properties listed in propRenames are remapped to the EDS property name. Everything else is passed through as-is.' },
        { term: 'invertBoolProps', def: 'Boolean AEM properties listed here are flipped (true → false, false → true) before being written to the canvas. Useful when AEM and EDS use opposite conventions (e.g. singleExpansion → allowMultipleOpen).' },
        { term: 'propEdsType', def: 'A property whose value selects a different EDS block type. Example: videoType=youtube resolves to the video block instead of brightcove-video.' },
        { term: 'childType / childPropRenames', def: 'For composite components like accordions, child XML nodes are absorbed as typed sub-items with their own property renames rather than emitted as top-level blocks.' },
        { term: 'countChildrenAsProp', def: 'Counts XML child component nodes and stores the count as a prop. Used by carousel to set totalSlides so EDS knows how many sibling blocks are slides.' },
        { term: 'Fill results banner', def: 'After a fill, a green banner reports how many blocks were filled and how many were skipped (no matching XML type). Skipped blocks usually mean the migration-map.json needs a new entry for that resource type.' },
      ],
    },
  ];

  return `<div class="help-view">
    <div class="help-sidebar">
      <p class="help-sidebar-title">Contents</p>
      <ul class="help-toc">
        ${sections.map(s => `<li><a class="help-toc-link" href="#help-${s.id}">${s.icon} ${s.title}</a></li>`).join('\n        ')}
      </ul>
    </div>
    <div class="help-content">
      <div class="help-header">
        <h1 class="help-title">AEM Page Builder — Help</h1>
        <p class="help-subtitle">Reference guide for every feature in the app.</p>
      </div>
      ${sections.map(s => `
      <section class="help-section" id="help-${s.id}">
        <h2 class="help-section-title">${s.icon} ${s.title}</h2>
        <p class="help-section-summary">${s.summary}</p>
        <dl class="help-dl">
          ${s.items.map(i => `<div class="help-dl-row">
            <dt class="help-dt">${x(i.term)}</dt>
            <dd class="help-dd">${x(i.def)}</dd>
          </div>`).join('\n          ')}
        </dl>
      </section>`).join('\n')}
    </div>
  </div>`;
}

// ── Settings view (full-panel) ────────────────────────────────────────────────
function settingsViewHtml() {
  return `<div class="settings-view">
    <div class="sv-tabs">
      <button class="sv-tab ${_settingsTab === 'connection' ? 'sv-tab-active' : ''}" id="stab-settings">Connection</button>
      <button class="sv-tab ${_settingsTab === 'mappings'   ? 'sv-tab-active' : ''}" id="stab-mappings">Mappings</button>
      <button class="sv-tab ${_settingsTab === 'paths'      ? 'sv-tab-active' : ''}" id="stab-paths">Paths</button>
      <button class="sv-tab ${_settingsTab === 'styles'     ? 'sv-tab-active' : ''}" id="stab-styles">Styles</button>
      <button class="sv-tab ${_settingsTab === 'thumbs'     ? 'sv-tab-active' : ''}" id="stab-thumbs">Thumbnails</button>
      <button class="sv-tab ${_settingsTab === 'bulk'       ? 'sv-tab-active' : ''}" id="stab-bulk">Bulk Import</button>
      <button class="sv-tab ${_settingsTab === 'similar'    ? 'sv-tab-active' : ''}" id="stab-similar">Find Similar</button>
      <button class="sv-tab ${_settingsTab === 'migsite'    ? 'sv-tab-active' : ''}" id="stab-migsite">Migrate Full Site</button>
    </div>
    <div class="sv-body">
      ${_settingsTab === 'connection' ? connectionTabHtml()
      : _settingsTab === 'mappings'  ? mappingTabHtml()
      : _settingsTab === 'paths'     ? pathsTabHtml()
      : _settingsTab === 'styles'    ? stylesTabHtml()
      : _settingsTab === 'bulk'      ? bulkTabHtml()
      : _settingsTab === 'similar'   ? findSimilarTabHtml()
      : _settingsTab === 'migsite'   ? migrateSiteTabHtml()
      :                                thumbnailsTabHtml()}
    </div>
  </div>`;
}

function connectionTabHtml() {
  const { aemHost, username, password, parentPath, pageName } = S.conn;
  return `<div class="conn-grid">
    <div class="conn-card">
      <div class="sv-section-title">AEM Connection</div>
      <div id="conn-alert"></div>
      <div class="settings-field">
        <label>AEM Author Host</label>
        <input id="s-host" type="text" value="${x(aemHost)}" placeholder="https://author-p12345-e67890.adobeaemcloud.com"/>
      </div>
      <div class="settings-row">
        <div class="settings-field">
          <label>Username</label>
          <input id="s-user" type="text" value="${x(username)}" placeholder="admin"/>
        </div>
        <div class="settings-field">
          <label>Password</label>
          <input id="s-pass" type="password" value="${x(password)}" placeholder="admin"/>
        </div>
      </div>
      <div class="settings-field">
        <label>Parent Path</label>
        <input id="s-parent" type="text" value="${x(parentPath)}" placeholder="/content/my-site/en/section"/>
      </div>
      <div class="settings-field">
        <label>UE Organisation</label>
        <input id="s-ueorg" type="text" value="${x(S.conn.ueOrg)}" placeholder="abbviecommercial"/>
      </div>
      <div class="settings-field">
        <label>New Page Name (slug)</label>
        <input id="s-name" type="text" value="${x(pageName)}" placeholder="my-new-page"/>
      </div>
      <div class="sv-card-footer">
        <button class="btn btn-ghost btn-sm" id="btn-test-conn">Test Connection</button>
        <button class="btn btn-primary btn-sm" id="btn-save-settings">Save</button>
      </div>
    </div>
    <div class="conn-card">
      <div class="sv-section-title">Import Existing Page</div>
      <div class="settings-field" style="margin-bottom:4px">
        <label>Page Path <span style="font-weight:400;color:var(--muted)">(replaces current canvas)</span></label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="s-import-path" type="text" style="flex:1" placeholder="/content/abbvie-nextgen-eds/…/my-page"/>
          <button class="btn btn-ghost btn-sm" id="btn-import-page" style="white-space:nowrap">⬇ Load</button>
          <button class="btn btn-ghost btn-sm" id="btn-diagnose-page" style="white-space:nowrap;color:var(--muted)">🔍 Diagnose</button>
        </div>
      </div>
      <div id="import-alert"></div>
      <div id="diagnose-out" style="display:none;margin-top:8px;background:#f8f9fa;border:1px solid var(--border);border-radius:4px;padding:10px;font-size:11px;font-family:monospace;white-space:pre-wrap;max-height:200px;overflow-y:auto;color:#1a1a2e;"></div>
      <div class="sv-section-title" style="margin-top:16px">Fill from AEM Sites XML</div>
      <div style="font-size:.75rem;color:var(--muted);margin-bottom:10px">Build your canvas structure first, then upload a JCR XML from CRX Package Manager. Props fill into matching blocks by type.</div>
      <div class="settings-field" style="margin-bottom:4px">
        <label>JCR XML file</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="s-migrate-file" type="file" accept=".xml" style="flex:1;font-size:.8rem"/>
          <button class="btn btn-sm" id="btn-fill-xml" style="white-space:nowrap;background:#0d9488;color:#fff;border-color:#0d9488">⬆ Fill</button>
        </div>
      </div>
      <div id="migrate-alert"></div>
    </div>
  </div>
  ${metaFieldsHtml()}`;
}

function metaFieldsHtml() {
  const model  = S.config?.modelMap?.['page-metadata'];
  if (!model) return '';
  const fields = model.fields.filter(f => f.component !== 'tab' && f.component !== 'container' && f.component !== 'aem-tag' && f.component !== 'custom-asset-namespace:custom-asset' && f.component !== 'custom-asset-namespace:custom-asset-mimetype');
  const SHOW = ['jcr:title','navTitle','eyebrowText','pageSubtitle','cardTitle','cardDescription','ctaText','publicationDate'];
  const shown = fields.filter(f => SHOW.includes(f.name));
  if (!shown.length) return '';
  return `<hr style="margin:14px 0;border-color:var(--border)"/>
    <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--brand);margin-bottom:10px">Page Metadata</div>
    ${shown.map(f => {
      const val = S.meta[f.name] !== undefined ? S.meta[f.name] : (f.value ?? '');
      return `<div class="settings-field">
        <label>${x(f.label || f.name)}</label>
        <input type="text" data-meta="${f.name}" value="${x(String(val))}" placeholder="${x(f.description || '')}"/>
      </div>`;
    }).join('')}`;
}

// ── Mapping tab ───────────────────────────────────────────────────────────────
function gapSectionHtml(rt, edsType) {
  if (!edsType) return `<div class="gap-no-type">Select an EDS type above to analyze mapping gaps.</div>`;
  const gap = _gapData[rt];
  if (!gap) return `<div class="gap-loading">
    <span style="color:var(--muted);font-size:.75rem">Loading gap analysis…</span>
  </div>`;

  let html = `<div class="gap-wrap">
    <div class="gap-title">Mapping gap analysis
      <button class="btn btn-ghost btn-sm gap-refresh" data-rt="${x(rt)}" style="font-size:.7rem;padding:1px 6px;margin-left:6px">↺ Refresh</button>
    </div>`;

  if (gap.suggestions?.length) {
    html += `<div class="gap-section gap-section--suggest">
      <div class="gap-section-label">Suggested renames</div>`;
    for (const s of gap.suggestions) {
      const conf = s.score >= 90 ? 'high' : s.score >= 60 ? 'med' : 'low';
      html += `<div class="gap-row">
        <span class="gap-aem-prop">${x(s.aemProp)}</span>
        <span class="gap-arr">→</span>
        <span class="gap-eds-prop">${x(s.edsField)}</span>
        <span class="gap-score gap-score--${conf}">${s.score}%</span>
        <button class="btn btn-ghost btn-sm gap-accept"
          data-rt="${x(rt)}" data-aem="${x(s.aemProp)}" data-eds="${x(s.edsField)}">Accept</button>
      </div>`;
    }
    html += `</div>`;
  }

  if (gap.unmappedAem?.length) {
    html += `<div class="gap-section gap-section--aem">
      <div class="gap-section-label">AEM props without EDS match</div>`;
    for (const p of gap.unmappedAem) {
      html += `<div class="gap-row"><span class="gap-aem-prop">${x(p)}</span>
        <span class="gap-no-match">no EDS field</span></div>`;
    }
    html += `</div>`;
  }

  if (gap.unmappedEds?.length) {
    html += `<div class="gap-section gap-section--eds">
      <div class="gap-section-label">EDS fields with no AEM source</div>`;
    for (const f of gap.unmappedEds) {
      html += `<div class="gap-row"><span class="gap-eds-prop">${x(f.name)}</span>
        <span class="gap-label">${x(f.label)}</span>
        <span class="gap-component">${x(f.component)}</span></div>`;
    }
    html += `</div>`;
  }

  if (!gap.suggestions?.length && !gap.unmappedAem?.length && !gap.unmappedEds?.length) {
    html += `<div style="font-size:.75rem;color:var(--muted);padding:4px 0">All properties accounted for ✓</div>`;
  }

  html += `</div>`;
  return html;
}

function mappingTabHtml() {
  const cmap = S.migrationMap?.componentMap || {};
  const allBlockIds = Object.keys(S.config?.compMap || {}).sort();

  const rows = Object.entries(cmap).map(([rt, mapping]) => {
    const short = rt.split('/').pop();
    const edsType = mapping.edsType || '';
    const renames = mapping.propRenames || {};
    const isExp = _mappingExpanded === rt;

    const renameRows = Object.entries(renames).map(([src, dst]) => `
      <div class="mr-rename">
        <input class="mr-src-inp" value="${x(src)}" data-rt="${x(rt)}" data-oldsrc="${x(src)}" placeholder="AEM prop"/>
        <span class="mr-arr">→</span>
        <input class="mr-dst-inp" value="${x(dst)}" data-rt="${x(rt)}" data-src="${x(src)}" placeholder="EDS prop"/>
        <button class="icon-btn mr-del-rename" data-rt="${x(rt)}" data-src="${x(src)}">×</button>
      </div>`).join('');

    const typeOpts = `<option value="">— skip —</option>` +
      allBlockIds.map(id => `<option value="${x(id)}" ${id === edsType ? 'selected' : ''}>${x(id)}</option>`).join('');

    return `<div class="mapping-row">
      <div class="mr-header">
        <div class="mr-names">
          <span class="mr-short">${x(short)}</span>
          <span class="mr-full">${x(rt)}</span>
        </div>
        <span class="mr-chevron">→</span>
        <select class="sm-select mr-type-sel" data-rt="${x(rt)}">${typeOpts}</select>
        <button class="icon-btn mr-expand-btn" data-expand-rt="${x(rt)}">${isExp ? '▲' : '▼'} props</button>
      </div>
      ${isExp ? `<div class="mr-body">
        <div class="mr-renames">${renameRows}</div>
        <button class="btn btn-ghost btn-sm mr-add-rename" data-rt="${x(rt)}" style="margin-top:4px;font-size:.72rem">+ Add rename</button>
        ${gapSectionHtml(rt, edsType)}
      </div>` : ''}
    </div>`;
  }).join('');

  const analyzerHtml = mappingAnalysisHtml();

  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
    <span style="font-size:.75rem;color:var(--muted)">${Object.keys(cmap).length} component mappings</span>
    <button class="btn btn-primary btn-sm" id="btn-save-mapping">Save Mappings</button>
  </div>
  <div class="mapping-list">${rows || '<div class="props-empty" style="padding:20px;text-align:center">No migration map loaded.</div>'}</div>
  ${analyzerHtml}`;
}

// ── Mapping Analyzer ──────────────────────────────────────────────────────────
function mappingAnalysisHtml() {
  const data = S._mappingAnalysis;
  const statusHtml = S._mappingAnalysisStatus
    ? `<span style="font-size:.75rem;color:var(--muted);margin-left:8px">${x(S._mappingAnalysisStatus)}</span>` : '';

  let statusLine = '';
  if (data) {
    statusLine = `<span class="ma-status-pill">${data.aemTypes || 0} AEM types</span>
      <span class="ma-status-pill">${data.edsTypes || 0} EDS types</span>
      <span class="ma-status-pill ma-pill-paired">${data.pairedCount} paired pages</span>`;
  }

  let tableHtml = '';
  if (data?.suggestions?.length) {
    const newCount     = data.suggestions.filter(s => s.status === 'new').length;
    const conflictCount = data.suggestions.filter(s => s.status === 'conflict').length;
    const checkedCount  = data.suggestions.filter(s => s._selected !== false && s.status !== 'existing').length
                        + data.suggestions.filter(s => s._selected === true).length;

    const rows = data.suggestions.map((s, idx) => {
      const shortRt = s.rt.split('/').slice(-3).join('/');
      const renameCount = Object.keys(s.propRenames || {}).length;
      // Pre-select NEW mappings with actual propRenames; others require explicit opt-in
      const hasRenames = Object.keys(s.propRenames || {}).length > 0;
      const checked = s._selected === true || (s._selected !== false && s.status === 'new' && hasRenames);
      const instanceNote = s.aemInstances ? `<span style="font-size:.65rem;color:var(--muted);margin-left:3px">(${s.aemInstances}×)</span>` : '';
      const statusBadge =
        s.status === 'new'      ? `<span class="ma-badge ma-badge-new">NEW</span>` :
        s.status === 'no-data'  ? `<span class="ma-badge" style="background:#f3f4f6;color:var(--muted)">no data</span>` :
                                  `<span class="ma-badge ma-badge-ok">existing ✓</span>`;
      const isExpanded = S._mappingAnalysisExpanded === idx;
      const expandedRows = isExpanded ? Object.entries(s.propRenames || {}).map(([ak, ek]) =>
        `<tr class="ma-prop-row"><td colspan="2" style="padding:2px 8px 2px 28px;font-size:.72rem;color:var(--muted)">${x(ak)} → ${x(ek)} <span style="opacity:.6">(${s.propConfs?.[ak] || '?'}%)</span></td><td></td><td></td><td></td></tr>`
      ).join('') : '';

      const lowConf = s.edsTypeConf < 50;
      return `<tr class="ma-row ma-row--${s.status}${lowConf ? ' ma-row--lowconf' : ''}" data-ma-idx="${idx}">
        <td><input type="checkbox" class="ma-chk" data-ma-idx="${idx}" ${checked ? 'checked' : ''}></td>
        <td class="ma-rt" title="${x(s.rt)}">${x(shortRt)}${instanceNote}</td>
        <td>${x(s.edsType)}</td>
        <td>${renameCount ? `${renameCount} rename${renameCount !== 1 ? 's' : ''}` : '<span style="opacity:.4">none</span>'}
          ${renameCount ? `<button class="ma-expand-btn" data-ma-expand="${idx}">${isExpanded ? '▲' : '▼'}</button>` : ''}</td>
        <td>${statusBadge}</td>
      </tr>${expandedRows}`;
    }).join('');

    const applyCount = data.suggestions.filter(s =>
      s._selected === true || (s._selected !== false && s.status === 'new' && Object.keys(s.propRenames||{}).length > 0)
    ).length;

    tableHtml = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-size:.75rem;color:var(--muted)">
          ${newCount ? `<span class="ma-badge ma-badge-new">${newCount} new</span> ` : ''}
          ${conflictCount ? `<span class="ma-badge ma-badge-conflict">${conflictCount} conflicts</span> ` : ''}
          ${data.suggestions.length - newCount - conflictCount} existing
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <label style="font-size:.75rem;cursor:pointer"><input type="checkbox" id="ma-chk-all" style="margin-right:4px"> Select all</label>
          <button class="btn btn-primary btn-sm" id="btn-apply-analysis" ${applyCount === 0 ? 'disabled' : ''}>Apply selected (${applyCount})</button>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table class="ma-table">
          <thead><tr>
            <th style="width:28px"></th>
            <th>AEM Resource Type</th>
            <th>→ EDS Type</th>
            <th>PropRenames</th>
            <th>Status</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } else if (data) {
    tableHtml = `<div style="padding:12px;font-size:.8rem;color:var(--muted)">No component suggestions found. Check that paired pages contain components with matching property values.</div>`;
  }

  return `<div class="ma-section">
    <div class="ma-header">
      <span class="sv-section-title" style="margin:0">Mapping Analyzer</span>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${statusLine}
        <button class="btn btn-ghost btn-sm" id="btn-run-analysis">${data ? '↻ Re-run' : 'Run Analysis'}</button>
        ${statusHtml}
      </div>
    </div>
    <div style="font-size:.74rem;color:var(--muted);margin-bottom:8px">
      Analyzes <code>content-xml/</code> and <code>eds-jcr-xml/</code> paired pages to suggest propRename mappings.
    </div>
    ${tableHtml}
  </div>`;
}

async function runMappingAnalysis() {
  S._mappingAnalysisStatus = 'Analyzing…';
  render();
  try {
    const res  = await fetch('/api/analyze-mappings');
    const data = await res.json();
    if (!res.ok) { S._mappingAnalysisStatus = data.error || 'Error'; render(); return; }
    S._mappingAnalysis = data;
    S._mappingAnalysisStatus = null;
    render();
  } catch (err) {
    S._mappingAnalysisStatus = err.message;
    render();
  }
}

async function applyMappingAnalysis() {
  const data = S._mappingAnalysis;
  if (!data) return;
  const accepted = data.suggestions
    .filter(s => s._selected === true || (s._selected !== false && s.status === 'new'))
    .map(({ rt, edsType, propRenames }) => ({ rt, edsType, propRenames }));
  if (!accepted.length) return;
  try {
    const res = await fetch('/api/apply-mapping-analysis', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accepted })
    });
    const data2 = await res.json();
    if (!res.ok) { alert(data2.error || 'Failed to apply'); return; }
    const mm = await fetch('/api/migration-map').then(r => r.json());
    S.migrationMap = mm;
    S._mappingAnalysis = null;
    S._mappingAnalysisStatus = `Applied ${data2.applied} mapping${data2.applied !== 1 ? 's' : ''}`;
    render();
  } catch (err) { alert(err.message); }
}

// ── Paths tab ─────────────────────────────────────────────────────────────────
function pathsTabHtml() {
  const pm = S.pathMap || { contentPrefixRules: [], damPrefixRules: [], assetMap: [] };
  const ruleRows = (rules, section) => rules.map((r, i) => `
    <tr>
      <td><input class="pm-aem-inp" data-section="${section}" data-idx="${i}" value="${x(r.aemPrefix || '')}" placeholder="/content/abbvie-com2/us/en"/></td>
      <td><input class="pm-eds-inp" data-section="${section}" data-idx="${i}" value="${x(r.edsPrefix || '')}" placeholder="/us/en"/></td>
      <td style="width:32px;text-align:center"><button class="icon-btn pm-del-rule" data-section="${section}" data-idx="${i}" title="Remove">×</button></td>
    </tr>`).join('');

  return `<div class="paths-tab">
    <div class="sv-section-title">Content Path Rules</div>
    <div style="font-size:.74rem;color:var(--muted);margin-bottom:8px">Rewrite page/link paths that start with the AEM prefix. First match wins.</div>
    <table class="pm-table">
      <thead><tr><th>AEM prefix</th><th>EDS prefix</th><th></th></tr></thead>
      <tbody id="pm-content-rows">${ruleRows(pm.contentPrefixRules || [], 'contentPrefixRules')}</tbody>
    </table>
    <button class="btn btn-ghost btn-sm" id="btn-add-content-rule" style="margin-top:4px">+ Add rule</button>

    <div class="sv-section-title" style="margin-top:20px">DAM Path Rules</div>
    <div style="font-size:.74rem;color:var(--muted);margin-bottom:8px">Rewrite asset paths under <code>/content/dam/</code>. DM Open API URLs in the asset map take priority over these rules.</div>
    <table class="pm-table">
      <thead><tr><th>AEM prefix</th><th>EDS prefix</th><th></th></tr></thead>
      <tbody id="pm-dam-rows">${ruleRows(pm.damPrefixRules || [], 'damPrefixRules')}</tbody>
    </table>
    <button class="btn btn-ghost btn-sm" id="btn-add-dam-rule" style="margin-top:4px">+ Add rule</button>

    <div class="sv-section-title" style="margin-top:20px">Asset Mappings (DM Open API)</div>
    <div style="font-size:.74rem;color:var(--muted);margin-bottom:8px">
      Import your asset-map CSV (<code>path, uuid, scene7Name, scene7File, damStatus, openApiUrl</code>).
      Assets with a real <code>https://</code> Open API URL use it; others fall back to the updated DAM path.
      ${Object.keys(pm.assetMap || {}).length
        ? `<strong>${Object.keys(pm.assetMap).length} asset${Object.keys(pm.assetMap).length !== 1 ? 's' : ''} loaded.</strong>`
        : 'No assets loaded yet.'}
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <input id="pm-csv-file" type="file" accept=".csv,.txt" style="font-size:.8rem;flex:1;min-width:0"/>
      <button class="btn btn-ghost btn-sm" id="btn-import-csv" style="white-space:nowrap">⬆ Import CSV</button>
      ${Object.keys(pm.assetMap || {}).length ? `<button class="btn btn-ghost btn-sm" id="btn-clear-asset-map" style="color:var(--danger);white-space:nowrap">Clear all</button>` : ''}
    </div>
    <div id="pm-csv-alert" style="margin-top:6px"></div>

    <div style="margin-top:20px;display:flex;align-items:center;gap:10px">
      <button class="btn btn-primary btn-sm" id="btn-save-paths">Save Path Rules</button>
      <div id="pm-save-alert" style="font-size:.8rem"></div>
    </div>
  </div>`;
}

// ── Styles settings tab ───────────────────────────────────────────────────────
function bulkTabHtml() {
  const tpl = S.bulkTemplate;
  const tplInfo = tpl
    ? `${tpl.length} section${tpl.length !== 1 ? 's' : ''}, ${tpl.reduce((n,s)=>(n+(s.blocks||[]).length),0)} blocks`
    : 'None set';

  const rowsHtml = S.bulkPages.length ? `
    <table class="bulk-table">
      <thead><tr>
        <th>#</th><th>File</th><th>Page Title</th><th>EDS Path</th>
        <th>Filled</th><th>Status</th><th></th>
      </tr></thead>
      <tbody>
        ${S.bulkPages.map((p, i) => `
        <tr class="bulk-row bulk-row-${p.status}">
          <td>${i + 1}</td>
          <td title="${x(p.fileName)}" style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${x(p.fileName)}</td>
          <td>${x(p.pageTitle)}</td>
          <td><input class="form-input bulk-path-input" style="font-size:.75rem;padding:2px 6px" data-bulk-idx="${i}" value="${x(p.edsPath)}"/></td>
          <td style="text-align:center">${p.status === 'ready' ? `${p.filled}/${p.filled + p.skipped}` : '—'}</td>
          <td><span class="bulk-status bulk-status-${p.status}">${p.status === 'ready' ? '✓ Ready' : p.status === 'publishing' ? '⏳' : p.status === 'done' ? '✓ Done' : p.status === 'error' ? '✗ Error' : p.status}</span>
            ${p.error ? `<span title="${x(p.error)}" style="color:var(--danger);cursor:help;margin-left:4px">ⓘ</span>` : ''}
          </td>
          <td><button class="btn btn-xs btn-ghost" data-bulk-pub="${i}" ${p.status === 'publishing' ? 'disabled' : ''}>Publish</button>${p.status === 'done' && p.authorUrl ? ` <button class="btn btn-xs btn-ghost" data-bulk-open-author="${i}">↗ Open authoring</button>` : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
      <button class="btn btn-sm btn-primary" id="btn-bulk-publish-all">↑ Publish All</button>
      <button class="btn btn-sm btn-ghost" id="btn-bulk-clear">Clear</button>
      <span style="font-size:.75rem;color:var(--muted)">${S.bulkPages.filter(p=>p.status==='done').length}/${S.bulkPages.length} published</span>
    </div>` : '';

  return `
    <div class="sv-section-title">Bulk XML Import</div>
    <div style="font-size:.75rem;color:var(--muted);margin-bottom:14px">
      Build the page layout on the canvas once, then fill multiple pages from separate AEM XML files and publish them all to AEM.
    </div>

    <div style="display:flex;gap:10px;margin-bottom:14px;align-items:flex-start">
      <div class="conn-card" style="flex:1;padding:14px">
        <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;color:var(--brand);margin-bottom:8px">Step 1 — Set Layout Template</div>
        <div style="font-size:.8rem;margin-bottom:8px">Current template: <strong>${x(tplInfo)}</strong></div>
        <button class="btn btn-sm btn-ghost" id="btn-set-bulk-template">📌 Use Current Canvas</button>
      </div>
      <div class="conn-card" style="flex:2;padding:14px">
        <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;color:var(--brand);margin-bottom:8px">Step 2 — Load pages &amp; create</div>
        <div class="settings-field" style="margin-bottom:8px">
          <label>Base EDS Path <span style="font-weight:400;color:var(--muted)">(page name appended automatically)</span></label>
          <input id="bulk-base-path" class="form-input" placeholder="/content/abbvie-nextgen-eds/corporate/abbvie-com/ch/de/who-we-are/our-leaders" value="${x(S._bulkBasePath || '')}"/>
        </div>

        <div class="settings-field" style="margin-bottom:8px">
          <label>Source folder <span style="font-weight:400;color:var(--muted)">(inside the repo — each subfolder = one page, named after the folder)</span></label>
          <div style="display:flex;gap:8px;align-items:center">
            <input id="bulk-folder" class="form-input" style="flex:1" placeholder="content-xml/ch/de/who-we-are/our-leaders" value="${x(S._bulkFolder || '')}"/>
            <button class="btn btn-sm" id="btn-bulk-load-folder" style="white-space:nowrap;background:#0d9488;color:#fff;border-color:#0d9488">📂 Load pages</button>
          </div>
        </div>

        <div style="font-size:.72rem;color:var(--muted);margin:8px 0 4px">— or upload individual XML files —</div>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="bulk-xml-files" type="file" accept=".xml" multiple style="flex:1;font-size:.8rem"/>
          <button class="btn btn-sm btn-ghost" id="btn-bulk-process" style="white-space:nowrap">⬆ Process files</button>
        </div>
        <div id="bulk-alert" style="margin-top:8px"></div>
      </div>
    </div>

    ${rowsHtml}`;
}

// ── Find Similar Pages tab ────────────────────────────────────────────────────
function simBand(s) { return s >= 90 ? 'vm-hi' : s >= 70 ? 'vm-mid' : 'vm-lo'; }
function findSimilarTabHtml() {
  const st = S.findSimilar, info = st.info;
  const infoLine = info
    ? `Indexed <strong>${info.indexed}</strong> AEM pages · ${info.regions.length} regions · ${info.canonCount} distinct pages`
    : `<span style="color:var(--muted)"><span class="spinner spinner-dark"></span> Building structure index…</span>`;
  const modeBtn = (m, label) => `<button class="btn btn-xs ${st.mode === m ? 'btn-primary' : 'btn-ghost'}" data-sim-mode="${m}">${label}</button>`;

  let resultHtml = '';
  if (st.error) resultHtml = `<div class="alert alert-error" style="margin-top:10px">${x(st.error)}</div>`;
  else if (st.result && st.mode === 'page' && st.result.matches) {
    const r = st.result;
    resultHtml = `<div style="margin-top:14px">
      <div class="sv-section-title" style="margin:0 0 4px">Best structural matches for <strong>${x(r.queryRel)}</strong></div>
      <div style="font-size:.72rem;color:var(--muted);margin-bottom:8px">Same page (<code>${x(r.canon)}</code>) in ${Math.max(0, r.total - 1)} other regions, ranked by layout match. Review a page, then import it yourself if it looks right.</div>
      <table class="bulk-table"><thead><tr><th>#</th><th>Matching AEM page</th><th>Match</th></tr></thead>
      <tbody>${r.matches.map((m, i) => `<tr>
        <td>${i + 1}</td>
        <td style="font-size:.78rem"><code>${x(m.rel)}</code></td>
        <td style="text-align:center"><span class="vm-score ${simBand(m.score)}">${m.score}%</span></td>
      </tr>`).join('')}</tbody></table>
    </div>`;
  } else if (st.result && st.mode === 'site' && st.result.rows) {
    const r = st.result;
    resultHtml = `<div style="margin-top:14px">
      <div class="sv-section-title" style="margin:0 0 4px">${x(r.region)} — ${r.count} pages (most reusable first)</div>
      <div style="font-size:.72rem;color:var(--muted);margin-bottom:8px">Click any page to see its best-matching pages across regions.</div>
      <table class="bulk-table"><thead><tr><th>Page</th><th>In regions</th><th>Layout variants</th><th>Share this layout</th></tr></thead>
      <tbody>${r.rows.slice(0, 300).map(row => {
        const ex = st.expanded[row.canon];
        return `<tr class="sim-site-row" data-sim-page="${x(row.canon)}" style="cursor:pointer">
          <td style="font-size:.75rem">${ex ? '▾' : '▸'} ${x(row.canon)}</td>
          <td style="text-align:center">${row.regions}</td>
          <td style="text-align:center">${row.variants}</td>
          <td style="text-align:center"><span class="vm-pill ${row.shared >= 3 ? 'vm-pill-ok' : 'vm-pill-warn'}">${row.shared}</span></td>
        </tr>${ex ? `<tr><td colspan="4" style="padding:0;background:var(--bg-secondary,#f8fafc)">
          <div style="padding:8px 12px">${ex.loading
            ? `<span class="spinner spinner-dark"></span> Finding matches…`
            : (ex.matches && ex.matches.length
              ? `<div style="font-size:.72rem;color:var(--muted);margin-bottom:4px">Best matches for <code>${x(r.region)}/${x(row.canon)}</code>:</div>
                 ${ex.matches.slice(0, 12).map((m, i) => `<div style="display:flex;gap:8px;align-items:center;padding:2px 0;font-size:.75rem"><span style="width:20px;color:var(--muted)">${i + 1}</span><code style="flex:1">${x(m.rel)}</code><span class="vm-score ${simBand(m.score)}">${m.score}%</span></div>`).join('')}`
              : `<span style="font-size:.75rem;color:var(--muted)">This page exists only in ${x(r.region)} — no other region to match.</span>`)}</div>
        </td></tr>` : ''}`;
      }).join('')}</tbody></table>
      ${r.rows.length > 300 ? `<div style="font-size:.72rem;color:var(--muted);margin-top:6px">Showing first 300 of ${r.rows.length}</div>` : ''}
    </div>`;
  }

  const controls = st.mode === 'page'
    ? `<div class="settings-field" style="flex:1;margin:0">
         <label>Page path <span style="font-weight:400;color:var(--muted)">(e.g. us/en/who-we-are, or just who-we-are)</span></label>
         <input id="sim-path" class="form-input" list="sim-canons" placeholder="us/en/who-we-are" value="${x(st.path)}"/>
       </div>`
    : `<div class="settings-field" style="flex:1;margin:0">
         <label>Region / site</label>
         <select id="sim-region" class="form-input">${(info ? info.regions : []).map(rg => `<option ${st.region === rg ? 'selected' : ''}>${x(rg)}</option>`).join('')}</select>
       </div>`;

  return `
    <div class="sv-section-title">Find Similar Pages (by structure)</div>
    <div style="font-size:.75rem;color:var(--muted);margin-bottom:6px">
      Finds the same page across every regional site and groups them by layout structure — <strong>content and language are ignored</strong>. Migrate the biggest group's layout once; it covers every region in that group.
    </div>
    <div style="font-size:.8rem;margin-bottom:12px">${infoLine}
      <button class="btn btn-xs btn-ghost" id="btn-sim-rebuild" style="margin-left:8px">↻ Rebuild index</button>
    </div>

    <div style="display:flex;gap:6px;margin-bottom:10px">${modeBtn('page', 'Single page')}${modeBtn('site', 'Whole site')}</div>

    <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
      ${controls}
      ${st.mode === 'site' ? `<div class="settings-field" style="width:110px;margin:0">
        <label>Group ≥ %</label>
        <input id="sim-threshold" class="form-input" type="number" min="50" max="100" value="${st.threshold}"/>
      </div>` : ''}
      <button class="btn btn-sm btn-primary" id="btn-sim-run" ${st.busy ? 'disabled' : ''}>${st.busy ? '⏳ Scanning…' : (st.mode === 'page' ? '🔎 Find matches' : '🔎 Scan site')}</button>
    </div>
    <datalist id="sim-canons">${(info && info.sampleCanons ? info.sampleCanons : []).map(c => `<option value="${x(c)}">`).join('')}</datalist>
    ${resultHtml}`;
}

async function vsimLoadInfo(refresh) {
  if (refresh) { S.findSimilar.info = null; render(); }
  try {
    const r = await fetch('/api/similar/info' + (refresh ? '?refresh=1' : ''));
    if (r.ok) {
      S.findSimilar.info = await r.json();
      if (!S.findSimilar.region && S.findSimilar.info.regions.length)
        S.findSimilar.region = S.findSimilar.info.regions.includes('us/en') ? 'us/en' : S.findSimilar.info.regions[0];
      render();
    }
  } catch (_) {}
}

// Expand a site-mode row to show that page's best matches across regions.
async function toggleSitePage(canon) {
  const st = S.findSimilar;
  st.expanded = st.expanded || {};
  if (st.expanded[canon]) { delete st.expanded[canon]; render(); return; }
  st.expanded[canon] = { loading: true }; render();
  try {
    const r = await fetch('/api/similar/page', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: `${st.region}/${canon}` }) });
    const d = await r.json();
    st.expanded[canon] = { loading: false, matches: r.ok ? d.matches : [] };
  } catch (_) { st.expanded[canon] = { loading: false, matches: [] }; }
  render();
}

async function doSimilarRun() {
  const st = S.findSimilar;
  st.expanded = {};
  // Read all inputs BEFORE render() (render rebuilds the DOM and would clear them).
  st.threshold = Math.max(50, Math.min(100, Number(document.getElementById('sim-threshold')?.value) || 88));
  if (st.mode === 'page') {
    st.path = (document.getElementById('sim-path')?.value || '').trim();
    if (!st.path) { st.error = 'Enter a page path.'; render(); return; }
  } else {
    st.region = document.getElementById('sim-region')?.value || st.region;
  }
  st.busy = true; st.error = null; st.result = null; render();
  try {
    const body = st.mode === 'page' ? { path: st.path, threshold: st.threshold } : { region: st.region, threshold: st.threshold };
    const r = await fetch(`/api/similar/${st.mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (r.ok) st.result = d; else st.error = d.error || 'Failed';
  } catch (e) { st.error = e.message; }
  st.busy = false; render();
}

// ── Migrate Full Site tab ─────────────────────────────────────────────────────
function migrateSiteTabHtml() {
  const ms = S.migrateSite;
  const info = S.findSimilar.info;   // reuse the structure index for the locale list
  const localeOpts = (info ? info.regions : []).map(rg => `<option ${ms.locale === rg ? 'selected' : ''}>${x(rg)}</option>`).join('');
  // Union so any detected region always appears (and stays checkable) even if it
  // somehow isn't in the locale index.
  const regionOptions = [...new Set([...((info && info.regions) || []), ...ms.regionSel])].sort();

  const SL = { preparing: '⏳ preparing', ready: '✓ ready', creating: '⏳ creating', done: '✓ done', error: '✗ error' };
  let planHtml = '';
  if (ms.error) planHtml = `<div class="alert alert-error" style="margin-top:10px">${x(ms.error)}</div>`;
  else if (ms.plan) {
    const p = ms.plan;
    const doneN = p.rows.filter(r => r.status === 'done').length, readyN = p.rows.filter(r => r.status === 'ready').length;
    planHtml = `<div style="margin-top:14px">
      <div class="sv-section-title" style="margin:0 0 4px">${x(p.locale)} — ${p.total} pages · <strong>${p.withMatch}</strong> have a migrated match</div>
      <div style="font-size:.72rem;color:var(--muted);margin-bottom:8px">Only exact same-path pages in selected locales are matched automatically. If that page does not exist in another locale, paste an EDS page path, or use <strong>🤖 Auto-build</strong> to generate a draft from its AEM XML.</div>
      <table class="bulk-table"><thead><tr><th>Source page</th><th>Reuse canvas from</th><th>Create at</th><th>Filled</th><th>Actions</th></tr></thead>
      <tbody>${p.rows.slice(0, 400).map((r, i) => `<tr class="bulk-row bulk-row-${r.status || ''}" style="${r.status === 'done' ? 'background:#d1fae5;' : ''}">
        <td style="font-size:.72rem">${ms.liveBase ? `<a href="${x((ms.liveBase).replace(/\/+$/,'') + '/' + r.canon)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none"><code style="color:var(--primary)">${x(r.canon)}</code> ↗</a>` : `<code>${x(r.canon)}</code>`}</td>
        <td>${r.matches.length
          ? `<select class="form-input mig-match" data-mig-idx="${i}" title="${x((r.matches[r.selIdx || 0] || {}).edsPath || '')}" style="font-size:.68rem;padding:2px 4px;max-width:320px">${r.matches.map((m, mi) => `<option value="${mi}" ${r.selIdx === mi ? 'selected' : ''} title="${x(m.edsPath || '')}">${x(m.region)}/${x(m.canon)} · ${m.score}%</option>`).join('')}</select>`
          : `<span style="color:var(--muted);font-size:.7rem">no exact-path page found</span>`}
          <input class="form-input mig-custom" data-mig-idx="${i}" style="font-size:.66rem;padding:2px 4px;margin-top:3px" placeholder="…or paste an EDS page path to reuse" value="${x(r.customPath || '')}"/></td>
        <td><input class="form-input mig-target" data-mig-idx="${i}" style="font-size:.68rem;padding:2px 4px" value="${x(r.targetPath || '')}"/></td>
        <td style="text-align:center;font-size:.72rem">${r.status === 'ready' || r.status === 'done' ? `${r.filled}/${r.filled + r.skipped}` : '—'}</td>
        <td style="min-width:220px;max-width:300px">
          <div style="display:flex;flex-wrap:wrap;gap:3px;align-items:center">
          ${r.matches.length ? `<button class="btn btn-xs" data-mig-prepare="${i}" title="${r.status === 'ready' || r.status === 'done' ? 'Re-prepare' : 'Prepare canvas from matched page'}" ${r.status === 'preparing' || r.status === 'creating' ? 'disabled' : ''}>${r.status === 'ready' || r.status === 'done' ? '↻ Re-prep' : '⚙ Prepare'}</button>` : ''}
          <button class="btn btn-xs ${r.matches.length ? 'btn-ghost' : 'btn-primary'}" data-mig-autobuild="${i}" title="Auto-generate a draft canvas from this page's AEM XML (no match needed)" ${r.status === 'preparing' || r.status === 'creating' ? 'disabled' : ''}>🤖 Auto-build</button>
          <button class="btn btn-xs btn-ghost" data-mig-usecanvas="${i}" title="Apply the canvas open in the Canvas tab to this page">📋 Use canvas</button>
          ${(r.status === 'ready' || r.status === 'done') ? `<button class="btn btn-xs btn-ghost" data-mig-preview="${i}" title="Open a visual layout preview in a new tab">👁 Layout</button><button class="btn btn-xs btn-ghost" data-mig-preview-page="${i}" title="Create this page under /preview in AEM and open it" ${r._previewingPage ? 'disabled' : ''}>🔍 Preview</button><button class="btn btn-xs btn-ghost" data-mig-check="${i}" title="Edit canvas">✏ Edit</button><button class="btn btn-xs btn-ghost" data-mig-create="${i}" title="Create page in AEM" ${r.status === 'creating' ? 'disabled' : ''}>↑ Create</button>` : ''}
          ${r.status === 'done' ? `<button class="btn btn-xs btn-ghost" data-mig-validate="${i}" title="Validate migrated page vs live AEM" ${r._validating ? 'disabled' : ''}>${r._validating ? '⏳' : '✓ Validate'}</button>` : ''}
          ${r.validation ? `<button class="btn btn-xs btn-ghost" data-show-validation="${i}" title="View validation report" style="color:${r.validation.finalScore >= 85 ? '#15803d' : r.validation.finalScore >= 70 ? '#ca8a04' : '#dc2626'}">📊 ${r.validation.finalScore ?? '?'}%</button>` : ''}
          ${r.status === 'done' && ms.liveBase ? `<button class="btn btn-xs btn-ghost" data-mig-compare="${i}" title="Side-by-side comparison with scroll sync">⚖ Compare</button>` : ''}
          </div>
          ${r.auto ? ` <span class="vm-pill ${r.confidence >= 90 ? 'vm-pill-ok' : r.confidence >= 70 ? 'vm-pill-warn' : 'vm-pill-bad'}" title="${Object.keys(r.unknownTypes || {}).length ? 'Unmapped: ' + x(Object.entries(r.unknownTypes).map(([t, n]) => `${t}×${n}`).join(', ')) : 'all blocks mapped to known EDS types'}">🤖 ${r.confidence}%</span>` : ''}
          ${r.a11y ? (r.a11y.ok ? ` <span class="vm-pill vm-pill-ok" title="Accessibility filled from live AEM page">♿ ${(r.a11y.imageAlt || 0) + (r.a11y.caption || 0) + (r.a11y.ctaAria || 0) + (r.a11y.videoPoster || 0)}</span>` : ` <span class="vm-pill vm-pill-warn" title="A11y backfill failed: ${x(r.a11y.error || '')}">♿ ✗</span>`) : ''}
          ${r.manual ? ' <span class="vm-pill vm-pill-warn">manual</span>' : ''}
          <span class="bulk-status bulk-status-${r.status}" style="font-size:.68rem">${SL[r.status] || ''}</span>${r.error ? ` <span title="${x(r.error)}" style="color:var(--danger);cursor:help">ⓘ</span>` : ''}
        </td>
      </tr>`).join('')}</tbody></table>
      <div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-sm" id="btn-mig-prepare-all">⚙ Prepare all matched</button>
        <button class="btn btn-sm" id="btn-mig-autobuild-nomatch">🤖 Auto-build all no-match</button>
        <button class="btn btn-sm btn-primary" id="btn-mig-create-all">↑ Create all ready</button>
        <span style="font-size:.75rem;color:var(--muted)">${readyN} ready · ${doneN} created · ${p.rows.filter(r => !r.matches.length).length} no-match</span>
      </div>
    </div>`;
  }

  return `
    <div class="sv-section-title">Migrate Full Site</div>
    <div style="font-size:.75rem;color:var(--muted);margin-bottom:12px">
      Pick a locale. Each page reuses the canvas of its best <strong>already-migrated</strong> match and is filled with this page's content. AEM connection comes from the Connection tab.
    </div>

    <div class="conn-card" style="padding:14px;margin-bottom:12px">
      <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;color:var(--brand);margin-bottom:8px">Config</div>
      <div class="settings-field" style="margin-bottom:8px">
        <label>EDS content root prefix <span style="font-weight:400;color:var(--muted)">(where migrated sites live, for reading their canvas)</span></label>
        <input id="ms-prefix" class="form-input" value="${x(ms.edsPrefix)}" placeholder="/content/abbvie-nextgen-eds/corporate/abbvie-com"/>
      </div>
      <div class="settings-field" style="margin-bottom:8px">
        <label>Already-migrated regions <span style="font-weight:400;color:var(--muted)">(optional — leave empty to 🤖 Auto-build every page from its AEM XML)</span></label>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
          <button class="btn btn-sm btn-ghost" id="btn-ms-detect" ${ms.detecting ? 'disabled' : ''}>${ms.detecting ? '⏳ Detecting…' : '🔄 Detect from AEM'}</button>
          <button class="btn btn-xs btn-ghost" id="btn-ms-region-all">Select all</button>
          <button class="btn btn-xs btn-ghost" id="btn-ms-region-none">Clear</button>
          <span id="ms-region-count" style="font-size:.72rem;color:var(--muted)">${ms.regionSel.length} selected</span>
        </div>
        ${ms.detectMsg ? `<div style="font-size:.72rem;color:${ms.detectErr ? 'var(--danger)' : 'var(--muted)'};margin-bottom:6px">${x(ms.detectMsg)}</div>` : ''}
        ${regionOptions.length ? `<input id="ms-region-search" class="form-input" style="margin-bottom:6px;font-size:.75rem" placeholder="🔍 Filter regions… (e.g. en, ch, es)"/>` : ''}
        <div class="ms-region-grid" id="ms-region-grid">
          ${regionOptions.length
            ? regionOptions.map(rg => `<label class="ms-region-chk"><input type="checkbox" class="ms-region" value="${x(rg)}" ${ms.regionSel.includes(rg) ? 'checked' : ''}/> ${x(rg)}</label>`).join('')
            : '<span style="font-size:.72rem;color:var(--muted)">Detect from AEM, or wait for the page index to load.</span>'}
        </div>
      </div>
      <div class="settings-field" style="margin-bottom:8px">
        <label>Create new pages under <span style="font-weight:400;color:var(--muted)">(your chosen destination root — page name appended)</span></label>
        <input id="ms-target" class="form-input" value="${x(ms.targetRoot)}" placeholder="/content/abbvie-nextgen-eds/corporate/abbvie-com/ar/es"/>
      </div>
      <div class="settings-field" style="margin-bottom:0">
        <label style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="ms-a11y" ${ms.a11yBackfill ? 'checked' : ''} style="width:auto"/>
          ♿ Backfill accessibility from the live AEM page <span style="font-weight:400;color:var(--muted)">(fills image alt, captions, CTA labels missing from the XML)</span>
        </label>
        <input id="ms-livebase" class="form-input" style="margin-top:6px" value="${x(ms.liveBase)}" placeholder="Live AEM base URL, e.g. https://www.abbvie.ch  (page path derived from the source, minus the country segment)"/>
      </div>
    </div>

    <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
      <div class="settings-field" style="min-width:160px;margin:0">
        <label>Locale to migrate</label>
        <select id="ms-locale" class="form-input">${localeOpts || '<option>loading…</option>'}</select>
      </div>
      <div class="settings-field" style="width:120px;margin:0">
        <label>Fallback match ≥ %</label>
        <input id="ms-minscore" class="form-input" type="number" min="0" max="100" value="${ms.minScore}"/>
      </div>
      <button class="btn btn-sm btn-primary" id="btn-ms-plan" ${ms.busy ? 'disabled' : ''}>${ms.busy ? '⏳ Starting…' : '🚀 Start Migration'}</button>
      ${ms.plan ? `<button class="btn btn-sm btn-ghost" id="btn-ms-clear-plan" style="color:var(--danger)" title="Discard migration plan and progress">✕ Clear progress</button>` : ''}
    </div>
    ${planHtml}`;
}

// Pull the list of already-migrated regions live from the configured AEM instance.
async function doDetectMigratedRegions() {
  const ms = S.migrateSite;
  ms.edsPrefix = (document.getElementById('ms-prefix')?.value || '').trim();
  const { aemHost, username, password } = S.conn;
  if (!aemHost || !username || !password) { ms.detectErr = true; ms.detectMsg = 'Fill in the AEM connection (Connection tab) first.'; render(); return; }
  ms.detecting = true; ms.detectMsg = null; render();
  try {
    const r = await fetch('/api/migrate-site/detect-regions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aemHost, username, password, edsPrefix: ms.edsPrefix }),
    });
    const d = await r.json();
    if (!r.ok) { ms.detectErr = true; ms.detectMsg = d.error || 'Detection failed'; }
    else { ms.regionSel = Array.isArray(d.regions) ? d.regions.slice() : []; ms.detectErr = false; ms.detectMsg = `Found ${ms.regionSel.length} migrated region(s) — all checked; uncheck any to exclude.`; }
  } catch (e) { ms.detectErr = true; ms.detectMsg = e.message; }
  ms.detecting = false; render();
}

async function doBuildMigratePlan() {
  const ms = S.migrateSite;
  ms.edsPrefix = (document.getElementById('ms-prefix')?.value || '').trim();
  ms.targetRoot = (document.getElementById('ms-target')?.value || '').trim().replace(/\/+$/, '');
  ms.locale = document.getElementById('ms-locale')?.value || ms.locale;
  ms.minScore = Math.max(0, Math.min(100, Number(document.getElementById('ms-minscore')?.value) || 0));
  const regions = ms.regionSel.slice();
  if (!ms.locale) { ms.error = 'Pick a locale.'; render(); return; }
  // Regions are optional: with none selected, every page becomes a "no-match" row
  // you can 🤖 Auto-build from its AEM XML (no migrated match required).
  ms.busy = true; ms.error = null; ms.plan = null; render();
  try {
    const r = await fetch('/api/migrate-site/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locale: ms.locale, migratedRegions: regions, edsPrefix: ms.edsPrefix, minScore: ms.minScore }) });
    const d = await r.json();
    if (!r.ok) { ms.error = d.error || 'Failed'; }
    else {
      d.rows.forEach(r2 => { r2.selIdx = 0; r2.targetPath = ms.targetRoot ? `${ms.targetRoot}/${r2.canon}` : ''; r2.customPath = ''; r2.status = null; r2.filled = 0; r2.skipped = 0; });
      ms.plan = d;
    }
  } catch (e) { ms.error = e.message; }
  ms.busy = false; render();
}

// Normalize a pasted AEM/EDS page reference (full URL or content path) to a JCR path.
function normEdsPath(p) {
  p = String(p || '').trim();
  if (/^https?:\/\//i.test(p)) { try { p = new URL(p).pathname; } catch (_) {} }
  return p.replace(/^\/editor\.html/, '').replace(/\.html$/, '').replace(/\/+$/, '');
}

// Prepare one page: import the chosen migrated EDS canvas (a match OR a pasted path),
// then fill it from the source AEM XML.
async function doMigPrepareOne(i) {
  const ms = S.migrateSite, r = ms.plan?.rows[i];
  if (!r) return;
  const { aemHost, username, password } = S.conn;
  if (!aemHost || !username || !password) { alert('Configure the AEM connection (Connection tab) first.'); return; }
  const custom = normEdsPath(r.customPath);
  const match = r.matches[r.selIdx] || r.best;
  const pagePath = custom || (match && match.edsPath);
  if (!pagePath) { r.status = 'error'; r.error = 'Pick a match or paste an EDS page path to reuse.'; render(); return; }
  r.status = 'preparing'; r.error = null; render();
  try {
    const [impRes, srcRes] = await Promise.all([
      fetch('/api/import-page', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aemHost, username, password, pagePath }) }).then(x => x.json()),
      fetch('/api/parse-local-xml', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rel: r.sourceRel }) }).then(x => x.json()),
    ]);
    if (!impRes.sections) throw new Error('Canvas import failed: ' + (impRes.error || 'no sections'));
    if (!srcRes.ok) throw new Error('Source parse failed: ' + (srcRes.error || ''));
    const ids = items => (items || []).map(it => ({ ...it, id: uid(), children: ids(it.children) }));
    const sections = impRes.sections.map(sec => ({ ...sec, id: uid(), blocks: (sec.blocks || []).map(b => ({ ...b, id: uid(), children: ids(b.children) })) }));
    const { filled, skipped } = fillSectionsFromPool(sections, srcRes.ordered);
    r.sections = sections; r.filled = filled; r.skipped = skipped;
    r.meta = srcRes.meta || {}; r.pageTitle = srcRes.pageTitle; r.status = 'ready';
  } catch (e) { r.status = 'error'; r.error = e.message; }
  render();
}
// Apply the canvas currently open in the Canvas tab to a row (manual / override),
// filling it from that page's source AEM XML. Works for no-match rows too.
async function doMigUseCurrentCanvas(i) {
  const ms = S.migrateSite, r = ms.plan?.rows[i];
  if (!r) return;
  if (!S.sections.length) { alert('Build a canvas on the Canvas tab first, then click "Use canvas".'); return; }
  r.status = 'preparing'; r.error = null; render();
  try {
    const src = await fetch('/api/parse-local-xml', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rel: r.sourceRel }) }).then(x => x.json());
    if (!src.ok) throw new Error('Source parse failed: ' + (src.error || ''));
    const ids = items => (items || []).map(it => ({ ...it, id: uid(), children: ids(it.children) }));
    const sections = JSON.parse(JSON.stringify(S.sections)).map(sec => ({ ...sec, id: uid(), blocks: (sec.blocks || []).map(b => ({ ...b, id: uid(), children: ids(b.children) })) }));
    const { filled, skipped } = fillSectionsFromPool(sections, src.ordered);
    r.sections = sections; r.filled = filled; r.skipped = skipped; r.meta = src.meta || {}; r.pageTitle = src.pageTitle; r.manual = true; r.status = 'ready';
  } catch (e) { r.status = 'error'; r.error = e.message; }
  render();
}

async function doMigPrepareAll() {
  const rows = S.migrateSite.plan?.rows || [];
  for (let i = 0; i < rows.length; i++) if (rows[i].matches.length && rows[i].status !== 'done') await doMigPrepareOne(i);
}

// Auto-generate a draft canvas straight from the source AEM XML (aem-canvas converter).
// No match needed — the structural rules build sections/grids and fill content in one pass.
// Sets a confidence score so the user knows which drafts need the most review.
// Live AEM URL for a source page: <liveBase>/<rel minus country segment>.html
function liveUrlFor(sourceRel) {
  const base = (S.migrateSite.liveBase || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  // sourceRel is like "nz/en/join-us/life-at-abbvie/benefits"
  // Strip BOTH country (nz) and language (en) segments → "join-us/life-at-abbvie/benefits"
  const path = String(sourceRel).replace(/^\/+|\/+$/g, '').split('/').slice(2).join('/');
  return `${base}/${path}.html`;
}
async function doMigAutoBuild(i) {
  const ms = S.migrateSite, r = ms.plan?.rows[i];
  if (!r) return;
  r.status = 'preparing'; r.error = null; render();
  try {
    const pageUrl = ms.a11yBackfill ? liveUrlFor(r.sourceRel) : '';
    const d = await fetch('/api/aem-to-canvas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rel: r.sourceRel, pageUrl }) }).then(x => x.json());
    if (!d.ok || !d.sections) throw new Error('Auto-build failed: ' + (d.error || 'no sections'));
    r.a11y = d.a11y || null;
    const ids = items => (items || []).map(it => ({ ...it, id: uid(), children: ids(it.children) }));
    const sections = d.sections.map(sec => ({ ...sec, id: uid(), blocks: (sec.blocks || []).map(b => ({ ...b, id: uid(), children: ids(b.children) })) }));
    r.sections = sections;
    r.meta = d.meta || {}; r.pageTitle = d.pageTitle;
    r.filled = d.stats.mappedBlocks; r.skipped = Math.max(0, d.stats.blocks - d.stats.mappedBlocks);
    r.manual = false; r.auto = true; r.confidence = d.stats.confidence; r.unknownTypes = d.stats.unknownTypes || {};
    r.status = 'ready';
  } catch (e) { r.status = 'error'; r.error = e.message; }
  render();
}
// Preview a prepared row's canvas in a new tab (no AEM needed).
async function doMigPreviewOne(i) {
  const ms = S.migrateSite, r = ms.plan?.rows[i];
  if (!r || !r.sections) { alert('Prepare or auto-build this page first before previewing.'); return; }
  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sections: r.sections, meta: r.meta || {} })
    });
    if (!res.ok) { const d = await res.json(); alert('Preview failed: ' + (d.error || res.status)); return; }
    const html = await res.text();
    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const tab  = window.open(url, '_blank', 'noopener,noreferrer');
    if (tab) tab.opener = null;
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    alert('Preview error: ' + e.message);
  }
}

// Create a page under {root}/{country}/{lang}/preview/{pageName} in AEM for a specific migration row.
async function doMigPreviewPageOne(i) {
  const ms = S.migrateSite, r = ms.plan?.rows[i];
  if (!r || !r.sections) { alert('Prepare or auto-build this page first before creating a preview page.'); return; }
  const { aemHost, username, password } = S.conn;
  if (!aemHost || !username || !password) { alert('Configure the AEM connection (Connection tab) first.'); return; }

  // Derive the preview parent path from the row's target path
  // targetPath is like /content/.../ch/de/science/areas-of-focus/page-name
  // We want /content/.../ch/de/preview
  const targetPath = (r.targetPath || '').trim().replace(/\/+$/, '');
  const edsPrefix = ms.edsPrefix || '/content/abbvie-nextgen-eds/corporate/abbvie-com';
  const root = edsPrefix.replace(/\/+$/, '');

  // Extract locale (country/lang) from targetPath relative to root
  let previewParentPath = null;
  if (targetPath.startsWith(root)) {
    const rel = targetPath.slice(root.length).replace(/^\//, '');
    const segs = rel.split('/').filter(Boolean);
    if (segs.length >= 2) {
      previewParentPath = `${root}/${segs[0]}/${segs[1]}/preview`;
    }
  }
  if (!previewParentPath) {
    alert('Cannot determine the locale from "Create at" path. Set the "Create at" field first (e.g. /content/…/ch/de/page-name).');
    return;
  }

  // Page structure: .../preview/{pageName}/{timestamp}
  // e.g. .../ch/de/preview/acne-inversa/1754401255000
  // Timestamp guarantees uniqueness across sessions and browser refreshes.
  const basePageName = targetPath ? targetPath.split('/').pop() : r.canon.split('/').pop();
  if (!basePageName) { alert('Cannot determine page name. Set the "Create at" field first.'); return; }
  // Nest under preview/{basePageName}/ so every preview click lands in its own named folder
  previewParentPath = `${previewParentPath}/${basePageName}`;
  const pageName = String(Date.now());

  r._previewingPage = true; render();
  try {
    const meta = (r.meta && Object.keys(r.meta).length) ? r.meta : (r.pageTitle ? { 'jcr:title': r.pageTitle } : {});
    const res = await fetch('/api/preview-page', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aemHost, username, password, previewParentPath, pageName, meta, sections: r.sections })
    });
    const data = await res.json();
    if (!data.ok) { alert('Preview page creation failed: ' + (data.error || 'Unknown error')); }
    else {
      // Open as AEM author preview (.html), not Universal Editor
      const previewUrl = `${aemHost.replace(/\/+$/, '')}${data.path}.html`;
      const tab = window.open(previewUrl, '_blank', 'noopener,noreferrer');
      if (tab) tab.opener = null;
    }
  } catch (e) {
    alert('Preview page error: ' + e.message);
  }
  r._previewingPage = false; render();
}

// Auto-build every row that has no migrated match — the main use for pending pages.
async function doMigAutoBuildNoMatch() {
  const rows = S.migrateSite.plan?.rows || [];
  for (let i = 0; i < rows.length; i++) if (!rows[i].matches.length && rows[i].status !== 'done') await doMigAutoBuild(i);
}

// Open a prepared page's canvas in the editor to review/edit; edits saved back on return.
function doMigCheckCanvas(i) {
  const ms = S.migrateSite, r = ms.plan?.rows[i];
  if (!r || !r.sections) return;
  // Auto-save any in-progress edits back to the row you were just editing, so
  // switching between page canvases never loses work.
  if (ms.editIdx != null && ms.editIdx !== i && ms.plan?.rows[ms.editIdx]) {
    ms.plan.rows[ms.editIdx].sections = JSON.parse(JSON.stringify(S.sections));
  }
  ms.editIdx = i;
  S.sections = JSON.parse(JSON.stringify(r.sections));
  normalizeCanvasBlocks(S.sections);            // separators/eyebrows auto-normalized on open
  r.sections = JSON.parse(JSON.stringify(S.sections));
  S.sel = S.sections.length ? { secId: S.sections[0].id } : null;
  S.collapsed.clear();
  _view = 'canvas';
  render();
}
// Fill accessibility (alt/caption/aria) into the canvas currently open for review — no rebuild.
// Uses the reviewed row's live URL (liveBase + source path), or prompts for one.
// Fill a11y (from the live page) AND normalize separators/eyebrows on the open canvas — no rebuild.
// Normalization is pure; the a11y part needs a live URL (blank = normalize only).
async function doFillA11yCanvas() {
  const ms = S.migrateSite;
  const row = (ms.editIdx != null && ms.plan) ? ms.plan.rows[ms.editIdx] : null;
  let pageUrl = row ? liveUrlFor(row.sourceRel) : '';
  if (!pageUrl) pageUrl = (window.prompt('Live AEM page URL for accessibility (leave blank to just normalize separators/eyebrows):', '') || '').trim();
  S._a11yBusy = true; S._a11yMsg = null; S._a11yErr = false; render();
  try {
    const _migRow = (ms.editIdx != null && ms.plan) ? ms.plan.rows[ms.editIdx] : null;
    const _pagePath = S._importPagePath || (_migRow?.targetPath || '');
    const d = await fetch('/api/a11y-backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sections: S.sections, pageUrl, aemHost: S.conn?.aemHost || '', aemUser: S.conn?.username || '', aemPass: S.conn?.password || '', pagePath: _pagePath }) }).then(x => x.json());
    if (!d.ok) throw new Error(d.error || 'Failed');
    S.sections = d.sections;                         // updated in place, keeps ids
    const s = d.stats || {};
    const a = (s.imageAlt || 0) + (s.caption || 0) + (s.ctaAria || 0) + (s.videoPoster || 0) + (s.captionFromDam || 0);
    if (row) { row.sections = JSON.parse(JSON.stringify(S.sections)); if (d.a11y && d.a11y.ok) row.a11y = { ok: true, ...s }; }
    const parts = [];
    if (a) parts.push(`♿ ${a} a11y (alt ${s.imageAlt || 0}, cap ${s.caption || 0}, cta ${s.ctaAria || 0}, vid ${s.videoPoster || 0})`);
    else if (pageUrl) parts.push('♿ nothing new to fill');
    const norm = (s.separators || 0) + (s.eyebrows || 0);
    if (norm) parts.push(`🔧 ${s.separators || 0} separators, ${s.eyebrows || 0} eyebrows fixed`);
    const a11yErr = d.a11y && !d.a11y.ok;
    if (a11yErr) {
      const errText = d.a11y.error || '';
      const is404   = errText.includes('404');
      const is403   = errText.includes('403');
      const hint    = is404 ? ' (page not found — check Live AEM base URL)'
                    : is403 ? ' (bot challenge — retry may help)'
                    : '';
      parts.push(`a11y fetch failed: ${errText}${hint}`);
    }
    S._a11yErr = !!(pageUrl && a11yErr);
    S._a11yMsg = parts.join(' · ');
  } catch (e) { S._a11yErr = true; S._a11yMsg = '✗ ' + e.message; }
  S._a11yBusy = false; render();
}
function doMigSaveCanvas() {
  const ms = S.migrateSite;
  if (ms.editIdx == null || !ms.plan) { _view = 'settings'; render(); return; }
  const r = ms.plan.rows[ms.editIdx];
  r.sections = JSON.parse(JSON.stringify(S.sections));
  ms.editIdx = null;
  _view = 'settings'; _settingsTab = 'migsite';
  render();
}

async function doMigCreateOne(i) {
  const ms = S.migrateSite, r = ms.plan?.rows[i];
  if (!r || r.status !== 'ready') return;
  const { aemHost, username, password } = S.conn;
  if (!aemHost || !username || !password) { alert('Configure the AEM connection first.'); return; }
  const clean = (r.targetPath || '').trim().replace(/\/+$/, ''); const cut = clean.lastIndexOf('/');
  if (!clean.startsWith('/') || cut <= 0 || cut === clean.length - 1) { r.status = 'error'; r.error = 'Set a full "Create at" path like /content/.../parent/' + r.canon; render(); return; }
  // A11y pre-flight
  if (!r._a11yOverride) {
    const issues = checkA11y(r.sections || []);
    if (issues.length) {
      S.modal = 'a11y-warning';
      S._a11yIssues = issues;
      S._a11yPendingAction = 'mig-create:' + i;
      render();
      return;
    }
  }
  r._a11yOverride = false;
  const parentPath = clean.slice(0, cut), pageName = clean.slice(cut + 1);
  r.status = 'creating'; r.error = null; render();
  try {
    const meta = (r.meta && Object.keys(r.meta).length) ? r.meta : (r.pageTitle ? { 'jcr:title': r.pageTitle } : {});
    const res = await fetch('/api/pages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aemHost, username, password, parentPath, pageName, meta, sections: r.sections }) }).then(x => x.json());
    if (res.ok) {
      r.status = 'done'; r.error = null; r.authorUrl = buildUeUrl(res.path);
      // Auto-open in Universal Editor immediately after page creation.
      window.open(r.authorUrl, '_blank');
      // Fire-and-forget: delete all preview pages for this row now that the real page is created.
      // Preview folder path: {edsPrefix}/{country}/{lang}/preview/{pageName}
      const ms2 = S.migrateSite;
      const root2 = (ms2.edsPrefix || '/content/abbvie-nextgen-eds/corporate/abbvie-com').replace(/\/+$/, '');
      const tgt = (r.targetPath || '').trim().replace(/\/+$/, '');
      if (tgt.startsWith(root2)) {
        const rel2 = tgt.slice(root2.length).replace(/^\//, '');
        const segs2 = rel2.split('/').filter(Boolean);
        if (segs2.length >= 3) {
          const pgName = segs2[segs2.length - 1];
          const previewFolder = `${root2}/${segs2[0]}/${segs2[1]}/preview/${pgName}`;
          fetch('/api/preview-page', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ aemHost, username, password, previewFolderPath: previewFolder })
          }).then(d => d.json()).then(d => {
            if (d.ok && !d.skipped) console.log(`[preview-cleanup] Deleted ${previewFolder}`);
          }).catch(e => console.warn('[preview-cleanup] Failed:', e.message));
        }
      }
    } else { r.status = 'error'; r.error = res.error || 'Create failed'; }
  } catch (e) { r.status = 'error'; r.error = e.message; }
  render();
}
async function doMigCreateAll() {
  const rows = S.migrateSite.plan?.rows || [];
  // Create parents before children: order the ready rows by "Create at" path DEPTH (shallowest
  // first, ties broken alphabetically) so a page's parent page always exists in AEM before the
  // page itself is created — otherwise a deeper page fails when its parent isn't there yet.
  const ready = rows.map((r, i) => ({ r, i }))
    .filter(({ r }) => r.status === 'ready')
    .sort((a, b) => {
      const pa = (a.r.targetPath || '').replace(/\/+$/, ''), pb = (b.r.targetPath || '').replace(/\/+$/, '');
      return pa.split('/').length - pb.split('/').length || pa.localeCompare(pb);
    });
  for (const { i } of ready) await doMigCreateOne(i);
}

function stylesTabHtml() {
  const entries = _styleEntries || {};
  const ids     = Object.keys(entries);

  // Group by groupLabel
  const groups = {};
  for (const [id, e] of Object.entries(entries)) {
    const g = e.groupLabel || 'Other';
    if (!groups[g]) groups[g] = [];
    groups[g].push({ id, ...e });
  }

  const confPath = S.conn?.confPath || '';
  const mapped   = ids.filter(id => entries[id].edsClass).length;

  const tableRows = Object.entries(groups).map(([grp, rows]) => `
    <tr class="sm-group-row"><td colspan="4"><strong>${x(grp)}</strong></td></tr>
    ${rows.map(e => `
    <tr class="sm-row ${e.edsClass ? '' : 'sm-row--unmapped'}">
      <td class="sm-id">${x(e.id)}</td>
      <td>${x(e.aemLabel)}<br><span class="sm-aemclass">${x(e.aemClass)}</span></td>
      <td><input class="sm-eds-input" data-sm-id="${x(e.id)}" value="${x(e.edsClass)}" placeholder="eds class…"></td>
      <td>${e.confidence ? `<span class="sm-conf ${e.confidence >= 70 ? 'sm-conf--hi' : 'sm-conf--lo'}">${e.confidence}%</span>` : '—'}</td>
    </tr>`).join('')}
  `).join('');

  return `<div class="sv-section">
    <div class="sv-section-title">Build Style Map from AEM Conf</div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
      <input id="sm-conf-path" class="form-input" style="flex:1" placeholder="/path/to/conf/policies/.content.xml"
        value="${x(confPath)}">
      <button class="btn btn-primary btn-sm" id="btn-build-style-map">&#9654; Build Style Map</button>
    </div>
    <div id="sm-status" style="font-size:.8rem;color:var(--text-muted);margin-bottom:12px">
      ${ids.length ? `${mapped} of ${ids.length} styles mapped` : 'Click Build to load styles from AEM conf'}
    </div>

    ${ids.length ? `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <span style="font-size:.8rem;color:var(--text-muted)">Yellow rows have no EDS class yet — fill them in manually.</span>
      <button class="btn btn-secondary btn-sm" id="btn-save-style-map">Save Changes</button>
    </div>
    <table class="sm-table">
      <thead><tr><th>Style ID</th><th>AEM Label / Class</th><th>EDS Class</th><th>Conf</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>` : ''}
  </div>`;
}

async function buildStyleMap() {
  const confPath = document.getElementById('sm-conf-path')?.value?.trim();
  if (!confPath) { alert('Enter the AEM conf policies path'); return; }
  // remember conf path
  S.conn = S.conn || {};
  S.conn.confPath = confPath;
  const btn = document.getElementById('btn-build-style-map');
  if (btn) { btn.disabled = true; btn.textContent = 'Building…'; }
  const status = document.getElementById('sm-status');
  if (status) status.textContent = 'Parsing conf and cross-referencing pages…';
  try {
    const res  = await fetch(`/api/build-style-map?confPath=${encodeURIComponent(confPath)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    _styleEntries = data.styleMap;
    render();
  } catch (e) {
    if (status) status.textContent = 'Error: ' + e.message;
    if (btn) { btn.disabled = false; btn.textContent = '▶ Build Style Map'; }
  }
}

async function saveStyleMap() {
  // Collect all edits from inputs
  const inputs = document.querySelectorAll('.sm-eds-input');
  const updates = {};
  inputs.forEach(inp => {
    const id = inp.dataset.smId;
    if (id && _styleEntries?.[id]) {
      updates[id] = { ..._styleEntries[id], edsClass: inp.value.trim() };
    }
  });
  Object.assign(_styleEntries, updates);
  const res  = await fetch('/api/style-map', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
  const data = await res.json();
  if (data.ok) {
    const el = document.getElementById('sm-status');
    if (el) { el.textContent = 'Saved.'; setTimeout(() => render(), 800); }
  }
}

// ── Thumbnails settings tab ───────────────────────────────────────────────────
function thumbnailsTabHtml() {
  const CAT_ORD = ['Hero','Article','Grid','Content','Video','Cards','CTA','FAQ','Quote','Related'];
  const groups  = {};
  for (const def of S.sectionsLib) { const c = sectionCategory(def); (groups[c] = groups[c] || []).push(def); }
  const ordered = CAT_ORD.filter(c => groups[c]).flatMap(c => groups[c]);
  const captured = ordered.filter(d => d.thumbnailUrl).length;

  const orderItems = ordered.map((d, i) =>
    `<div class="tho-row"><span class="tho-num">${i + 1}</span><span class="tho-id">${x(d.id)}</span></div>`
  ).join('');

  const gridItems = ordered.map(def => {
    const hasThumb = !!def.thumbnailUrl;
    const imgHtml  = hasThumb
      ? `<img src="${x(def.thumbnailUrl)}" alt="${x(def.title)}">`
      : `<span class="thumb-svg-badge">SVG</span>`;
    return `<div class="thumb-card">
      <div class="thumb-card-img">${imgHtml}</div>
      <span class="thumb-card-name" title="${x(def.id)}">${x(def.title)}</span>
      <button class="thumb-gen-btn" data-thumb-gen="${x(def.id)}" title="Generate from AEM">↺</button>
      <label class="thumb-upload-btn" title="Upload screenshot" data-id="${x(def.id)}">📷<input type="file" accept="image/*" style="display:none" data-thumb-upload="${x(def.id)}"></label>
      ${hasThumb ? `<button class="thumb-del" data-id="${x(def.id)}" title="Remove">✕</button>` : '<span style="width:18px"></span>'}
    </div>`;
  }).join('');

  const autoParent = S.conn?.parentPath || '';

  return `<div class="thumbs-tab">
    <div class="thumb-auto-section">
      <div class="sv-section-title">Auto-generate from AEM</div>
      <div style="font-size:.74rem;color:var(--muted);margin-bottom:10px">
        Creates one sample page per template on AEM, then screenshots each via puppeteer.
        Uses AEM credentials from the Connection tab.
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;align-items:center;gap:6px">
          <label style="font-size:.78rem;width:100px;flex-shrink:0">Parent path</label>
          <input class="pm-input" id="thumb-auto-parent" type="text"
            value="${x(autoParent)}" placeholder="/content/abbvie-nextgen-eds/…/en" style="flex:1">
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <label style="font-size:.78rem;width:100px;flex-shrink:0">Folder name</label>
          <input class="pm-input" id="thumb-auto-folder" type="text"
            value="section-samples" placeholder="section-samples" style="flex:1">
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap">
          <label style="font-size:.78rem;cursor:pointer;display:flex;align-items:center;gap:4px">
            <input type="checkbox" id="thumb-auto-overwrite"> Overwrite existing
          </label>
          <button class="btn btn-primary btn-sm" id="btn-auto-generate-thumbs">▶ Generate All (${ordered.length})</button>
          <span id="thumb-auto-status" style="font-size:.78rem;color:var(--muted)"></span>
        </div>
        <div id="thumb-auto-results" style="font-size:.75rem;margin-top:4px"></div>
      </div>
    </div>

    <div class="sv-section-title" style="margin-top:18px">Palette Order <span style="font-size:.72rem;font-weight:400;color:var(--muted)">(build your EDS test page in this order)</span></div>
    <details class="tho-details">
      <summary class="tho-summary">Show ${ordered.length} section IDs in order</summary>
      <div class="thumb-order-list">${orderItems}</div>
      <button class="btn btn-ghost btn-sm" id="btn-copy-order" style="margin-top:6px">Copy list</button>
    </details>

    <div class="sv-section-title" style="margin-top:18px">Capture from EDS URL</div>
    <div style="font-size:.74rem;color:var(--muted);margin-bottom:8px">
      Build an EDS page with all sections in palette order, then paste the URL here.
      Puppeteer will screenshot each section element in DOM order.
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;gap:6px">
        <label style="font-size:.78rem;width:90px;flex-shrink:0">Page URL</label>
        <input class="pm-input" id="thumb-url" type="url" placeholder="https://…/test-page" style="flex:1">
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <label style="font-size:.78rem;width:90px;flex-shrink:0">CSS selector</label>
        <input class="pm-input" id="thumb-selector" type="text" value="main > div.section" style="flex:1">
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
        <button class="btn btn-primary btn-sm" id="btn-capture-thumbs">Capture all (${ordered.length})</button>
        <span id="thumb-capture-status" style="font-size:.78rem;color:var(--muted)"></span>
      </div>
    </div>

    <div class="sv-section-title" style="margin-top:20px">
      Thumbnails <span class="slc-group-count">${captured}/${ordered.length}</span>
      <span style="font-size:.72rem;font-weight:400;color:var(--muted);margin-left:6px">📷 = upload, ✕ = remove</span>
    </div>
    <div class="thumb-grid">${gridItems}</div>
  </div>`;
}

async function doAutoGenerateThumbs() {
  const parentPath = document.getElementById('thumb-auto-parent')?.value?.trim();
  const folderName = (document.getElementById('thumb-auto-folder')?.value?.trim()) || 'section-samples';
  const overwrite  = document.getElementById('thumb-auto-overwrite')?.checked || false;
  if (!parentPath) { alert('Parent path is required'); return; }
  const { aemHost, username, password } = S.conn;
  if (!aemHost || !username || !password) {
    alert('AEM credentials are required. Set them in the Connection tab first.'); return;
  }
  const statusEl  = document.getElementById('thumb-auto-status');
  const resultsEl = document.getElementById('thumb-auto-results');
  const btn       = document.getElementById('btn-auto-generate-thumbs');
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = 'Creating pages and capturing screenshots… (this may take a few minutes)';
  if (resultsEl) resultsEl.innerHTML = '';
  try {
    const res  = await fetch('/api/section-thumbs/auto-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentPath, folderName, aemHost, username, password, overwrite })
    });
    const data = await res.json();
    if (!res.ok) {
      if (statusEl) statusEl.textContent = `Error: ${data.error}`;
      if (btn) btn.disabled = false;
      return;
    }
    // Re-fetch sections to pick up new thumbnailUrls
    const secs = await fetch('/api/sections').then(r => r.json());
    S.sectionsLib = secs;
    const summary = `Done — ${data.screenshotted} captured, ${data.skipped} skipped, ${data.failed} failed`;
    if (statusEl) statusEl.textContent = summary;
    if (data.failed > 0 && resultsEl) {
      const failedItems = data.results.filter(r => r.status === 'error' || r.status === 'screenshot-failed');
      resultsEl.innerHTML = failedItems.map(r =>
        `<div style="color:var(--error)">${x(r.id)}: ${x(r.error || r.status)}</div>`
      ).join('');
    }
    render();
  } catch (err) {
    if (statusEl) statusEl.textContent = `Error: ${err.message}`;
  }
  if (btn) btn.disabled = false;
}

async function doGenerateSingleThumb(id) {
  const parentPath = document.getElementById('thumb-auto-parent')?.value?.trim() || S.conn?.parentPath || '';
  const folderName = document.getElementById('thumb-auto-folder')?.value?.trim() || 'section-samples';
  const { aemHost, username, password } = S.conn;
  if (!parentPath || !aemHost || !username || !password) {
    alert('Set AEM parent path and credentials in Connection tab first'); return;
  }
  // Show spinner on the button
  const btn = document.querySelector(`[data-thumb-gen="${id}"]`);
  const origText = btn?.textContent;
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const res  = await fetch('/api/section-thumbs/auto-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentPath, folderName, aemHost, username, password,
        sectionIds: [id], overwrite: true })
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Failed'); return; }
    const entry = data.results?.find(r => r.id === id);
    if (entry?.status === 'done') {
      const sec = S.sectionsLib.find(d => d.id === id);
      if (sec) sec.thumbnailUrl = entry.thumbUrl + '?t=' + Date.now();
      render();
    } else {
      alert(`Failed: ${entry?.error || entry?.status || 'unknown error'}`);
    }
  } catch (err) { alert(err.message); }
  if (btn) { btn.textContent = origText; btn.disabled = false; }
}

// ── Block picker modal ────────────────────────────────────────────────────────
function blockPickerModalHtml() {
  const ctx   = S.pickCtx;
  const secId = ctx?.secId;
  const blkId = ctx?.blkId;
  let title  = 'Add Block';
  let groups;

  if (blkId) {
    const blk = findBlk(blkId);
    if (blk?.type === 'grid-section') {
      // grid-section children are content blocks — show the full content palette
      title  = 'Add Block to Column';
      groups = getPaletteGroups().filter(g => g.label !== 'Sections');
    } else {
      const allowedIds = S.config?.filterMap?.[blk?.type] || [];
      title  = 'Add Item';
      groups = [{ label: 'Items', ids: allowedIds }];
    }
  } else {
    groups = getPaletteGroups().filter(g => g.label !== 'Sections');
  }

  // Favorites: most-used blocks pinned at top; Default Content pushed to bottom
  const FAVORITES = ['custom-title','eyebrow-text','text-container','custom-image',
    'cta','linklist','accordion','hero-container','separator','story-card','carousel','quote'];

  // Reorder: Favorites first, then non-Default groups, Default Content last
  const defaultGroup  = groups.find(g => g.label === 'Default Content');
  const otherGroups   = groups.filter(g => g.label !== 'Default Content');
  const orderedGroups = [
    { label: 'Favorites', ids: FAVORITES },
    ...otherGroups,
    ...(defaultGroup ? [defaultGroup] : []),
  ];

  function pickerItem(id) {
    const comp = S.config?.compMap?.[id];
    if (!comp) return '';
    return `<div class="picker-item" data-pick="${id}">
      <span class="pi2-icon">${COMP_ICONS[id] || '□'}</span>
      <span class="pi2-label">${x(comp.title || id)}</span>
    </div>`;
  }

  const groupsHtml = orderedGroups.map(g => {
    const items = g.ids.map(pickerItem).join('');
    if (!items.trim()) return '';
    const isFav = g.label === 'Favorites';
    const isDefault = g.label === 'Default Content';
    const labelStyle = isFav
      ? 'color:#f59e0b;border-color:#fde68a'
      : isDefault
        ? 'color:var(--text-secondary);opacity:.7'
        : '';
    return `<div class="picker-group-title" style="${labelStyle}">${isFav ? '★ ' : ''}${g.label}</div>
      <div class="picker-grid">${items}</div>`;
  }).join('');

  return `<div class="modal-overlay" id="modal-overlay">
    <div class="modal modal-lg">
      <div class="modal-header">
        <h2>${title}</h2>
        <button class="modal-close" id="modal-close">✕</button>
      </div>
      <div class="modal-body">
        <input class="picker-search" id="picker-search" placeholder="Search EDS blocks…" autocomplete="off"/>
        <div id="picker-body">${groupsHtml}</div>
      </div>
    </div>
  </div>`;
}

// ── Save-as-template modal ────────────────────────────────────────────────────
function saveTemplateModalHtml() {
  const sec = findSec(S.saveTplSecId);
  const suggestedTitle = sec ? (S.config?.compMap?.[sec.type]?.title || sec.type) : '';
  return `<div class="modal-overlay" id="modal-overlay">
    <div class="modal" style="max-width:420px">
      <div class="modal-header">
        <h2>💾 Save as Template</h2>
        <button class="modal-close" id="modal-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="settings-field">
          <label>Template Name <span style="color:var(--error)">*</span></label>
          <input id="tpl-title" type="text" placeholder="e.g. Hero with Video" value="${x(suggestedTitle)}" autofocus/>
        </div>
        <div class="settings-field">
          <label>Description</label>
          <input id="tpl-desc" type="text" placeholder="Short description of when to use this"/>
        </div>
        <div id="tpl-alert"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost btn-sm" id="modal-close-btn">Cancel</button>
        <button class="btn btn-primary btn-sm" id="btn-save-tpl">Save Template</button>
      </div>
    </div>
  </div>`;
}

// Strip runtime IDs so the saved template is clean
function stripIds(node) {
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (node.blocks) out.blocks = node.blocks.map(b => stripIds(b));
  if (node.children) out.children = node.children.map(c => stripIds(c));
  return out;
}

async function doSaveTemplate() {
  const title = document.getElementById('tpl-title')?.value?.trim();
  const desc  = document.getElementById('tpl-desc')?.value?.trim() || '';
  const alertEl = document.getElementById('tpl-alert');
  if (!title) { if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">Name is required.</div>`; return; }

  const sec = findSec(S.saveTplSecId);
  if (!sec) return;

  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const payload = { id, title, description: desc, section: stripIds(sec) };

  if (alertEl) alertEl.innerHTML = `<div class="alert alert-info"><span class="spinner spinner-dark"></span> Saving…</div>`;
  try {
    const r = await fetch('/api/sections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Save failed');
    // Reload sections library
    const res = await fetch('/api/sections');
    if (res.ok) S.sectionsLib = await res.json();
    S.modal = null; S.saveTplSecId = null;
    render();
  } catch (e) {
    if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">${x(e.message)}</div>`;
  }
}

// ── Import from AEM page ──────────────────────────────────────────────────────
async function doImportPage() {
  const pagePath = document.getElementById('s-import-path')?.value?.trim();
  const alertEl  = document.getElementById('import-alert');
  if (!pagePath) { if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">Enter a page path.</div>`; return; }
  if (S.sections.length > 0 && !confirm('This will replace the current canvas with the imported page. Continue?')) return;

  S.conn.aemHost  = val('s-host');
  S.conn.username = val('s-user');
  S.conn.password = val('s-pass');

  if (alertEl) alertEl.innerHTML = `<div class="alert alert-info"><span class="spinner spinner-dark"></span> Fetching page…</div>`;
  try {
    const r = await fetch('/api/import-page', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aemHost: S.conn.aemHost, username: S.conn.username, password: S.conn.password, pagePath })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Import failed');
    // Recursively assign fresh IDs to items at any nesting depth.
    // Needed because grid-section stores actual blocks in .children, and those
    // blocks (e.g. text-container) themselves have child items (text-container-text).
    function assignImportIds(items) {
      return (items || []).map(item => ({ ...item, id: uid(), children: assignImportIds(item.children) }));
    }
    S.sections = data.sections.map(sec => ({
      ...sec, id: uid(),
      blocks: (sec.blocks || []).map(blk => ({
        ...blk, id: uid(),
        children: assignImportIds(blk.children)
      }))
    }));
    // Debug: log every text-container anywhere in the tree with its child count
    S.sections.forEach(sec => {
      (sec.blocks || []).forEach(blk => {
        if (blk.type === 'text-container')
          console.log('[import-debug] sec-level text-container children:', blk.children?.length, blk.children?.map(c=>c.type));
        (blk.children || []).forEach(ch => {
          if (ch.type === 'text-container')
            console.log('[import-debug] grid-child text-container children:', ch.children?.length, ch.children?.map(c=>c.type));
          (ch.children || []).forEach(sub => {
            if (sub.type === 'text-container')
              console.log('[import-debug] deep text-container children:', sub.children?.length, sub.children?.map(c=>c.type));
          });
        });
      });
    });
    // Snapshot for write-back diff — preserve _jcrKey on each section/block
    S._importSnapshot     = JSON.parse(JSON.stringify(S.sections));
    S._importMetaSnapshot = { ...S.meta };
    S._importPagePath     = pagePath;
    S._importedFromAem    = true;
    if (data.meta) Object.assign(S.meta, data.meta);
    S.collapsed.clear();
    S.modal = null;
    S.sel = S.sections.length > 0 ? { secId: S.sections[0].id } : null;
    render();
  } catch (e) {
    if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">${x(e.message)}</div>`;
  }
}

async function dodiagnosePage() {
  const pagePath = document.getElementById('s-import-path')?.value?.trim();
  const out      = document.getElementById('diagnose-out');
  const alertEl  = document.getElementById('import-alert');
  if (!pagePath) { if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">Enter a page path first.</div>`; return; }
  S.conn.aemHost  = val('s-host');
  S.conn.username = val('s-user');
  S.conn.password = val('s-pass');
  if (alertEl) alertEl.innerHTML = `<div class="alert alert-info"><span class="spinner spinner-dark"></span> Fetching raw structure…</div>`;
  if (out) { out.style.display = 'none'; out.textContent = ''; }
  try {
    const r = await fetch('/api/debug-page', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aemHost: S.conn.aemHost, username: S.conn.username, password: S.conn.password, pagePath })
    });
    const data = await r.json();
    if (alertEl) alertEl.innerHTML = '';
    if (out) { out.style.display = 'block'; out.textContent = JSON.stringify(data, null, 2); }
  } catch (e) {
    if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">${x(e.message)}</div>`;
  }
}

// ── Fill canvas blocks from uploaded JCR XML ─────────────────────────────────
async function doFillFromXml() {
  const fileInput = document.getElementById('s-migrate-file');
  const alertEl   = document.getElementById('migrate-alert');
  const file = fileInput?.files?.[0];
  if (!file) { if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">Select a JCR XML file first.</div>`; return; }
  if (S.sections.length === 0) { if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">Build your canvas structure first, then fill from XML.</div>`; return; }

  const fd = new FormData();
  fd.append('jcrFile', file);
  if (alertEl) alertEl.innerHTML = `<div class="alert alert-info"><span class="spinner spinner-dark"></span> Parsing XML…</div>`;
  try {
    const r    = await fetch('/api/parse-jcr-xml', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) {
      let msg = `<div class="alert alert-error"><strong>${x(data.error || 'Parse failed')}</strong>`;
      if (data.allResourceTypes?.length) {
        msg += `<br><br><strong>resourceTypes found in this XML</strong> (add content ones to migration-map.json):<br>`;
        msg += `<code style="font-size:.7rem;line-height:1.8">${data.allResourceTypes.map(x).join('<br>')}</code>`;
      }
      msg += `</div>`;
      if (alertEl) alertEl.innerHTML = msg;
      return;
    }

    if (data.meta) Object.assign(S.meta, data.meta);
    // Store pool for manual corrections, then auto-fill immediately
    S.xmlPool      = data.ordered || [];
    S._xmlFileName = file.name;
    S.modal = null;
    const { filled, skipped } = fillAllFromPool(/* silent */ true);
    S._migrResult = { filled, skipped, fileName: file.name };
    render();
  } catch (e) {
    if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">${x(e.message)}</div>`;
  }
}

// ── Pure fill: applies xmlPool items to a sections array (no side effects) ───
function fillSectionsFromPool(sections, xmlPool) {
  const pool = {};
  for (const comp of xmlPool) {
    (pool[comp.type] = pool[comp.type] || []).push({ props: comp.props, children: comp.children || [] });
  }
  const cursor = {};
  let filled = 0, skipped = 0;

  function fillBlock(blk) {
    const arr = pool[blk.type];
    if (arr?.length) {
      const rawSlot = blk.props?.xmlSlot;
      let src = null;
      if (rawSlot !== undefined && rawSlot !== null && rawSlot !== '') {
        const slotIdx = parseInt(rawSlot, 10);
        if (!isNaN(slotIdx) && slotIdx >= 0 && slotIdx < arr.length) src = arr[slotIdx];
      } else {
        if (cursor[blk.type] === undefined) cursor[blk.type] = 0;
        const idx = cursor[blk.type]++;
        if (idx < arr.length) src = arr[idx];
      }
      if (src) {
        Object.assign(blk.props, { ...src.props });
        if (src.children.length > 0)
          blk.children = src.children.map(ch => ({ ...ch, props: { ...ch.props }, id: uid(), children: [] }));
        filled++;
      } else {
        skipped++;
      }
    }
    for (const child of (blk.children || [])) fillBlock(child);
  }

  for (const sec of sections) {
    for (const blk of (sec.blocks || [])) fillBlock(blk);
  }
  normalizeCanvasBlocks(sections);   // separators/eyebrows normalized as part of filling — no manual step
  return { filled, skipped };
}

// ── Fill all canvas blocks from XML pool (auto sequential) ───────────────────
// Returns { filled, skipped }. Pass silent=true to keep S.xmlPool intact.
function fillAllFromPool(silent = false) {
  if (!S.xmlPool?.length) return { filled: 0, skipped: 0 };
  const { filled, skipped } = fillSectionsFromPool(S.sections, S.xmlPool);
  if (!silent) {
    S._migrResult = { filled, skipped, fileName: S._xmlFileName || '' };
    S.xmlPool     = null;
    render();
  }
  return { filled, skipped };
}

// ── Bulk Import ───────────────────────────────────────────────────────────────
async function doBulkProcess() {
  if (!S.bulkTemplate?.length) {
    document.getElementById('bulk-alert').innerHTML = `<div class="alert alert-error">Set a layout template first (Step 1).</div>`;
    return;
  }
  const fileInput = document.getElementById('bulk-xml-files');
  const basePath  = (document.getElementById('bulk-base-path')?.value || '').trim().replace(/\/$/, '');
  if (!fileInput?.files?.length) {
    document.getElementById('bulk-alert').innerHTML = `<div class="alert alert-error">Select at least one XML file.</div>`;
    return;
  }
  S._bulkBasePath = basePath;
  const alertEl = document.getElementById('bulk-alert');
  alertEl.innerHTML = `<div class="alert alert-info"><span class="spinner spinner-dark"></span> Parsing ${fileInput.files.length} file(s)…</div>`;

  const fd = new FormData();
  for (const f of fileInput.files) fd.append('xmlFiles', f);

  let data;
  try {
    const r = await fetch('/api/bulk-parse-xmls', { method: 'POST', body: fd });
    data = await r.json();
    if (!data.ok) throw new Error(data.error || 'Parse failed');
  } catch (e) {
    alertEl.innerHTML = `<div class="alert alert-error">${e.message}</div>`;
    return;
  }

  S.bulkPages = data.results.map(result => {
    if (!result.ok) return { fileName: result.fileName, slug: result.slug, pageTitle: result.fileName, edsPath: '', sections: [], filled: 0, skipped: 0, status: 'error', error: result.error };
    // Deep-clone the template and fill with this page's XML pool
    const sections = JSON.parse(JSON.stringify(S.bulkTemplate)).map(s => ({ ...s, id: uid(), blocks: (s.blocks||[]).map(b => ({ ...b, id: uid(), children: (b.children||[]).map(c => ({ ...c, id: uid() })) })) }));
    const { filled, skipped } = fillSectionsFromPool(sections, result.ordered);
    const edsPath = basePath ? `${basePath}/${result.slug}` : result.slug;
    return { fileName: result.fileName, slug: result.slug, pageTitle: result.pageTitle, edsPath, sections, filled, skipped, status: 'ready', error: null };
  });

  alertEl.innerHTML = `<div class="alert alert-success">✓ Processed ${S.bulkPages.length} page(s).</div>`;
  render();
}

// Load a whole folder of AEM pages (each direct subfolder = one page, named after
// the folder) and fill each from its own .content.xml against the current template.
async function doBulkLoadFolder() {
  const alertEl = document.getElementById('bulk-alert');
  if (!S.bulkTemplate?.length) { alertEl.innerHTML = `<div class="alert alert-error">Set a layout template first (Step 1).</div>`; return; }
  const folder   = (document.getElementById('bulk-folder')?.value || '').trim();
  const basePath = (document.getElementById('bulk-base-path')?.value || '').trim().replace(/\/$/, '');
  if (!folder) { alertEl.innerHTML = `<div class="alert alert-error">Enter a source folder.</div>`; return; }
  if (!basePath || !basePath.startsWith('/')) {
    alertEl.innerHTML = `<div class="alert alert-error">Enter an absolute <strong>Base EDS Path</strong> first (e.g. <code>/content/abbvie-nextgen-eds/corporate/abbvie-com/ch/de/who-we-are/our-leaders</code>) — pages are created under it.</div>`;
    return;
  }
  S._bulkFolder = folder; S._bulkBasePath = basePath;
  alertEl.innerHTML = `<div class="alert alert-info"><span class="spinner spinner-dark"></span> Reading folder…</div>`;

  let data;
  try {
    const r = await fetch('/api/bulk-parse-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) });
    data = await r.json();
    if (!data.ok) throw new Error(data.error || 'Read failed');
  } catch (e) { alertEl.innerHTML = `<div class="alert alert-error">${x(e.message)}</div>`; return; }

  if (!data.results.length) { alertEl.innerHTML = `<div class="alert alert-error">No pages found (no subfolders with a .content.xml) in "${x(folder)}".</div>`; return; }

  S.bulkPages = data.results.map(result => {
    if (!result.ok) return { fileName: result.folderName, slug: result.slug, pageTitle: result.folderName, meta: {}, edsPath: '', sections: [], filled: 0, skipped: 0, status: 'error', error: result.error };
    const sections = JSON.parse(JSON.stringify(S.bulkTemplate)).map(s => ({ ...s, id: uid(), blocks: (s.blocks||[]).map(b => ({ ...b, id: uid(), children: (b.children||[]).map(c => ({ ...c, id: uid() })) })) }));
    const { filled, skipped } = fillSectionsFromPool(sections, result.ordered);
    const edsPath = basePath ? `${basePath}/${result.slug}` : result.slug;
    return { fileName: result.folderName, slug: result.slug, pageTitle: result.pageTitle, meta: result.meta || {}, edsPath, sections, filled, skipped, status: 'ready', error: null };
  });
  alertEl.innerHTML = `<div class="alert alert-success">✓ Loaded ${S.bulkPages.length} page(s) from folder. Review paths, then Publish.</div>`;
  render();
}

async function doBulkPublishOne(idx) {
  const page = S.bulkPages[idx];
  if (!page || page.status === 'publishing') return;
  const { aemHost, username, password } = S.conn;
  if (!aemHost || !username || !password) { alert('Configure AEM connection in the Connection tab first.'); return; }
  const clean = (page.edsPath || '').trim().replace(/\/+$/, '');
  const cut   = clean.lastIndexOf('/');
  if (!clean.startsWith('/') || cut <= 0 || cut === clean.length - 1) {
    page.status = 'error';
    page.error  = `EDS path must be a full path like /content/.../parent/${page.slug} — set the Base EDS Path and reload the folder.`;
    render(); return;
  }
  const parentPath = clean.slice(0, cut);
  const pageName   = clean.slice(cut + 1);

  page.status = 'publishing';
  render();

  try {
    // Create the page properly: page shell + full content import (same as Create Page).
    const meta = (page.meta && Object.keys(page.meta).length) ? page.meta : (page.pageTitle ? { 'jcr:title': page.pageTitle } : {});
    const r = await fetch('/api/pages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aemHost, username, password, parentPath, pageName, meta, sections: page.sections })
    });
    const data = await r.json();
    if (data.ok) { page.status = 'done'; page.error = null; page.authorUrl = buildUeUrl(data.path); }
    else { page.status = 'error'; page.error = data.error || 'Create failed'; }
  } catch (e) {
    page.status = 'error';
    page.error  = e.message;
  }
  render();
}

async function doBulkPublishAll() {
  const ready = S.bulkPages.map((p, i) => ({ p, i })).filter(({ p }) => p.status === 'ready' || p.status === 'error');
  if (!ready.length) { alert('No pages with Ready or Error status to publish.'); return; }
  for (const { i } of ready) await doBulkPublishOne(i);
}

function buildBulkChanges(page) {
  const jcrBase = `${page.edsPath}/jcr:content/root`;
  const changes = [];
  for (const sec of page.sections) {
    const secPath = `${jcrBase}/${sec._jcrKey || sec.id}`;
    changes.push({ jcrPath: secPath, blockType: sec.type, isNew: true, newProps: sec.props || {} });
    for (const blk of (sec.blocks || [])) {
      const blkPath = `${secPath}/${blk._jcrKey || blk.id}`;
      changes.push({ jcrPath: blkPath, blockType: blk.type, isNew: true, newProps: blk.props || {} });
      for (const ch of (blk.children || [])) {
        const chPath = `${blkPath}/${ch._jcrKey || ch.id}`;
        changes.push({ jcrPath: chPath, blockType: ch.type, isNew: true, newProps: ch.props || {} });
      }
    }
  }
  return changes;
}

// ── Generate short text preview for an XML pool item ─────────────────────────
function xmlItemPreview(item) {
  const p = item.props || {};
  const strip = v => String(v).replace(/<[^>]+>/g, '').trim();

  // 1. Priority content fields (order matters — most descriptive first)
  for (const k of ['title','summary','linkText','heading','name']) {
    if (p[k] && typeof p[k] === 'string') return strip(p[k]).slice(0, 60);
  }
  // 2. Rich text (strip HTML)
  if (p.text) { const t = strip(p.text); if (t) return t.slice(0, 60); }
  // 3. Media / link fields
  if (p.imageAlt)  return '🖼 ' + strip(p.imageAlt).slice(0, 55);
  if (p.image)     return '🖼 ' + p.image.split('/').pop().slice(0, 55);
  for (const k of ['link','path','page','fileReference','src']) {
    if (p[k] && typeof p[k] === 'string') return '🔗 ' + p[k].slice(0, 55);
  }
  // 4. Check child blocks for text (e.g. text-container → text-container-text)
  for (const ch of (item.children || [])) {
    const cp = ch.props || {};
    for (const k of ['text','title','summary','linkText']) {
      if (cp[k]) { const t = strip(cp[k]); if (t) return t.slice(0, 60); }
    }
  }
  // 5. CSS classes as fallback — meaningful for structural/decorator blocks (separator, divider)
  for (const k of Object.keys(p)) {
    if ((k.startsWith('classes_') || k === 'classes') && p[k] && typeof p[k] === 'string')
      return p[k].slice(0, 55);
  }
  // 6. Any non-system, non-boolean, non-empty string prop
  for (const [k, v] of Object.entries(p)) {
    if (k.startsWith('cq:') || k.startsWith('style_') || typeof v !== 'string' || !v.trim()) continue;
    return `${k}: ${strip(v).slice(0, 50)}`;
  }
  const childCount = (item.children || []).length;
  if (childCount) return `${childCount} item${childCount > 1 ? 's' : ''}`;
  return `[${item.type}]`;
}

// ── Apply a specific XML pool item to a canvas block ─────────────────────────
function applyXmlItem(itemId, poolIdx) {
  const src = S.xmlPool?.[poolIdx];
  if (!src) return;

  let target = null;
  outer: for (const sec of S.sections) {
    if (sec.id === itemId) { target = sec; break; }
    for (const blk of (sec.blocks || [])) {
      if (blk.id === itemId) { target = blk; break outer; }
      for (const ch of (blk.children || [])) {
        if (ch.id === itemId) { target = ch; break outer; }
      }
    }
  }
  if (!target) return;

  Object.assign(target.props, { ...src.props });
  if ((src.children || []).length > 0) {
    target.children = src.children.map(ch => ({ ...ch, props: { ...ch.props }, id: uid(), children: [] }));
  }
  saveCanvas();
  render();
}

// ── Build canvas from XML ─────────────────────────────────────────────────────
// ── Bundle save modal ─────────────────────────────────────────────────────────
function bundleSaveModalHtml() {
  const rows = S.sections.map((sec, i) => {
    const label = S.config?.compMap?.[sec.type]?.title || sec.type;
    const hint  = getPropHint(sec) || '';
    return `<label class="bndl-sec-item">
      <input type="checkbox" name="bndl-sec" value="${sec.id}" checked>
      <span class="bndl-sec-num">${i + 1}</span>
      <span class="bndl-sec-label">${x(label)}${hint ? ` <em>— ${x(hint)}</em>` : ''}</span>
    </label>`;
  }).join('');

  return `<div class="modal-overlay" id="modal-overlay">
    <div class="modal" style="max-width:480px">
      <div class="modal-header">
        <h2>💾 Save as Template</h2>
        <button class="modal-close" id="modal-close">✕</button>
      </div>
      <div class="modal-body">
        <div class="settings-field">
          <label>Template Name <span style="color:var(--error)">*</span></label>
          <input id="bndl-title" type="text" placeholder="e.g. Hero + Intro + CTA" autofocus/>
        </div>
        <div class="settings-field">
          <label>Description</label>
          <input id="bndl-desc" type="text" placeholder="Short description of when to use this"/>
        </div>
        <div class="settings-field">
          <label style="margin-bottom:6px">Sections to include</label>
          <div class="bndl-section-list">${rows}</div>
        </div>
        <div id="bndl-alert"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost btn-sm" id="modal-close-btn">Cancel</button>
        <button class="btn btn-primary btn-sm" id="btn-do-bundle-save">Save Template</button>
      </div>
    </div>
  </div>`;
}

async function doBundleSave() {
  const title   = document.getElementById('bndl-title')?.value?.trim();
  const desc    = document.getElementById('bndl-desc')?.value?.trim() || '';
  const alertEl = document.getElementById('bndl-alert');
  if (!title) { if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">Name is required.</div>`; return; }

  const checkedIds = Array.from(document.querySelectorAll('[name="bndl-sec"]:checked')).map(el => el.value);
  if (!checkedIds.length) { if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">Select at least one section.</div>`; return; }

  const selected = checkedIds.map(id => findSec(id)).filter(Boolean);
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const payload = selected.length === 1
    ? { id, title, description: desc, section: stripIds(selected[0]) }
    : { id, title, description: desc, sections: selected.map(stripIds) };

  if (alertEl) alertEl.innerHTML = `<div class="alert alert-info"><span class="spinner spinner-dark"></span> Saving…</div>`;
  try {
    const r = await fetch('/api/sections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Save failed');
    const res = await fetch('/api/sections');
    if (res.ok) S.sectionsLib = await res.json();
    S.modal = null;
    render();
  } catch (e) {
    if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">${x(e.message)}</div>`;
  }
}

// ── Result overlay ────────────────────────────────────────────────────────────
function resultOverlayHtml() {
  const r = S.result;
  if (!r.ok) return `<div class="result-overlay">
    <div class="result-box">
      <div class="rb-icon">❌</div>
      <h2>Page creation failed</h2>
      <p>${x(r.error || 'Unknown error')}</p>
      <div class="rb-actions"><button class="btn btn-primary" id="btn-close-result">Close</button></div>
    </div>
  </div>`;

  const authorUrl = safeAuthoringUrl(buildUeUrl(r.path));
  return `<div class="result-overlay">
    <div class="result-box">
      <div class="rb-icon">🎉</div>
      <h2>Page Created!</h2>
      <p style="font-size:.82rem;word-break:break-all;color:var(--muted)">${x(r.path)}</p>
      <div class="rb-actions">
        ${authorUrl ? `<a class="btn btn-primary" href="${x(authorUrl)}" target="_blank" rel="noopener noreferrer">↗ Open in authoring</a>` : ''}
        <button class="btn btn-ghost" id="btn-close-result">Close</button>
      </div>
    </div>
  </div>`;
}

function safeAuthoringUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (_) {
    return '';
  }
}

function openAuthoringPage(value) {
  const url = safeAuthoringUrl(value);
  if (!url) { alert('The created page does not have a valid AEM authoring URL.'); return; }
  const tab = window.open(url, '_blank', 'noopener,noreferrer');
  if (tab) tab.opener = null;
}

// ── Events ────────────────────────────────────────────────────────────────────
function bind() {
  // Topbar
  on('btn-create', 'click', doCreate);
  on('btn-preview', 'click', doPreview);
  on('btn-preview-page', 'click', doPreviewPage);
  on('btn-mig-save-canvas', 'click', doMigSaveCanvas);   // review banner (canvas view)
  on('btn-fill-a11y', 'click', doFillA11yCanvas);        // review banner: fill a11y without rebuild
  on('btn-publish-aem', 'click', () => {
    const changes = computeJcrDiff();
    if (!changes.length) { alert('No changes since the page was imported.'); return; }
    S._publishChanges = changes;
    S.modal = 'publish-aem';
    render();
  });
  on('btn-pub-cancel',  'click', () => { S.modal = null; render(); });
  on('btn-pub-cancel2', 'click', () => { S.modal = null; render(); });
  on('btn-pub-confirm', 'click', async () => {
    const checked = [...document.querySelectorAll('.pub-chk:checked')].map(el => Number(el.dataset.idx));
    const toWrite = (S._publishChanges || []).filter((_, i) => checked.includes(i));
    if (!toWrite.length) { S.modal = null; render(); return; }
    const btn = document.getElementById('btn-pub-confirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Writing…'; }
    try {
      const r = await fetch('/api/write-to-aem', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aemHost: S.conn.aemHost, username: S.conn.username, password: S.conn.password, changes: toWrite })
      });
      const data = await r.json();
      const failed = (data.results || []).filter(r => !r.ok);
      if (failed.length) {
        alert(`${toWrite.length - failed.length} node(s) written. ${failed.length} failed:\n${failed.map(f => f.jcrPath + ' (' + (f.error || f.status) + ')').join('\n')}`);
      } else {
        // Update snapshot so the diff clears for written nodes
        const writtenPaths = new Set(toWrite.map(c => c.jcrPath));
        const base = `${S._importPagePath}/jcr:content/root`;
        // Update meta snapshot
        if (writtenPaths.has(`${S._importPagePath}/jcr:content`) && S._importMetaSnapshot)
          S._importMetaSnapshot = { ...S.meta };
        for (const sec of S.sections) {
          if (writtenPaths.has(`${base}/${sec._jcrKey}`)) {
            const snap = S._importSnapshot.find(s => s._jcrKey === sec._jcrKey);
            if (snap) snap.props = JSON.parse(JSON.stringify(sec.props));
          }
          for (const blk of sec.blocks || []) {
            if (writtenPaths.has(`${base}/${sec._jcrKey}/${blk._jcrKey}`)) {
              const snapSec = S._importSnapshot.find(s => s._jcrKey === sec._jcrKey);
              const snapBlk = snapSec?.blocks?.find(b => b._jcrKey === blk._jcrKey);
              if (snapBlk) snapBlk.props = JSON.parse(JSON.stringify(blk.props));
            }
          }
        }
        S.modal = null;
        render();
        // Show brief success banner
        const el = document.getElementById('import-alert');
        if (el) { el.innerHTML = `<div class="alert alert-success">✓ ${toWrite.length} node${toWrite.length !== 1 ? 's' : ''} written to AEM.</div>`; setTimeout(() => { el.innerHTML = ''; }, 4000); }
      }
    } catch (e) {
      alert('Write failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; }
    }
  });
  on('vtab-canvas',   'click', () => { _view = 'canvas';   render(); });
  on('vtab-settings', 'click', () => { _view = 'settings'; render(); });
  on('vtab-help',     'click', () => { _view = 'help';     render(); });
  on('btn-clear-draft', 'click', () => {
    if (!confirm('Clear all sections and start fresh?')) return;
    S.sections = []; S.meta = {}; S.collapsed.clear(); S.sel = null;
    S._importedFromAem = false; S._importSnapshot = null; S._importPagePath = null; S._importMetaSnapshot = null;
    localStorage.removeItem(CANVAS_KEY);
    render();
  });
  on('btn-dismiss-draft',       'click', () => { S._draftRestored = false; render(); });
  on('btn-dismiss-migr',        'click', () => { S._migrResult = null; render(); });

  // Canvas
  on('btn-add-section', 'click', () => addSection('section'));

  // Palette tabs
  qAll('[data-ptab]').forEach(el =>
    el.addEventListener('click', () => { S.paletteTab = el.dataset.ptab; render(); }));

  // Section search — re-render only the palette content area
  const slcSearch = document.getElementById('slc-search');
  if (slcSearch) {
    slcSearch.addEventListener('input', e => {
      _slcSearch = e.target.value;
      const wrap = document.querySelector('.slc-scroll');
      const searchWrap = document.querySelector('.slc-search-wrap');
      if (!wrap || !searchWrap) return;
      // Re-render just the scroll area without losing focus
      const q = _slcSearch.toLowerCase().trim();
      const filtered = q
        ? S.sectionsLib.filter(d => d.title.toLowerCase().includes(q) || (d.description||'').toLowerCase().includes(q))
        : S.sectionsLib;
      const groups = {};
      for (const def of filtered) { const cat = sectionCategory(def); (groups[cat] = groups[cat] || []).push(def); }
      const CAT_ORDER = ['Hero','Article','Grid','Content','Video','Cards','CTA','FAQ','Quote','Related'];
      wrap.innerHTML = filtered.length
        ? CAT_ORDER.filter(c => groups[c]).map(cat => `
            <div class="slc-group">
              <div class="slc-group-header">${cat} <span class="slc-group-count">${groups[cat].length}</span></div>
              <div class="section-lib-grid">${groups[cat].map(sectionCardHtml).join('')}</div>
            </div>`).join('')
        : '<div class="lib-empty">No sections match.</div>';
      // Re-bind card clicks
      wrap.querySelectorAll('[data-preview-section]').forEach(btn =>
        btn.addEventListener('click', e => { e.stopPropagation(); openSectionPreview(btn.dataset.previewSection); }));
      wrap.querySelectorAll('[data-add-section]').forEach(el =>
        el.addEventListener('click', () => {
          const def = S.sectionsLib.find(d => d.id === el.dataset.addSection);
          if (!def) return;
          const secs = hydrateDef(def);
          secs.forEach(s => S.sections.push(s));
          S.sel = { secId: secs[0].id }; render();
        }));
    });
  }

  // Section library — preview button (eye icon)
  qAll('[data-preview-section]').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); openSectionPreview(btn.dataset.previewSection); }));

  // Section library — add predefined section (single or multi-section bundle)
  qAll('[data-add-section]').forEach(el =>
    el.addEventListener('click', () => {
      const def = S.sectionsLib.find(d => d.id === el.dataset.addSection);
      if (!def) return;
      const secs = hydrateDef(def);
      secs.forEach(s => S.sections.push(s));
      S.sel = { secId: secs[0].id };
      render();
    }));

  // Palette — click to add section or block
  qAll('.palette-item[data-add]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.add;
      if (['section','grid-container','grid-section'].includes(id)) {
        addSection(id);
      } else {
        // Add block to last section, or open picker if no sections
        if (S.sections.length === 0) { addSection('section'); }
        const sec = S.sections[S.sections.length - 1];
        addBlock(sec.id, id);
        S.sel = { secId: sec.id, blkId: sec.blocks[sec.blocks.length - 1].id };
        render();
      }
    });
  });

  // Section select / move / delete
  qAll('[data-sel-sec]').forEach(el =>
    el.addEventListener('click', e => {
      if (e.target.closest('[data-del-sec],[data-move-sec],[data-save-tpl],[data-tag-rem],[data-tag-inp],[data-toggle-sec]')) return;
      S.sel = { secId: el.dataset.selSec };
      render();
    }));

  qAll('[data-toggle-sec]').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.toggleSec;
      if (S.collapsed.has(id)) S.collapsed.delete(id);
      else S.collapsed.add(id);
      render();
    }));

  qAll('[data-del-sec]').forEach(el =>
    el.addEventListener('click', e => {
      e.stopPropagation();
      S.sections = S.sections.filter(s => s.id !== el.dataset.delSec);
      if (S.sel?.secId === el.dataset.delSec) S.sel = null;
      render();
    }));

  qAll('[data-move-sec]').forEach(el =>
    el.addEventListener('click', e => {
      e.stopPropagation();
      moveSection(el.dataset.moveSec, +el.dataset.dir);
    }));

  // Block select / move / delete
  qAll('[data-sel-blk]').forEach(el =>
    el.addEventListener('click', e => {
      if (e.target.closest('[data-del-blk],[data-move-blk],[data-dup-blk],[data-pick-child],[data-sel-child]')) return;
      S.sel = { secId: el.dataset.sec, blkId: el.dataset.selBlk };
      render();
    }));

  qAll('[data-del-blk]').forEach(el =>
    el.addEventListener('click', e => {
      e.stopPropagation();
      deleteBlock(el.dataset.sec, el.dataset.delBlk);
    }));

  qAll('[data-move-blk]').forEach(el =>
    el.addEventListener('click', e => {
      e.stopPropagation();
      moveBlock(el.dataset.sec, el.dataset.moveBlk, +el.dataset.dir);
    }));

  // Child select / delete
  qAll('[data-sel-child]').forEach(el =>
    el.addEventListener('click', e => {
      if (e.target.closest('[data-del-child]')) return;
      if (e.target !== el && e.target.closest('[data-sel-child]') !== el) return; // inner chip handles it
      e.stopPropagation();
      S.sel = { secId: findSecIdForBlk(el.dataset.blk), blkId: el.dataset.blk, childId: el.dataset.selChild };
      render();
    }));

  qAll('[data-del-child]').forEach(el =>
    el.addEventListener('click', e => {
      e.stopPropagation();
      const blk = findBlk(el.dataset.blk);
      if (blk) blk.children = blk.children.filter(c => c.id !== el.dataset.delChild);
      if (S.sel?.childId === el.dataset.delChild) S.sel = { secId: S.sel.secId, blkId: el.dataset.blk };
      render();
    }));

  // Duplicate section / block / child
  qAll('[data-dup-sec]').forEach(el =>
    el.addEventListener('click', e => { e.stopPropagation(); duplicateSection(el.dataset.dupSec); }));

  qAll('[data-dup-blk]').forEach(el =>
    el.addEventListener('click', e => { e.stopPropagation(); duplicateBlock(el.dataset.sec, el.dataset.dupBlk); }));

  qAll('[data-dup-child]').forEach(el =>
    el.addEventListener('click', e => { e.stopPropagation(); duplicateChild(el.dataset.sec, el.dataset.blk, el.dataset.dupChild); }));

  // Grid-container: add a grid-section column directly (no picker)
  qAll('[data-add-col]').forEach(el =>
    el.addEventListener('click', () => {
      const secId = el.dataset.addCol;
      addBlock(secId, 'grid-section');
      const sec = findSec(secId);
      if (sec) S.sel = { secId, blkId: sec.blocks[sec.blocks.length - 1].id };
      render();
    }));

  // Block picker triggers
  qAll('[data-pick-block]').forEach(el =>
    el.addEventListener('click', () => { S.pickCtx = { secId: el.dataset.pickBlock }; S.modal = 'block-picker'; render(); }));

  qAll('[data-pick-child]').forEach(el =>
    el.addEventListener('click', e => {
      e.stopPropagation();
      S.pickCtx = { secId: el.dataset.sec, blkId: el.dataset.pickChild };
      S.modal = 'block-picker';
      render();
    }));

  // Tag editor — remove pill
  qAll('.tag-remove').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const sec = findSec(btn.dataset.tagSec);
      if (!sec) return;
      const classes = (sec.props.style_customDynamicClass || '').split(',').map(c => c.trim()).filter(Boolean);
      sec.props.style_customDynamicClass = classes.filter(c => c !== btn.dataset.tagRem).join(',');
      render();
    }));

  // Tag editor — add class on Enter or comma
  qAll('.tag-input').forEach(inp =>
    inp.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ',') return;
      e.preventDefault();
      const cls   = inp.value.replace(/,/g, '').trim();
      const secId = inp.dataset.tagInp;
      if (!cls) return;
      const sec = findSec(secId);
      if (!sec) return;
      const classes = (sec.props.style_customDynamicClass || '').split(',').map(c => c.trim()).filter(Boolean);
      if (!classes.includes(cls)) { classes.push(cls); sec.props.style_customDynamicClass = classes.join(','); }
      render();
      setTimeout(() => document.querySelector(`.tag-input[data-tag-inp="${secId}"]`)?.focus(), 0);
    }));

  // Modal close
  on('modal-close', 'click', closeModal);
  on('modal-overlay', 'click', e => { if (e.target.id === 'modal-overlay') closeModal(); });

  // Settings modal
  on('btn-save-settings', 'click', saveSettings);
  on('btn-test-conn',     'click', testConn);
  on('btn-import-page',   'click', doImportPage);
  on('btn-diagnose-page', 'click', dodiagnosePage);
  on('btn-fill-xml',   'click', doFillFromXml);

  // Bulk import tab
  on('btn-set-bulk-template', 'click', () => {
    if (!S.sections.length) { alert('Canvas is empty — build a layout first.'); return; }
    S.bulkTemplate = JSON.parse(JSON.stringify(S.sections));
    render();
  });
  on('btn-bulk-process',     'click', doBulkProcess);
  on('btn-bulk-load-folder', 'click', doBulkLoadFolder);
  on('btn-bulk-publish-all', 'click', doBulkPublishAll);
  on('btn-bulk-clear',       'click', () => { S.bulkPages = []; render(); });

  // Per-row publish buttons
  document.querySelectorAll('[data-bulk-pub]').forEach(el =>
    el.addEventListener('click', () => doBulkPublishOne(Number(el.dataset.bulkPub))));
  document.querySelectorAll('[data-bulk-open-author]').forEach(el =>
    el.addEventListener('click', () => openAuthoringPage(S.bulkPages[Number(el.dataset.bulkOpenAuthor)]?.authorUrl)));

  // Editable EDS path per row
  document.querySelectorAll('.bulk-path-input').forEach(el =>
    el.addEventListener('change', () => {
      const i = Number(el.dataset.bulkIdx);
      if (S.bulkPages[i]) S.bulkPages[i].edsPath = el.value.trim();
    }));

  on('stab-settings', 'click', () => { _settingsTab = 'connection'; render(); });
  on('stab-mappings', 'click', () => { _settingsTab = 'mappings';   render(); });
  on('stab-paths',    'click', () => { _settingsTab = 'paths';      render(); });
  on('stab-bulk',     'click', () => { _settingsTab = 'bulk';       render(); });
  on('stab-similar',  'click', () => { _settingsTab = 'similar';    render(); if (!S.findSimilar.info) vsimLoadInfo(); });
  on('stab-migsite',  'click', () => { _settingsTab = 'migsite';    render(); if (!S.findSimilar.info) vsimLoadInfo(); });

  // Migrate Full Site tab
  if (_settingsTab === 'migsite') {
    if (!S.findSimilar.info) vsimLoadInfo();
    on('btn-ms-detect', 'click', doDetectMigratedRegions);
    on('btn-ms-region-all',  'click', () => { const info = S.findSimilar.info; S.migrateSite.regionSel = (info && info.regions) ? info.regions.slice() : S.migrateSite.regionSel; render(); });
    on('btn-ms-region-none', 'click', () => { S.migrateSite.regionSel = []; render(); });
    on('ms-region-search', 'input', e => {
      const q = e.target.value.trim().toLowerCase();
      qAll('#ms-region-grid .ms-region-chk').forEach(l => { l.style.display = (!q || l.textContent.toLowerCase().includes(q)) ? '' : 'none'; });
    });
    qAll('.ms-region').forEach(el => el.addEventListener('change', () => {
      const set = new Set(S.migrateSite.regionSel);
      if (el.checked) set.add(el.value); else set.delete(el.value);
      S.migrateSite.regionSel = [...set];
      const c = document.getElementById('ms-region-count'); if (c) c.textContent = `${S.migrateSite.regionSel.length} selected`;
    }));
    on('btn-ms-clear-plan', 'click', () => {
      if (!confirm('Clear the migration plan and all progress? This cannot be undone.')) return;
      S.migrateSite.plan = null; S.migrateSite.error = null;
      localStorage.removeItem(MIGRATE_KEY);
      render();
    });
    on('btn-ms-plan', 'click', doBuildMigratePlan);
    { const el = document.getElementById('ms-livebase'); if (el) el.addEventListener('change', () => { S.migrateSite.liveBase = el.value.trim(); }); }
    { const el = document.getElementById('ms-a11y'); if (el) el.addEventListener('change', () => { S.migrateSite.a11yBackfill = el.checked; }); }
    on('btn-mig-prepare-all', 'click', doMigPrepareAll);
    on('btn-mig-autobuild-nomatch', 'click', doMigAutoBuildNoMatch);
    on('btn-mig-create-all', 'click', doMigCreateAll);
    qAll('[data-mig-prepare]').forEach(el => el.addEventListener('click', () => doMigPrepareOne(Number(el.dataset.migPrepare))));
    qAll('[data-mig-autobuild]').forEach(el => el.addEventListener('click', () => doMigAutoBuild(Number(el.dataset.migAutobuild))));
    qAll('[data-mig-usecanvas]').forEach(el => el.addEventListener('click', () => doMigUseCurrentCanvas(Number(el.dataset.migUsecanvas))));
    qAll('[data-mig-preview]').forEach(el => el.addEventListener('click', () => doMigPreviewOne(Number(el.dataset.migPreview))));
    qAll('[data-mig-preview-page]').forEach(el => el.addEventListener('click', () => doMigPreviewPageOne(Number(el.dataset.migPreviewPage))));
    qAll('[data-mig-check]').forEach(el => el.addEventListener('click', () => doMigCheckCanvas(Number(el.dataset.migCheck))));
    qAll('[data-mig-create]').forEach(el => el.addEventListener('click', () => doMigCreateOne(Number(el.dataset.migCreate))));
    qAll('[data-mig-open-author]').forEach(el => el.addEventListener('click', () => openAuthoringPage(S.migrateSite.plan?.rows[Number(el.dataset.migOpenAuthor)]?.authorUrl)));
    qAll('[data-mig-validate]').forEach(el => el.addEventListener('click', () => doValidateOne(Number(el.dataset.migValidate))));
    qAll('[data-mig-compare]').forEach(el => el.addEventListener('click', () => {
      const i = Number(el.dataset.migCompare);
      const r = S.migrateSite.plan?.rows[i];
      if (!r) return;
      const liveUrl = liveUrlFor(r.sourceRel);
      const migratedUrl = r.targetPath ? `${(S.conn.aemHost || '').replace(/\/+$/, '')}${r.targetPath}.html` : '';
      if (!liveUrl) { alert('Set the Live AEM base URL in the Migrate Full Site config first.'); return; }
      if (!migratedUrl) { alert('Set the "Create at" path for this row first.'); return; }
      S.compareModal = { liveUrl, migratedUrl, canon: r.canon || '' };
      render();
      setTimeout(setupCompareScrollSync, 800);
    }));
    qAll('[data-show-validation]').forEach(el => el.addEventListener('click', () => {
      const i = Number(el.dataset.showValidation);
      const r = S.migrateSite.plan?.rows[i];
      if (r?.validation) { S._validationDetail = { rowIdx: i, validation: r.validation }; S.modal = 'validation-detail'; render(); }
    }));
    qAll('.mig-match').forEach(el => el.addEventListener('change', () => { const i = Number(el.dataset.migIdx); if (S.migrateSite.plan) S.migrateSite.plan.rows[i].selIdx = Number(el.value); }));
    qAll('.mig-target').forEach(el => el.addEventListener('change', () => { const i = Number(el.dataset.migIdx); if (S.migrateSite.plan) S.migrateSite.plan.rows[i].targetPath = el.value.trim(); }));
    qAll('.mig-custom').forEach(el => el.addEventListener('change', () => { const i = Number(el.dataset.migIdx); if (S.migrateSite.plan) S.migrateSite.plan.rows[i].customPath = el.value.trim(); }));
  }

  // Find Similar tab
  if (_settingsTab === 'similar') {
    if (!S.findSimilar.info) vsimLoadInfo();
    on('btn-sim-run',     'click', doSimilarRun);
    on('btn-sim-rebuild', 'click', () => vsimLoadInfo(true));
    qAll('[data-sim-mode]').forEach(el => el.addEventListener('click', () => {
      S.findSimilar.mode = el.dataset.simMode; S.findSimilar.result = null; S.findSimilar.error = null; S.findSimilar.expanded = {}; render();
    }));
    qAll('[data-sim-page]').forEach(el => el.addEventListener('click', () => toggleSitePage(el.dataset.simPage)));
  }
  on('stab-styles',   'click', async () => {
    _settingsTab = 'styles';
    if (!_styleEntries) {
      const res = await fetch('/api/style-map');
      _styleEntries = await res.json();
    }
    render();
  });
  on('stab-thumbs',   'click', () => { _settingsTab = 'thumbs';     render(); });

  // Paths tab
  if (_settingsTab === 'paths') {
    on('btn-add-content-rule', 'click', () => {
      if (!S.pathMap) S.pathMap = { contentPrefixRules: [], damPrefixRules: [], assetMap: [] };
      S.pathMap.contentPrefixRules.push({ aemPrefix: '', edsPrefix: '' });
      render();
    });
    on('btn-add-dam-rule', 'click', () => {
      if (!S.pathMap) S.pathMap = { contentPrefixRules: [], damPrefixRules: [], assetMap: [] };
      S.pathMap.damPrefixRules.push({ aemPrefix: '', edsPrefix: '' });
      render();
    });
    qAll('.pm-del-rule').forEach(el => el.addEventListener('click', () => {
      const section = el.dataset.section;
      const idx     = parseInt(el.dataset.idx, 10);
      if (S.pathMap?.[section]) { S.pathMap[section].splice(idx, 1); render(); }
    }));
    qAll('.pm-aem-inp').forEach(el => el.addEventListener('input', () => {
      const section = el.dataset.section;
      const idx     = parseInt(el.dataset.idx, 10);
      if (S.pathMap?.[section]?.[idx]) S.pathMap[section][idx].aemPrefix = el.value;
    }));
    qAll('.pm-eds-inp').forEach(el => el.addEventListener('input', () => {
      const section = el.dataset.section;
      const idx     = parseInt(el.dataset.idx, 10);
      if (S.pathMap?.[section]?.[idx]) S.pathMap[section][idx].edsPrefix = el.value;
    }));
    on('btn-import-csv', 'click', doImportPathCsv);
    on('btn-clear-asset-map', 'click', () => {
      if (confirm('Clear all asset mappings?')) {
        if (S.pathMap) { S.pathMap.assetMap = {}; render(); }
      }
    });
    on('btn-save-paths', 'click', savePathMap);
  }

  // Styles tab
  if (_settingsTab === 'styles') {
    on('btn-build-style-map', 'click', buildStyleMap);
    on('btn-save-style-map',  'click', saveStyleMap);
  }

  // Thumbnails tab
  if (_settingsTab === 'thumbs') {
    on('btn-copy-order', 'click', () => {
      const CAT_ORD = ['Hero','Article','Grid','Content','Video','Cards','CTA','FAQ','Quote','Related'];
      const groups  = {};
      for (const def of S.sectionsLib) { const c = sectionCategory(def); (groups[c] = groups[c] || []).push(def); }
      const ordered = CAT_ORD.filter(c => groups[c]).flatMap(c => groups[c]);
      navigator.clipboard.writeText(ordered.map((d, i) => `${i + 1}. ${d.id}`).join('\n'))
        .then(() => { const b = document.getElementById('btn-copy-order'); if (b) { b.textContent = '✓ Copied'; setTimeout(() => { b.textContent = 'Copy list'; }, 1500); } });
    });
    on('btn-auto-generate-thumbs', 'click', doAutoGenerateThumbs);
    on('btn-capture-thumbs', 'click', doCaptureThumbsFrom);
    qAll('[data-thumb-gen]').forEach(btn =>
      btn.addEventListener('click', () => doGenerateSingleThumb(btn.dataset.thumbGen)));
    // Per-section file upload
    qAll('[data-thumb-upload]').forEach(input => {
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        await doUploadThumb(input.dataset.thumbUpload, file);
        input.value = '';
      });
    });
    // Delete thumbnail
    qAll('.thumb-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        await fetch(`/api/section-thumbs/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const sec = S.sectionsLib.find(d => d.id === id);
        if (sec) delete sec.thumbnailUrl;
        render();
      });
    });
  }

  // Mapping tab
  on('btn-save-mapping', 'click', saveMigrationMap);
  on('btn-run-analysis', 'click', runMappingAnalysis);
  on('btn-apply-analysis', 'click', applyMappingAnalysis);
  on('ma-chk-all', 'change', () => {
    const chkAll = document.getElementById('ma-chk-all');
    if (!S._mappingAnalysis || !chkAll) return;
    S._mappingAnalysis.suggestions.forEach(s => { s._selected = chkAll.checked ? true : false; });
    render();
  });
  qAll('.ma-chk').forEach(el => el.addEventListener('change', () => {
    const idx = parseInt(el.dataset.maIdx, 10);
    if (S._mappingAnalysis?.suggestions[idx]) S._mappingAnalysis.suggestions[idx]._selected = el.checked;
    render();
  }));
  qAll('[data-ma-expand]').forEach(el => el.addEventListener('click', () => {
    const idx = parseInt(el.dataset.maExpand, 10);
    S._mappingAnalysisExpanded = S._mappingAnalysisExpanded === idx ? null : idx;
    render();
  }));

  qAll('[data-expand-rt]').forEach(el =>
    el.addEventListener('click', async () => {
      const rt = el.dataset.expandRt;
      _mappingExpanded = _mappingExpanded === rt ? null : rt;
      if (_mappingExpanded === rt && !_gapData[rt]) {
        const edsType = S.migrationMap?.componentMap?.[rt]?.edsType || '';
        if (edsType) {
          try {
            const r = await fetch(`/api/mapping-gap?rt=${encodeURIComponent(rt)}&edsType=${encodeURIComponent(edsType)}`);
            _gapData[rt] = await r.json();
          } catch (_) {}
        }
      }
      render();
    }));

  qAll('.gap-accept').forEach(el =>
    el.addEventListener('click', async () => {
      const { rt, aem, eds } = el.dataset;
      if (!S.migrationMap?.componentMap?.[rt]) return;
      S.migrationMap.componentMap[rt].propRenames = S.migrationMap.componentMap[rt].propRenames || {};
      S.migrationMap.componentMap[rt].propRenames[aem] = eds;
      delete _gapData[rt]; // invalidate so it refreshes on next render
      render();
      const edsType = S.migrationMap.componentMap[rt].edsType || '';
      if (edsType) {
        try {
          const r = await fetch(`/api/mapping-gap?rt=${encodeURIComponent(rt)}&edsType=${encodeURIComponent(edsType)}`);
          _gapData[rt] = await r.json();
          render();
        } catch (_) {}
      }
    }));

  qAll('.gap-refresh').forEach(el =>
    el.addEventListener('click', async () => {
      const rt = el.dataset.rt;
      const edsType = S.migrationMap?.componentMap?.[rt]?.edsType || '';
      if (!edsType) return;
      delete _gapData[rt];
      try {
        const r = await fetch(`/api/mapping-gap?rt=${encodeURIComponent(rt)}&edsType=${encodeURIComponent(edsType)}`);
        _gapData[rt] = await r.json();
      } catch (_) {}
      render();
    }));

  qAll('.mr-type-sel').forEach(el =>
    el.addEventListener('change', () => {
      if (S.migrationMap?.componentMap?.[el.dataset.rt])
        S.migrationMap.componentMap[el.dataset.rt].edsType = el.value;
    }));

  qAll('.mr-dst-inp').forEach(el =>
    el.addEventListener('input', () => {
      const m = S.migrationMap?.componentMap?.[el.dataset.rt];
      if (m) m.propRenames[el.dataset.src] = el.value;
    }));

  qAll('.mr-src-inp').forEach(el =>
    el.addEventListener('blur', () => {
      const m = S.migrationMap?.componentMap?.[el.dataset.rt];
      if (!m) return;
      const oldSrc = el.dataset.oldsrc;
      const newSrc = el.value.trim();
      if (newSrc && newSrc !== oldSrc) {
        const val = m.propRenames[oldSrc] ?? '';
        delete m.propRenames[oldSrc];
        m.propRenames[newSrc] = val;
        el.dataset.oldsrc = newSrc;
        // update sibling dst input's data-src
        const row = el.closest('.mr-rename');
        if (row) { const dst = row.querySelector('.mr-dst-inp'); if (dst) dst.dataset.src = newSrc; }
      }
    }));

  qAll('.mr-del-rename').forEach(el =>
    el.addEventListener('click', () => {
      const m = S.migrationMap?.componentMap?.[el.dataset.rt];
      if (m) { delete m.propRenames[el.dataset.src]; render(); }
    }));

  qAll('.mr-add-rename').forEach(el =>
    el.addEventListener('click', () => {
      const m = S.migrationMap?.componentMap?.[el.dataset.rt];
      if (m) {
        let key = 'newProp';
        let i = 1;
        while (m.propRenames[key]) key = `newProp${i++}`;
        m.propRenames[key] = '';
        render();
      }
    }));

  // Block picker items
  qAll('[data-pick]').forEach(el =>
    el.addEventListener('click', () => doPick(el.dataset.pick)));

  // Components palette search
  on('comp-search', 'input', () => {
    const q = document.getElementById('comp-search')?.value.toLowerCase() || '';
    qAll('#comp-scroll .palette-item').forEach(el => {
      const label = el.dataset.label || '';
      el.style.display = (!q || label.includes(q)) ? '' : 'none';
    });
    // Hide group titles when all their items are hidden
    qAll('#comp-scroll [data-group]').forEach(grp => {
      const visible = [...grp.querySelectorAll('.palette-item')].some(el => el.style.display !== 'none');
      grp.style.display = visible ? '' : 'none';
    });
  });

  // Block picker — auto-focus search on open
  const pickerSearch = document.getElementById('picker-search');
  if (pickerSearch) pickerSearch.focus();

  // Block picker search — filter items, collapse empty groups, show/hide Favorites
  on('picker-search', 'input', () => {
    const q = (document.getElementById('picker-search')?.value || '').toLowerCase().trim();
    const pickerBody = document.getElementById('picker-body');
    if (!pickerBody) return;

    // Remove any previous "no results" message
    const existing = pickerBody.querySelector('.picker-no-results');
    if (existing) existing.remove();

    let totalVisible = 0;

    // Walk group title + following picker-grid pairs
    const titles = pickerBody.querySelectorAll('.picker-group-title');
    titles.forEach(titleEl => {
      const grid = titleEl.nextElementSibling;
      if (!grid || !grid.classList.contains('picker-grid')) return;

      const isFavorites = titleEl.textContent.includes('Favorites');

      // When searching, hide Favorites group entirely (results come from other groups)
      if (q && isFavorites) {
        titleEl.style.display = 'none';
        grid.style.display    = 'none';
        return;
      }

      let groupVisible = 0;
      grid.querySelectorAll('.picker-item').forEach(el => {
        const label = el.querySelector('.pi2-label')?.textContent.toLowerCase() || '';
        const show  = !q || label.includes(q);
        el.style.display = show ? '' : 'none';
        if (show) groupVisible++;
      });

      const show = !q || groupVisible > 0;
      titleEl.style.display = show ? '' : 'none';
      grid.style.display    = show ? '' : 'none';
      totalVisible += groupVisible;
    });

    // No results message
    if (q && totalVisible === 0) {
      const msg = document.createElement('div');
      msg.className = 'picker-no-results';
      msg.textContent = `No EDS blocks match "${q}"`;
      pickerBody.appendChild(msg);
    }
  });

  // Props panel — live field sync
  qAll('[data-item][data-prop]').forEach(el => {
    const ev = el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(ev, () => syncProp(el));
  });

  // Style group dropdowns and checkboxes
  qAll('select[data-style-item][data-style-prop]').forEach(el =>
    el.addEventListener('change', () => syncStyleField(el)));
  qAll('input.style-cb[data-style-item][data-style-prop]').forEach(el =>
    el.addEventListener('change', () => syncStyleField(el)));

  // XML pool picker — apply a specific XML item to the selected canvas block
  qAll('[data-apply-xml]').forEach(el => {
    el.addEventListener('click', () => {
      const itemId  = el.dataset.applyXml;
      const poolIdx = parseInt(el.dataset.xmlIdx, 10);
      if (!isNaN(poolIdx)) applyXmlItem(itemId, poolIdx);
    });
  });
  on('btn-dismiss-xml-pool','click', () => { S.xmlPool = null; render(); });

  // Save-as-template
  qAll('[data-save-tpl]').forEach(el =>
    el.addEventListener('click', e => {
      e.stopPropagation();
      S.saveTplSecId = el.dataset.saveTpl;
      S.modal = 'save-template';
      render();
    }));
  on('btn-save-tpl',       'click', doSaveTemplate);
  on('btn-open-bundle-save','click', () => { S.modal = 'bundle-save'; render(); });
  on('btn-do-bundle-save', 'click', doBundleSave);
  on('modal-close-btn',    'click', closeModal);

  // Result overlay
  on('btn-close-result', 'click', () => { S.result = null; render(); });

  // A11y warning modal buttons
  on('btn-a11y-cancel',  'click', () => { S.modal = null; S._a11yIssues = null; S._a11yPendingAction = null; render(); });
  on('btn-a11y-cancel2', 'click', () => { S.modal = null; S._a11yIssues = null; S._a11yPendingAction = null; render(); });
  on('btn-a11y-anyway',  'click', async () => {
    const action = S._a11yPendingAction;
    S.modal = null; S._a11yIssues = null; S._a11yPendingAction = null;
    if (action === 'create') {
      S._a11yOverride = true;
      await doCreate();
    } else if (action && action.startsWith('mig-create:')) {
      const i = parseInt(action.split(':')[1], 10);
      S.migrateSite.plan.rows[i]._a11yOverride = true;
      await doMigCreateOne(i);
    }
  });
  on('btn-a11y-fill', 'click', async () => {
    const action = S._a11yPendingAction;
    S.modal = null; S._a11yIssues = null; S._a11yPendingAction = null;
    // Trigger a11y fill, then re-run create after
    S._a11yBusy = true; S._a11yMsg = null; S._a11yErr = false;
    // For mig-create, load the row's sections into main canvas temporarily
    let rowIdx = -1;
    if (action && action.startsWith('mig-create:')) {
      rowIdx = parseInt(action.split(':')[1], 10);
      const row = S.migrateSite.plan?.rows[rowIdx];
      if (row?.sections) S.sections = JSON.parse(JSON.stringify(row.sections));
    }
    render();
    try {
      const pageUrl = (() => {
        if (rowIdx >= 0) return liveUrlFor(S.migrateSite.plan.rows[rowIdx].sourceRel);
        return (window.prompt('Live AEM page URL for accessibility (leave blank to just normalize):', '') || '').trim();
      })();
      const d = await fetch('/api/a11y-backfill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sections: S.sections, pageUrl,
          aemHost: S.conn?.aemHost || '',
          aemUser: S.conn?.username || '',
          aemPass: S.conn?.password || ''
        })
      }).then(x => x.json());
      if (!d.ok) throw new Error(d.error || 'A11y fill failed');
      S.sections = d.sections;
      if (rowIdx >= 0) S.migrateSite.plan.rows[rowIdx].sections = JSON.parse(JSON.stringify(d.sections));
      const s = d.stats || {};
      const a = (s.imageAlt || 0) + (s.caption || 0) + (s.ctaAria || 0) + (s.videoPoster || 0) + (s.captionFromDam || 0);
      S._a11yMsg = `♿ Filled ${a} a11y field${a !== 1 ? 's' : ''}. Creating page…`;
      S._a11yBusy = false; render();
      // Skip the a11y check on re-entry — we just filled what we could; create regardless.
      if (action === 'create') { S._a11yOverride = true; await doCreate(); }
      else if (rowIdx >= 0) { S.migrateSite.plan.rows[rowIdx]._a11yOverride = true; await doMigCreateOne(rowIdx); }
    } catch (e) {
      S._a11yErr = true; S._a11yMsg = '✗ ' + e.message;
      S._a11yBusy = false; render();
    }
  });
}

async function saveMigrationMap() {
  try {
    const res = await fetch('/api/migration-map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ componentMap: S.migrationMap?.componentMap || {} }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Save failed');
    const btn = document.getElementById('btn-save-mapping');
    if (btn) { btn.textContent = '✓ Saved'; btn.disabled = true; setTimeout(() => { btn.textContent = 'Save Mappings'; btn.disabled = false; }, 2000); }
  } catch (err) {
    alert('Could not save mappings: ' + err.message);
  }
}

async function doImportPathCsv() {
  const fileInput = document.getElementById('pm-csv-file');
  const alertEl   = document.getElementById('pm-csv-alert');
  if (!fileInput?.files?.length) {
    if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">Please select a CSV file first.</div>`;
    return;
  }
  const fd = new FormData();
  fd.append('csvFile', fileInput.files[0]);
  if (alertEl) alertEl.innerHTML = `<div class="alert alert-info"><span class="spinner spinner-dark"></span> Importing…</div>`;
  try {
    const r = await fetch('/api/path-map/import-csv', { method: 'POST', body: fd });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'Import failed');
    // Refresh pathMap from server
    const pm = await fetch('/api/path-map');
    if (pm.ok) S.pathMap = await pm.json();
    render(); // re-render shows updated asset count
    const newAlertEl = document.getElementById('pm-csv-alert');
    if (newAlertEl) newAlertEl.innerHTML = `<div class="alert alert-success">✓ Imported ${d.imported} asset${d.imported !== 1 ? 's' : ''} — ${d.withDmUrl ?? 0} with DM Open API URL, ${d.imported - (d.withDmUrl ?? 0)} fallback to DAM path. ${d.total} total.</div>`;
  } catch (err) {
    const el = document.getElementById('pm-csv-alert');
    if (el) el.innerHTML = `<div class="alert alert-error">✗ ${x(err.message)}</div>`;
  }
}

async function savePathMap() {
  const alertEl = document.getElementById('pm-save-alert');
  try {
    const r = await fetch('/api/path-map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentPrefixRules: S.pathMap?.contentPrefixRules || [],
        damPrefixRules:     S.pathMap?.damPrefixRules     || [],
      }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'Save failed');
    if (alertEl) {
      alertEl.innerHTML = `<span style="color:var(--success)">✓ Saved</span>`;
      setTimeout(() => { if (alertEl) alertEl.innerHTML = ''; }, 2000);
    }
  } catch (err) {
    if (alertEl) alertEl.innerHTML = `<span style="color:var(--danger)">✗ ${x(err.message)}</span>`;
  }
}

function closeModal() { S.modal = null; S.pickCtx = null; render(); }

function doPick(compId) {
  const ctx = S.pickCtx;
  if (!ctx) return;
  if (ctx.blkId) {
    // add child to block
    const blk = findBlk(ctx.blkId);
    if (blk) {
      const child = makeItem(compId);
      blk.children.push(child);
      S.sel = { secId: ctx.secId, blkId: ctx.blkId, childId: child.id };
    }
  } else {
    addBlock(ctx.secId, compId);
    const sec = findSec(ctx.secId);
    if (sec) S.sel = { secId: ctx.secId, blkId: sec.blocks[sec.blocks.length - 1].id };
  }
  S.modal = null; S.pickCtx = null;
  render();
}

function syncStyleField(el) {
  const itemId   = el.dataset.styleItem;
  const propName = el.dataset.styleProp;
  const vals = [];
  qAll(`select[data-style-item="${itemId}"][data-style-prop="${propName}"]`)
    .forEach(s => { if (s.value) vals.push(s.value); });
  qAll(`input.style-cb[data-style-item="${itemId}"][data-style-prop="${propName}"]:checked`)
    .forEach(cb => vals.push(cb.value));
  const combined = vals.join(',');
  for (const sec of S.sections) {
    if (sec.id === itemId) { sec.props[propName] = combined; saveCanvas(); render(); return; }
    for (const blk of sec.blocks || []) {
      if (blk.id === itemId) { blk.props[propName] = combined; saveCanvas(); render(); return; }
      for (const ch of blk.children || []) {
        if (ch.id === itemId) { ch.props[propName] = combined; saveCanvas(); render(); return; }
      }
    }
  }
}

// ── AEM write-back helpers ────────────────────────────────────────────────────
function diffProps(oldProps, newProps) {
  const diff = {};
  const allKeys = new Set([...Object.keys(oldProps || {}), ...Object.keys(newProps || {})]);
  for (const k of allKeys) {
    if (k.startsWith('_')) continue;
    const ov = String(oldProps?.[k] ?? ''), nv = String(newProps?.[k] ?? '');
    if (ov !== nv) diff[k] = { old: ov, new: nv };
  }
  return diff;
}

function computeJcrDiff() {
  if (!S._importPagePath) return [];
  const changes = [];

  // 1. Page-level meta properties (live on jcr:content directly)
  if (S._importMetaSnapshot) {
    const metaDiff = diffProps(S._importMetaSnapshot, S.meta);
    if (Object.keys(metaDiff).length)
      changes.push({ jcrPath: `${S._importPagePath}/jcr:content`, blockType: null, label: 'page meta', changedProps: metaDiff });
  }

  // 2. Section / block properties
  if (!S._importSnapshot) return changes;
  const base = `${S._importPagePath}/jcr:content/root`;
  const snapMap = Object.fromEntries(S._importSnapshot.map(s => [s._jcrKey, s]));

  for (const sec of S.sections) {
    const snapSec = snapMap[sec._jcrKey];

    if (!snapSec) {
      // Entire section is new — create section node then all its block nodes
      const secKey = `section_${sec.id.slice(0, 10)}`;
      changes.push({ jcrPath: `${base}/${secKey}`, blockType: sec.type, label: sec.type,
                     isNew: true, isSection: true, newProps: sec.props });
      for (const blk of sec.blocks || []) {
        const blkKey = blk._jcrKey || `block_${blk.type}_${blk.id.slice(0, 8)}`;
        changes.push({ jcrPath: `${base}/${secKey}/${blkKey}`, blockType: blk.type, label: blk.type,
                       isNew: true, newProps: blk.props });
      }
      continue;
    }

    // Existing section — diff props and blocks
    const secDiff = diffProps(snapSec.props, sec.props);
    if (Object.keys(secDiff).length)
      changes.push({ jcrPath: `${base}/${sec._jcrKey}`, blockType: sec.type, label: sec.type, changedProps: secDiff });

    const snapBlkMap = Object.fromEntries((snapSec.blocks || []).map(b => [b._jcrKey, b]));
    for (const blk of sec.blocks || []) {
      if (!blk._jcrKey) {
        const nodeName = `block_${blk.type}_${blk.id.slice(0, 8)}`;
        changes.push({ jcrPath: `${base}/${sec._jcrKey}/${nodeName}`, blockType: blk.type, label: blk.type,
                       isNew: true, newProps: blk.props });
        continue;
      }
      const snapBlk = snapBlkMap[blk._jcrKey];
      if (!snapBlk) continue;
      const blkDiff = diffProps(snapBlk.props, blk.props);
      if (Object.keys(blkDiff).length)
        changes.push({ jcrPath: `${base}/${sec._jcrKey}/${blk._jcrKey}`, blockType: blk.type, label: blk.type,
                       changedProps: blkDiff });
    }
  }
  return changes;
}

function renderPublishModal(changes) {
  const rows = changes.map((c, idx) => {
    const shortPath = c.jcrPath.split('/').slice(-2).join('/');
    let propRows;
    if (c.isNew) {
      const entries = Object.entries(c.newProps || {}).filter(([k]) => !k.startsWith('_'));
      propRows = entries.map(([k, v]) => `
        <div class="pub-prop">
          <span class="pub-key">${x(k)}</span>
          <span class="pub-new">${x(String(v ?? ''))}</span>
        </div>`).join('') || '<div class="pub-prop" style="color:var(--muted);font-style:italic">no props</div>';
    } else {
      propRows = Object.entries(c.changedProps || {}).map(([k, { old: ov, new: nv }]) => `
        <div class="pub-prop">
          <span class="pub-key">${x(k)}</span>
          <span class="pub-old">${x(ov || '(empty)')}</span>
          <span class="pub-arrow">→</span>
          <span class="pub-new">${x(nv || '(empty)')}</span>
        </div>`).join('');
    }
    const badge = c.isNew
      ? `<span class="pub-type-badge pub-type-badge--new">+ NEW</span>`
      : `<span class="pub-type-badge">${x(c.label)}</span>`;
    return `<div class="pub-node">
      <label class="pub-node-label">
        <input type="checkbox" class="pub-chk" data-idx="${idx}" checked>
        ${badge}
        <span class="pub-path" title="${x(c.jcrPath)}">${x(shortPath)}</span>
      </label>
      <div class="pub-props">${propRows}</div>
    </div>`;
  }).join('');

  return `<div class="modal-overlay" id="publish-modal">
    <div class="modal pub-modal">
      <div class="modal-header">
        <span class="modal-title">Publish changes to AEM</span>
        <button class="icon-btn" id="btn-pub-cancel">✕</button>
      </div>
      <div class="modal-body pub-modal-body">${rows}</div>
      <div class="modal-footer">
        <button class="btn btn-ghost btn-sm" id="btn-pub-cancel2">Cancel</button>
        <button class="btn btn-primary btn-sm" id="btn-pub-confirm">
          Write ${changes.length} change${changes.length !== 1 ? 's' : ''} to AEM
        </button>
      </div>
    </div>
  </div>`;
}

function syncProp(el) {
  const { item: itemId, prop } = el.dataset;
  const val = el.type === 'checkbox' ? el.checked : (el.tagName === 'SELECT' && el.multiple
    ? Array.from(el.selectedOptions).map(o => o.value)
    : el.value);

  // Find item across sections/blocks/children
  for (const sec of S.sections) {
    if (sec.id === itemId) { sec.props[prop] = val; return; }
    for (const blk of sec.blocks) {
      if (blk.id === itemId) { blk.props[prop] = val; return; }
      for (const ch of (blk.children || [])) {
        if (ch.id === itemId) { ch.props[prop] = val; return; }
      }
    }
  }
}

function saveSettings() {
  S.conn.aemHost    = val('s-host');
  S.conn.username   = val('s-user');
  S.conn.password   = val('s-pass');
  S.conn.parentPath = val('s-parent');
  S.conn.pageName   = val('s-name');
  S.conn.ueOrg      = val('s-ueorg') || 'abbviecommercial';
  // Save meta fields
  qAll('[data-meta]').forEach(el => { S.meta[el.dataset.meta] = el.value; });
  // Persist connection settings across sessions
  try { localStorage.setItem('aem_conn', JSON.stringify({
    aemHost: S.conn.aemHost, username: S.conn.username,
    password: S.conn.password, parentPath: S.conn.parentPath,
    ueOrg: S.conn.ueOrg
  })); } catch (_) {}
  render();
}

async function testConn() {
  S.conn.aemHost  = val('s-host');
  S.conn.username = val('s-user');
  S.conn.password = val('s-pass');
  const el = document.getElementById('conn-alert');
  if (el) el.innerHTML = `<div class="alert alert-info"><span class="spinner spinner-dark"></span> Testing…</div>`;
  try {
    const r = await fetch('/api/health', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aemHost: S.conn.aemHost, username: S.conn.username, password: S.conn.password })
    });
    const d = await r.json();
    S.conn.ok = !!d.ok;
    if (el) el.innerHTML = d.ok
      ? `<div class="alert alert-success">✓ ${x(d.message)}</div>`
      : `<div class="alert alert-error">✗ ${x(d.error)}</div>`;
  } catch (e) {
    if (el) el.innerHTML = `<div class="alert alert-error">✗ ${x(e.message)}</div>`;
  }
}

function buildUeUrl(pagePath) {
  const host = S.conn.aemHost.replace(/\/+$/, '');
  const hostNoProto = host.replace(/^https?:\/\//, '');
  const org = S.conn.ueOrg || 'abbviecommercial';
  return `${host}/ui#/@${org}/aem/universal-editor/canvas/${hostNoProto}${pagePath}.html`;
}

// ── Preview Page in AEM ───────────────────────────────────────────────────────
// Computes the preview path: {root}/{country}/{lang}/preview/{pageName}
// Ensures the /preview folder exists, then creates the page under it.
function buildPreviewParentPath(parentPath, edsPrefix) {
  // Strip the EDS root prefix to get the region+path segments
  const root = (edsPrefix || S.migrateSite?.edsPrefix || '/content/abbvie-nextgen-eds/corporate/abbvie-com').replace(/\/+$/, '');
  const rel  = parentPath.startsWith(root) ? parentPath.slice(root.length).replace(/^\//, '') : parentPath.replace(/^\//, '');
  // rel is like "ch/de/science/areas-of-focus/immunology" → take first 2 segments (country/lang)
  const segs = rel.split('/').filter(Boolean);
  if (segs.length < 2) return null; // can't determine locale
  const locale = segs.slice(0, 2).join('/');
  return `${root}/${locale}/preview`;
}

async function doPreviewPage() {
  const { aemHost, username, password, parentPath, pageName } = S.conn;
  if (!aemHost || !username || !password || !parentPath || !pageName) {
    alert('Configure AEM connection and set Parent Path + Page Name in Settings first.'); return;
  }
  if (!S.sections.length) { alert('Add some sections to the canvas first.'); return; }
  const previewParentPath = buildPreviewParentPath(parentPath, S.migrateSite?.edsPrefix);
  if (!previewParentPath) { alert('Could not determine the locale from the parent path. Ensure it contains at least country/language segments (e.g. /content/…/ch/de/…).'); return; }

  S._previewingPage = true; render();
  try {
    const r = await fetch('/api/preview-page', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aemHost, username, password, previewParentPath, pageName, meta: S.meta, sections: S.sections })
    });
    const data = await r.json();
    if (!data.ok) { alert('Preview page creation failed: ' + (data.error || 'Unknown error')); return; }
    // Open the page in AEM authoring / Universal Editor
    const ueUrl = buildUeUrl(data.path);
    const tab   = window.open(ueUrl, '_blank', 'noopener,noreferrer');
    if (tab) tab.opener = null;
    // Show the preview path as a brief notification in the topbar badge area
    S._previewPagePath = data.path;
  } catch (e) {
    alert('Preview page error: ' + e.message);
  }
  S._previewingPage = false; render();
}

async function doPreview() {
  if (!S.sections.length) return;
  const btn = document.getElementById('btn-preview');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Building…'; }
  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sections: S.sections, meta: S.meta })
    });
    if (!res.ok) { const d = await res.json(); alert('Preview failed: ' + (d.error || res.status)); return; }
    const html = await res.text();
    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const tab  = window.open(url, '_blank', 'noopener,noreferrer');
    if (tab) tab.opener = null;
    // Revoke after a short delay so the tab has time to load it
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    alert('Preview error: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '👁 Preview'; }
  }
}

// ── Accessibility pre-flight ─────────────────────────────────────────────────
// Scans sections[] and returns an array of issue objects:
//   { blockType, field, label, path }
// Checks:
//   • custom-image     — imageAlt missing (unless imageIsDecorative=true or getAltFromDAM=true)
//   • cta              — aria-label missing when linkText is empty/icon-only
//   • hero-container-item — imageAlt missing when backgroundVariant=image
//   • teaser           — no specific a11y field but checked for buttonURL without buttonLabel
//   • brightcove-video — posterAccessibilityLabel missing when placeholderImage/posterImage present
function checkA11y(sections) {
  const issues = [];
  // counters per block type per section for unique labelling
  const typeCounts = {};

  function visitBlock(b, secIndex, parentPath) {
    const p = b.props || {};
    const t = b.type;
    const key = `${secIndex}:${t}`;
    typeCounts[key] = (typeCounts[key] || 0) + 1;
    const countSuffix = typeCounts[key] > 1 ? ` #${typeCounts[key]}` : '';
    const path = parentPath ? `${parentPath} › ${t}${countSuffix}` : `Section ${secIndex + 1} › ${t}${countSuffix}`;

    if (t === 'custom-image') {
      // Flag any image that has an image source but no alt text or caption.
      // We flag even if getAltFromDAM=true because that AEM mechanism doesn't carry over to EDS.
      const decorative = String(p.imageIsDecorative || '').toLowerCase() === 'true';
      const hasImageSrc = String(p.image || p.imageReference || p.fileReference || '').trim();
      if (!decorative && hasImageSrc) {
        if (!String(p.imageAlt || '').trim()) {
          issues.push({ blockType: t, field: 'imageAlt', label: 'Image alt text missing', path });
        }
        // caption maps from jcr:title — flag if missing (getCaptionFromDAM also doesn't carry to EDS)
        if (!String(p.caption || p['jcr:title'] || '').trim()) {
          issues.push({ blockType: t, field: 'caption', label: 'Image caption missing', path });
        }
      }
    }
    if (t === 'hero-container-item') {
      // Any hero item with an image reference needs alt text.
      const hasImageSrc = String(p.image || p.imageReference || p.fileReference || p.backgroundImage || '').trim();
      // Also flag when backgroundVariant is 'image' even if no src prop found
      const hasVariant = String(p.backgroundVariant || '').toLowerCase() === 'image';
      if ((hasImageSrc || hasVariant) && !String(p.imageAlt || '').trim()) {
        issues.push({ blockType: t, field: 'imageAlt', label: 'Hero image alt text missing', path });
      }
    }
    if (t === 'cta') {
      // Flag any CTA that is missing aria-label, regardless of whether linkText is set.
      // The original request specifically calls out CTA aria-labels as a known gap.
      const ariaLabel = String(p['aria-label'] || '').trim();
      const hasLink   = String(p.link || p.linkURL || '').trim();
      if (hasLink && !ariaLabel) {
        issues.push({ blockType: t, field: 'aria-label', label: 'CTA aria-label missing', path });
      }
    }
    if (t === 'brightcove-video' || t === 'video') {
      // Flag any video block that is missing a poster/video accessibility label.
      const hasVideo = String(p.videoId || p.uri || p.src || p.brightcoveVideoId || '').trim();
      if (hasVideo && !String(p.posterAccessibilityLabel || p.imgAlt || '').trim()) {
        issues.push({ blockType: t, field: 'posterAccessibilityLabel', label: 'Video accessibility label missing', path });
      }
    }

    // Recurse into children (covers grid-section content, accordion items, carousel slides, etc.)
    for (const c of b.children || []) visitBlock(c, secIndex, path);
    // Also recurse into nested blocks[] (e.g. grid-section stores actual blocks in blocks[])
    for (const c of b.blocks   || []) visitBlock(c, secIndex, path);
  }

  for (let i = 0; i < (sections || []).length; i++) {
    const sec = sections[i];
    // Visit all top-level blocks (and they recurse into their own children/blocks)
    for (const blk of sec.blocks || []) visitBlock(blk, i, null);
  }
  return issues;
}

function a11yWarningModalHtml(issues, actionKey) {
  const rows = issues.map(iss =>
    `<tr><td style="padding:4px 8px"><code>${iss.path}</code></td><td style="padding:4px 8px;color:#d97706">${iss.label}</td></tr>`
  ).join('');
  return `
  <div class="modal-overlay" id="a11y-warn-modal">
    <div class="modal" style="max-width:620px">
      <div class="modal-header">
        <span style="font-size:1.1em">⚠️ Accessibility Issues Found</span>
        <button class="modal-close" id="btn-a11y-cancel">✕</button>
      </div>
      <div class="modal-body" style="max-height:320px;overflow-y:auto">
        <p style="margin:0 0 12px">The following blocks are missing accessibility fields. Screen readers may not be able to describe this content correctly.</p>
        <table style="width:100%;border-collapse:collapse;font-size:0.88em">
          <thead><tr style="background:#f3f4f6">
            <th style="padding:4px 8px;text-align:left">Location</th>
            <th style="padding:4px 8px;text-align:left">Missing</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end;padding:12px 16px">
        <button class="btn btn-secondary btn-sm" id="btn-a11y-cancel2">Cancel</button>
        <button class="btn btn-warning btn-sm" id="btn-a11y-fill" data-action="${actionKey || ''}">
          🔧 Fill A11y First, Then Create
        </button>
        <button class="btn btn-primary btn-sm" id="btn-a11y-anyway" data-action="${actionKey || ''}">
          Create Anyway
        </button>
      </div>
    </div>
  </div>`;
}

async function doCreate() {
const { aemHost, username, password, parentPath, pageName } = S.conn;
  if (!aemHost || !username || !password || !parentPath || !pageName) {
    _view = 'settings'; render(); return;
  }
  // A11y pre-flight: check for missing alt text, aria-labels, etc.
  if (!S._a11yOverride) {
    const issues = checkA11y(S.sections);
    if (issues.length) {
      S.modal = 'a11y-warning';
      S._a11yIssues = issues;
      S._a11yPendingAction = 'create';
      render();
      return;
    }
  }
  S._a11yOverride = false;
  S.creating = true; render();
  try {
    const r = await fetch('/api/pages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aemHost, username, password, parentPath, pageName, meta: S.meta, sections: S.sections })
    });
    S.result = await r.json();
    // Auto-open in Universal Editor on success
    if (S.result?.ok) window.open(buildUeUrl(S.result.path), '_blank');
  } catch (e) {
    S.result = { ok: false, error: e.message };
  }
  S.creating = false; render();
}

// ── Data helpers ──────────────────────────────────────────────────────────────
function addSection(type) {
  const sec = { id: uid(), type, props: {}, blocks: [] };
  // seed default props from model
  const model = S.config?.modelMap?.[type];
  if (model) for (const f of model.fields) {
    if (f.component !== 'tab' && f.value !== undefined) sec.props[f.name] = f.value;
  }
  S.sections.push(sec);
  S.sel = { secId: sec.id };
  render();
}

// Blocks that always need a default child when created (e.g. from palette)
const AUTO_CHILDREN = { 'text-container': ['text-container-text'] };

function makeItem(type) {
  const item = { id: uid(), type, props: {}, children: [] };
  // 1. seed from model field value defaults
  const model = S.config?.modelMap?.[type];
  if (model) for (const f of model.fields) {
    if (f.component !== 'tab' && f.value !== undefined) item.props[f.name] = f.value;
  }
  // 2. overlay content defaults
  const cd = S.config?.contentDefaults?.[type];
  if (cd) Object.assign(item.props, cd);
  // 3. auto-seed mandatory children
  for (const childType of (AUTO_CHILDREN[type] || [])) {
    item.children.push(makeItem(childType));
  }
  return item;
}

function addBlock(secId, type) {
  const sec = findSec(secId);
  if (!sec) return;
  const blk = makeItem(type);
  sec.blocks.push(blk);
}

// Recursively hydrate a node def: seeds defaults via makeItem, then overlays
// explicit props/children from the def at any depth.
function hydrateNode(def) {
  const item = makeItem(def.type);                 // model defaults + content defaults + auto-children
  Object.assign(item.props, def.props || {});      // predefined props win
  if (def.children && def.children.length > 0) {
    item.children = def.children.map(ch => hydrateNode(ch));
  }
  return item;
}

function hydrateSectionDef(def) {
  const src = def.section;
  const sec = { id: uid(), type: src.type, props: { ...(src.props || {}) }, blocks: [] };
  for (const blkDef of (src.blocks || [])) {
    sec.blocks.push(hydrateNode(blkDef));
  }
  return sec;
}

// Returns an array of sections — 1 for single-section defs, N for multi-section bundles
function hydrateDef(def) {
  if (def.sections) return def.sections.map(src => {
    const sec = { id: uid(), type: src.type, props: { ...(src.props || {}) }, blocks: [] };
    for (const blkDef of (src.blocks || [])) sec.blocks.push(hydrateNode(blkDef));
    return sec;
  });
  return [hydrateSectionDef(def)];
}

function deleteBlock(secId, blkId) {
  const sec = findSec(secId);
  if (!sec) return;
  sec.blocks = sec.blocks.filter(b => b.id !== blkId);
  if (S.sel?.blkId === blkId) S.sel = { secId };
  render();
}

function moveSection(secId, dir) {
  const i = S.sections.findIndex(s => s.id === secId);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= S.sections.length) return;
  [S.sections[i], S.sections[j]] = [S.sections[j], S.sections[i]];
  render();
}

function moveBlock(secId, blkId, dir) {
  const sec = findSec(secId);
  if (!sec) return;
  const i = sec.blocks.findIndex(b => b.id === blkId);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= sec.blocks.length) return;
  [sec.blocks[i], sec.blocks[j]] = [sec.blocks[j], sec.blocks[i]];
  render();
}

function duplicateSection(secId) {
  const i = S.sections.findIndex(s => s.id === secId);
  if (i < 0) return;
  const clone = deepCloneWithNewIds(S.sections[i]);
  S.sections.splice(i + 1, 0, clone);
  S.sel = { secId: clone.id };
  render();
}

function duplicateBlock(secId, blkId) {
  const sec = findSec(secId);
  if (!sec) return;
  const i = sec.blocks.findIndex(b => b.id === blkId);
  if (i < 0) return;
  const clone = deepCloneWithNewIds(sec.blocks[i]);
  sec.blocks.splice(i + 1, 0, clone);
  S.sel = { secId, blkId: clone.id };
  render();
}

function duplicateChild(secId, blkId, childId) {
  const blk = findBlk(blkId);
  if (!blk) return;
  const i = (blk.children || []).findIndex(c => c.id === childId);
  if (i < 0) return;
  const clone = deepCloneWithNewIds(blk.children[i]);
  blk.children.splice(i + 1, 0, clone);
  S.sel = { secId, blkId, childId: clone.id };
  render();
}

function findSec(id)  { return S.sections.find(s => s.id === id); }
function findBlk(id)  { for (const s of S.sections) { const b = s.blocks.find(b => b.id === id); if (b) return b; for (const blk of s.blocks) { const ch = (blk.children || []).find(c => c.id === id); if (ch) return ch; } } return null; }
function findSecIdForBlk(blkId) { for (const s of S.sections) { if (s.blocks.find(b => b.id === blkId)) return s.id; for (const blk of s.blocks) { if ((blk.children||[]).find(c=>c.id===blkId)) return s.id; } } return null; }

// ── Utility ───────────────────────────────────────────────────────────────────
function on(id, ev, fn) { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }
function q(sel)   { return document.querySelector(sel); }
function qAll(sel){ return document.querySelectorAll(sel); }
function val(id)  { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function x(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Thumbnail helpers ─────────────────────────────────────────────────────────
async function doUploadThumb(id, file) {
  const fd = new FormData();
  fd.append('thumb', file);
  const res  = await fetch(`/api/section-thumbs/upload/${encodeURIComponent(id)}`, { method: 'POST', body: fd });
  const data = await res.json();
  if (data.ok) {
    const sec = S.sectionsLib.find(d => d.id === id);
    if (sec) sec.thumbnailUrl = data.url + '?t=' + Date.now();
    render();
  }
}

async function doCaptureThumbsFrom() {
  const urlEl  = document.getElementById('thumb-url');
  const selEl  = document.getElementById('thumb-selector');
  const status = document.getElementById('thumb-capture-status');
  const url    = urlEl?.value?.trim();
  const selector = selEl?.value?.trim() || 'main > div.section';
  if (!url) { if (status) status.textContent = 'Enter a page URL first.'; return; }

  const CAT_ORD = ['Hero','Article','Grid','Content','Video','Cards','CTA','FAQ','Quote','Related'];
  const groups  = {};
  for (const def of S.sectionsLib) { const c = sectionCategory(def); (groups[c] = groups[c] || []).push(def); }
  const sectionIds = CAT_ORD.filter(c => groups[c]).flatMap(c => groups[c]).map(d => d.id);

  if (status) status.textContent = `Capturing ${sectionIds.length} sections… (this may take a minute)`;
  try {
    const res  = await fetch('/api/section-thumbs/capture', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, selector, sectionIds })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const secsRes = await fetch('/api/sections');
    S.sectionsLib = await secsRes.json();
    render();
    if (status) status.textContent = `✓ Captured ${data.captured} of ${sectionIds.length} thumbnails.`;
  } catch (err) {
    if (status) status.textContent = `Error: ${err.message}`;
  }
}

// ── Section preview modal ─────────────────────────────────────────────────────
function openSectionPreview(id) {
  const def = S.sectionsLib.find(d => d.id === id);
  if (!def) return;
  closeSectionPreview();
  const isBundle = Array.isArray(def.sections);
  const overlay = document.createElement('div');
  overlay.id = 'slc-prev-overlay';
  overlay.className = 'slc-prev-overlay';
  overlay.innerHTML = `
    <div class="slc-prev-panel">
      <div class="slc-prev-head">
        <span class="slc-prev-title">${x(def.title)}</span>
        <button class="slc-prev-close" id="slc-prev-close">✕</button>
      </div>
      <div class="slc-prev-thumb">${def.thumbnailUrl
        ? `<img src="${x(def.thumbnailUrl)}" alt="${x(def.title)}" style="width:240px;height:auto;display:block;border-radius:4px;object-fit:cover">`
        : sectionThumbnailSvg(def)}</div>
      ${def.description ? `<div class="slc-prev-desc">${x(def.description)}</div>` : ''}
      <div class="slc-prev-tree-lbl">
        Block Structure
        ${isBundle ? `<span class="slc-prev-badge">${def.sections.length} sections</span>` : ''}
      </div>
      <div class="slc-prev-tree">${sectionBlockTreeHtml(def)}</div>
      <div class="slc-prev-foot">
        <button class="slc-prev-add" id="slc-prev-add">+ Add to Canvas</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('slc-prev-close').addEventListener('click', closeSectionPreview);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeSectionPreview(); });
  document.getElementById('slc-prev-add').addEventListener('click', () => {
    const secs = hydrateDef(def);
    secs.forEach(s => S.sections.push(s));
    S.sel = { secId: secs[0].id };
    closeSectionPreview();
    render();
  });
  const escHandler = e => { if (e.key === 'Escape') { closeSectionPreview(); document.removeEventListener('keydown', escHandler); } };
  document.addEventListener('keydown', escHandler);
}

function closeSectionPreview() {
  const el = document.getElementById('slc-prev-overlay');
  if (el) el.remove();
}

// ── Page Validation ───────────────────────────────────────────────────────────
function validationDetailModalHtml() {
  const d = S._validationDetail;
  if (!d) return '';
  const v = d.validation;
  const sl = v.scoreLabel || { label: 'Unknown', color: '#6b7280' };
  const scoreColor = v.finalScore >= 95 ? '#15803d' : v.finalScore >= 85 ? '#ca8a04' : v.finalScore >= 70 ? '#d97706' : '#dc2626';

  function bar(label, score, weight, color) {
    return `<div style="margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;font-size:.72rem;margin-bottom:2px">
        <span>${label} <span style="color:var(--muted);font-size:.65rem">(${weight}%)</span></span>
        <strong style="color:${score >= 85 ? '#15803d' : score >= 70 ? '#ca8a04' : '#dc2626'}">${score}%</strong>
      </div>
      <div style="height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${score}%;background:${color};border-radius:3px"></div>
      </div>
    </div>`;
  }

  const issuesHtml = (v.issues || []).length
    ? `<ul style="margin:0;padding:0 0 0 16px;font-size:.74rem;color:#374151">${(v.issues || []).map(i => `<li style="margin-bottom:3px">${x(i)}</li>`).join('')}</ul>`
    : `<div style="font-size:.74rem;color:#15803d">✓ No issues found</div>`;

  const vpNames = Object.keys(v.viewports || {});
  const shotHtml = vpNames.map(vp => {
    const aemUrl = v.screenshotUrls?.[`${vp}_aem`];
    const edsUrl = v.screenshotUrls?.[`${vp}_eds`];
    const diffUrl = v.diffUrls?.[vp];
    return `<div style="margin-bottom:12px">
      <div style="font-weight:600;font-size:.75rem;text-transform:uppercase;margin-bottom:6px;color:var(--muted)">${vp}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${aemUrl ? `<div style="flex:1;min-width:200px"><div style="font-size:.68rem;color:var(--muted);margin-bottom:3px">AEM</div><img src="${x(aemUrl)}" style="width:100%;border:1px solid #e5e7eb;border-radius:4px" loading="lazy"></div>` : ''}
        ${edsUrl ? `<div style="flex:1;min-width:200px"><div style="font-size:.68rem;color:var(--muted);margin-bottom:3px">EDS</div><img src="${x(edsUrl)}" style="width:100%;border:1px solid #e5e7eb;border-radius:4px" loading="lazy"></div>` : ''}
        ${diffUrl ? `<div style="flex:1;min-width:200px"><div style="font-size:.68rem;color:var(--muted);margin-bottom:3px">Diff (red = changed)</div><img src="${x(diffUrl)}" style="width:100%;border:1px solid #e5e7eb;border-radius:4px" loading="lazy"></div>` : ''}
      </div>
    </div>`;
  }).join('');

  return `<div class="modal-overlay" id="modal-overlay">
    <div class="modal modal-lg" style="max-width:860px">
      <div class="modal-header">
        <h2>📊 Validation Report</h2>
        <button class="modal-close" id="modal-close">✕</button>
      </div>
      <div class="modal-body" style="max-height:75vh;overflow-y:auto">
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e5e7eb">
          <div style="text-align:center">
            <div style="font-size:2.5rem;font-weight:800;color:${scoreColor};line-height:1">${v.finalScore ?? '?'}</div>
            <div style="font-size:.7rem;font-weight:700;color:${scoreColor};text-transform:uppercase">${sl.label}</div>
          </div>
          <div style="flex:1">
            ${bar('Visual Similarity', v.scores?.visual || 0, 40, '#3b82f6')}
            ${bar('Content Match',     v.scores?.content || 0, 30, '#10b981')}
            ${bar('Structure Match',   v.scores?.structure || 0, 20, '#8b5cf6')}
            ${bar('A11y Match',        v.scores?.a11y || 0, 10, '#f59e0b')}
          </div>
        </div>
        <div style="margin-bottom:14px">
          <div style="font-weight:600;font-size:.78rem;margin-bottom:6px">Issues</div>
          ${issuesHtml}
        </div>
        ${shotHtml ? `<div style="margin-bottom:6px"><div style="font-weight:600;font-size:.78rem;margin-bottom:8px">Screenshots</div>${shotHtml}</div>` : ''}
        <div style="font-size:.68rem;color:var(--muted);margin-top:8px">
          AEM: ${x(v.aemUrl || '')} · EDS: ${x(v.edsUrl || '')} · ${v.timestamp ? new Date(v.timestamp).toLocaleString() : ''}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost btn-sm" id="modal-close">Close</button>
      </div>
    </div>
  </div>`;
}

async function doValidateOne(i) {
  const ms = S.migrateSite, r = ms.plan?.rows[i];
  if (!r) return;
  const liveBase = (ms.liveBase || '').trim().replace(/\/+$/, '');
  if (!liveBase) { alert('Set the Live AEM base URL in the Migrate Full Site config first.'); return; }
  const aemUrl = liveUrlFor(r.sourceRel);
  const edsUrl = r.targetPath ? `${(S.conn.aemHost || '').replace(/\/+$/, '')}${r.targetPath}.html` : '';
  if (!aemUrl || !edsUrl) { alert('Cannot determine page URLs. Ensure Live base URL and Create at path are set.'); return; }
  r._validating = true; render();
  try {
    const res = await fetch('/api/validate-page', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aemUrl, edsUrl, viewports: ['desktop'], id: `row_${i}_${Date.now()}` })
    });
    const data = await res.json();
    r.validation = data;
  } catch (e) {
    r.validation = { ok: false, error: e.message, finalScore: null, scores: {}, issues: [e.message], scoreLabel: { label: 'Error', color: '#dc2626' } };
  }
  r._validating = false; render();
}

// ── Compare Modal (split-view with scroll sync) ───────────────────────────────
function compareModalHtml() {
  const cm = S.compareModal;

  // Both panes go through /api/proxy so the server strips X-Frame-Options / CSP frame-ancestors.
  // Left pane  (live public site) — no auth needed.
  // Right pane (AEM Cloud author) — proxy passes Basic Auth so the AEM Cloud render endpoint
  //   returns a real HTML page (the .html suffix renders the published/preview page, not the
  //   JCR editor, so Basic Auth works fine for read-only page rendering).
  const liveProxied      = `/api/proxy?url=${encodeURIComponent(cm.liveUrl)}`;
  const { username = '', password = '' } = S.conn || {};
  const aemProxied = cm.migratedUrl
    ? `/api/proxy?url=${encodeURIComponent(cm.migratedUrl)}&user=${encodeURIComponent(username)}&pass=${encodeURIComponent(password)}`
    : '';

  return `
  <div class="compare-overlay" id="compare-overlay">
    <div class="compare-header">
      <h2>⚖ Side-by-Side Compare${cm.canon ? ` — ${x(cm.canon)}` : ''}</h2>
      <span class="compare-urls">${x(cm.liveUrl)} ↔ ${x(cm.migratedUrl)}</span>
      <button class="compare-close-btn" id="btn-compare-close" title="Close">✕</button>
    </div>
    <div class="compare-pane-labels">
      <div class="compare-pane-label">🌐 Live AEM <span class="cpl-url">${x(cm.liveUrl)}</span></div>
      <div class="compare-pane-label compare-pane-label--right">
        ✅ Migrated EDS <span class="cpl-url">${x(cm.migratedUrl)}</span>
        <a class="cpl-open-link" href="${x(cm.migratedUrl || '')}" target="_blank" rel="noopener noreferrer" title="Open in new tab">↗ open</a>
      </div>
    </div>
    <div class="compare-body" id="compare-body">
      <div class="compare-pane" id="compare-pane-left">
        <iframe id="compare-iframe-left" name="compare-left"
          src="${x(liveProxied)}" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>
      </div>
      <div class="compare-divider" id="compare-divider"></div>
      <div class="compare-pane" id="compare-pane-right">
        ${aemProxied
          ? `<iframe id="compare-iframe-right" name="compare-right"
               src="${x(aemProxied)}" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>`
          : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#6b7280;font-size:.85rem">
               No migrated URL — set the "Create at" path for this row first.
             </div>`
        }
      </div>
      <div class="compare-loading" id="compare-loading">
        <span class="spinner"></span> Loading pages…
      </div>
    </div>
    <div class="compare-status">
      <span class="compare-sync-badge" id="compare-sync-badge">⟳ Scroll sync: waiting</span>
      <span>Drag divider to resize panes · Scroll either pane to sync both</span>
    </div>
  </div>`;
}

function setupCompareScrollSync() {
  const overlay  = document.getElementById('compare-overlay');
  if (!overlay) return;

  // Close button
  document.getElementById('btn-compare-close')?.addEventListener('click', () => {
    S.compareModal = null;
    render();
  });

  // Hide loading spinner once both iframes load
  const loading = document.getElementById('compare-loading');
  const leftIframe  = document.getElementById('compare-iframe-left');
  const rightIframe = document.getElementById('compare-iframe-right');
  if (leftIframe) {
    leftIframe.addEventListener('load', () => {
      if (loading) loading.classList.add('hidden');
    });
  }
  if (rightIframe) {
    rightIframe.addEventListener('load', () => {
      if (loading) loading.classList.add('hidden');
    });
  }

  // Divider drag to resize panes
  const divider = document.getElementById('compare-divider');
  const body    = document.getElementById('compare-body');
  const left    = document.getElementById('compare-pane-left');
  const right   = document.getElementById('compare-pane-right');
  if (divider && body && left && right) {
    let dragging = false, startX = 0, startLeft = 0;
    divider.addEventListener('mousedown', e => {
      dragging = true; startX = e.clientX;
      startLeft = left.getBoundingClientRect().width;
      divider.classList.add('dragging');
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const total = body.getBoundingClientRect().width - 4;
      const newLeft = Math.max(200, Math.min(total - 200, startLeft + (e.clientX - startX)));
      left.style.flex  = 'none';
      right.style.flex = 'none';
      left.style.width  = newLeft + 'px';
      right.style.width = (total - newLeft) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; divider.classList.remove('dragging'); document.body.style.userSelect = ''; }
    });
  }

  // Scroll sync via postMessage (injected by proxy) and direct iframe scroll events
  const badge = document.getElementById('compare-sync-badge');
  let isSyncing = false;

  function syncScroll(pct, sourceId) {
    if (isSyncing) return;
    isSyncing = true;
    const targetId = sourceId === 'compare-left' ? 'compare-iframe-right' : 'compare-iframe-left';
    const target   = document.getElementById(targetId);
    if (target) {
      try {
        const doc = target.contentDocument || target.contentWindow?.document;
        if (doc) {
          const h = doc.documentElement.scrollHeight - doc.documentElement.clientHeight;
          doc.documentElement.scrollTop = pct * h;
        }
      } catch (_) { /* cross-origin blocked */ }
    }
    if (badge) badge.textContent = '✓ Scroll sync: active';
    setTimeout(() => { isSyncing = false; }, 50);
  }

  window.addEventListener('message', e => {
    if (e.data?.type === 'iframe-scroll') syncScroll(e.data.pct, e.data.src);
  });

  // Direct scroll on left iframe (if same-origin after proxy)
  ['compare-iframe-left','compare-iframe-right'].forEach(id => {
    const f = document.getElementById(id);
    if (!f) return;
    f.addEventListener('load', () => {
      try {
        const doc = f.contentDocument || f.contentWindow?.document;
        if (doc) {
          doc.addEventListener('scroll', () => {
            const h = doc.documentElement.scrollHeight - doc.documentElement.clientHeight;
            const pct = h > 0 ? doc.documentElement.scrollTop / h : 0;
            syncScroll(pct, f.name);
          }, { passive: true });
        }
      } catch (_) {}
    });
  });
}
