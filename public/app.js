'use strict';

// ── State ────────────────────────────────────────────────────────────────────
const S = {
  config:         null,   // { defs, modelMap, filterMap, compMap }
  migrationMap:   null,   // loaded from /api/migration-map
  pathMap:        null,   // loaded from /api/path-map
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
};

let _uid = 0;
const uid = () => `id_${++_uid}`;

let _settingsTab = 'connection';
let _mappingExpanded = null; // currently expanded resourceType string
let _view = 'canvas'; // 'canvas' | 'settings'

// ── Canvas persistence ────────────────────────────────────────────────────────
const CANVAS_KEY = 'aem_canvas_draft';

function saveCanvas() {
  try {
    localStorage.setItem(CANVAS_KEY, JSON.stringify({
      sections:  S.sections,
      meta:      S.meta,
      collapsed: [...S.collapsed],
    }));
  } catch (_) {}
}

function loadCanvas() {
  try {
    const raw = localStorage.getItem(CANVAS_KEY);
    if (!raw) return false;
    const { sections, meta, collapsed } = JSON.parse(raw);
    if (Array.isArray(sections) && sections.length > 0) {
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

  const [configRes, sectionsRes, migrRes, pathMapRes] = await Promise.all([
    fetch('/api/config'), fetch('/api/sections'), fetch('/api/migration-map'), fetch('/api/path-map')
  ]);
  if (configRes.ok)    S.config       = await configRes.json();
  if (sectionsRes.ok)  S.sectionsLib  = await sectionsRes.json();
  if (migrRes.ok)      S.migrationMap = await migrRes.json();
  if (pathMapRes.ok)   S.pathMap      = await pathMapRes.json();

  if (hasDraft) S.sel = S.sections.length > 0 ? { secId: S.sections[0].id } : null;
  S._draftRestored = hasDraft;
  render();
})();

// ── Render ───────────────────────────────────────────────────────────────────
function render() {
  saveCanvas();
  document.getElementById('root').innerHTML = html();
  bind();
}

function html() {
  return `
    ${S.result ? resultOverlayHtml() : ''}
    ${S.modal === 'block-picker'      ? blockPickerModalHtml()     : ''}
    ${S.modal === 'save-template'     ? saveTemplateModalHtml()    : ''}
    ${S.modal === 'bundle-save'       ? bundleSaveModalHtml()      : ''}
    ${topbarHtml()}
    ${S._draftRestored ? `<div class="draft-banner" id="draft-banner">
      Draft restored — ${S.sections.length} section${S.sections.length !== 1 ? 's' : ''} reloaded from your last session.
      <button class="draft-dismiss" id="btn-dismiss-draft">✕</button>
    </div>` : ''}
    ${S._migrResult ? `<div class="draft-banner migr-banner">
      ✓ Filled <strong>${S._migrResult.filled} block${S._migrResult.filled !== 1 ? 's' : ''}</strong> from <em>${x(S._migrResult.fileName)}</em>${S._migrResult.skipped > 0 ? ` — ${S._migrResult.skipped} skipped (no XML match)` : ''}. Review the canvas then click Create.
      <button class="draft-dismiss" id="btn-dismiss-migr">✕</button>
    </div>` : ''}
<div class="workspace">
      ${paletteHtml()}
      ${_view === 'canvas' ? canvasHtml() + propsHtml() : settingsViewHtml()}
    </div>`;
}

function topbarHtml() {
  return `<div class="topbar">
    <h1>⚡ AEM Page Builder</h1>
    <div class="view-tabs">
      <button class="vtab ${_view === 'canvas' ? 'vtab-active' : ''}" id="vtab-canvas">Canvas</button>
      <button class="vtab ${_view === 'settings' ? 'vtab-active' : ''}" id="vtab-settings">⚙ Settings</button>
    </div>
    ${S.conn.pageName
      ? `<span class="page-slug">${x(S.conn.parentPath)}/<strong>${x(S.conn.pageName)}</strong></span>`
      : `<span class="page-slug" style="opacity:.5">no page name set</span>`}
    <span class="conn-badge ${S.conn.ok ? 'ok' : 'idle'}" style="margin-left:4px">
      ${S.conn.ok ? '✓ Connected' : '○ Not tested'}
    </span>
    ${S.sections.length > 0 ? `<button class="btn btn-ghost btn-sm draft-clear-btn" id="btn-clear-draft" title="Discard all sections">✕ Clear</button>` : ''}
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

const PALETTE_GROUPS = [
  { label: 'Sections',  ids: ['section', 'grid-container'] },
  { label: 'Content',   ids: ['custom-title', 'text-container', 'custom-image', 'breadcrumb', 'eyebrow-text', 'separator'] },
  { label: 'Hero',      ids: ['hero-container'] },
  { label: 'Media',     ids: ['brightcove-video', 'video', 'brightcove-podcast-player'] },
  { label: 'Rich Content', ids: ['accordion', 'quote', 'linklist', 'tabs', 'table', 'carousel', 'teaser'] },
  { label: 'Navigation', ids: ['cta', 'tag-utility-nav', 'navigation-content'] },
  { label: 'Data',      ids: ['editorial-feed', 'story-card', 'story-cards', 'news-feed', 'pipeline', 'press-releases', 'product-listing', 'fact-card', 'search'] },
];

function paletteHtml() {
  const isLib = S.paletteTab === 'sections';
  return `<aside class="palette">
    <div class="palette-tabs">
      <button class="ptab ${isLib ? '' : 'active'}" data-ptab="components">Components</button>
      <button class="ptab ${isLib ? 'active' : ''}" data-ptab="sections">
        Sections ${S.sectionsLib.length ? `<span class="ptab-count">${S.sectionsLib.length}</span>` : ''}
      </button>
    </div>
    ${isLib ? sectionLibHtml() : componentsTabHtml()}
  </aside>`;
}

function componentsTabHtml() {
  const groups = PALETTE_GROUPS.map(g => {
    const items = g.ids.map(id => {
      const comp = S.config?.compMap?.[id];
      const label = comp?.title || id;
      const icon  = COMP_ICONS[id] || '□';
      return `<div class="palette-item" data-add="${id}">
        <span class="pi-icon">${icon}</span>
        <span class="pi-label">${x(label)}</span>
      </div>`;
    }).join('');
    return `<div class="palette-group">
      <div class="palette-group-title">${g.label}</div>
      ${items}
    </div>`;
  }).join('');
  return `<div class="palette-scroll">${groups}</div>`;
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
  return `<div class="section-lib-card" data-add-section="${x(def.id)}" title="${x(def.description || '')}">
    <div class="slc-thumb">
      ${sectionThumbnailSvg(def)}
      <span class="slc-add">+</span>
    </div>
    <div class="slc-body">
      <div class="slc-title">${x(def.title)}${badge}</div>
      ${def.description ? `<div class="slc-desc">${x(def.description)}</div>` : ''}
    </div>
  </div>`;
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
          <p>Pick a predefined section from the <strong>Sections</strong> tab on the left,<br>or switch to <strong>Components</strong> to build manually.</p>
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
  if (!S.sel) return `<aside class="props-panel"><div class="props-empty">Select a component to edit its properties.</div></aside>`;

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

  if (!item) return `<aside class="props-panel"><div class="props-empty">Select a component.</div></aside>`;

  const model  = S.config?.modelMap?.[item.type];
  const fields = model?.fields || [];
  const formHtml = renderFields(fields, item.props, item.id);

  return `<aside class="props-panel">
    <div class="props-header">
      <div class="ph-type">${x(typeLabel)}</div>
    </div>
    <div class="props-scroll">
      ${formHtml || `<div class="props-empty">No editable fields for this component.</div>`}
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

    case 'ngaem:dynamic-picklist':
      return `<div class="field">
        <label>${x(label)}</label>
        <input type="text" ${attr} value="${x(String(val))}" placeholder="CSS class name"/>${hint}
      </div>`;

    default:
      return `<div class="field">
        <label>${x(label)}</label>
        <input type="text" ${attr} value="${x(String(val))}"/>${hint}
      </div>`;
  }
}

// ── Settings view (full-panel) ────────────────────────────────────────────────
function settingsViewHtml() {
  return `<div class="settings-view">
    <div class="sv-tabs">
      <button class="sv-tab ${_settingsTab === 'connection' ? 'sv-tab-active' : ''}" id="stab-settings">Connection</button>
      <button class="sv-tab ${_settingsTab === 'mappings'   ? 'sv-tab-active' : ''}" id="stab-mappings">Mappings</button>
      <button class="sv-tab ${_settingsTab === 'paths'      ? 'sv-tab-active' : ''}" id="stab-paths">Paths</button>
    </div>
    <div class="sv-body">
      ${_settingsTab === 'connection' ? connectionTabHtml()
      : _settingsTab === 'mappings'  ? mappingTabHtml()
      :                                pathsTabHtml()}
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
      </div>` : ''}
    </div>`;
  }).join('');

  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
    <span style="font-size:.75rem;color:var(--muted)">${Object.keys(cmap).length} component mappings</span>
    <button class="btn btn-primary btn-sm" id="btn-save-mapping">Save Mappings</button>
  </div>
  <div class="mapping-list">${rows || '<div class="props-empty" style="padding:20px;text-align:center">No migration map loaded.</div>'}</div>`;
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
      groups = PALETTE_GROUPS.filter(g => g.label !== 'Sections');
    } else {
      const allowedIds = S.config?.filterMap?.[blk?.type] || [];
      title  = 'Add Item';
      groups = [{ label: 'Items', ids: allowedIds }];
    }
  } else {
    groups = PALETTE_GROUPS.filter(g => g.label !== 'Sections');
  }

  const groupsHtml = groups.map(g => {
    const items = g.ids.map(id => {
      const comp = S.config?.compMap?.[id];
      if (!comp) return '';
      return `<div class="picker-item" data-pick="${id}">
        <span class="pi2-icon">${COMP_ICONS[id] || '□'}</span>
        <span class="pi2-label">${x(comp.title || id)}</span>
      </div>`;
    }).join('');
    if (!items.trim()) return '';
    return `<div class="picker-group-title">${g.label}</div>
      <div class="picker-grid">${items}</div>`;
  }).join('');

  return `<div class="modal-overlay" id="modal-overlay">
    <div class="modal modal-lg">
      <div class="modal-header">
        <h2>${title}</h2>
        <button class="modal-close" id="modal-close">✕</button>
      </div>
      <div class="modal-body">
        <input class="picker-search" id="picker-search" placeholder="Search components…" autocomplete="off"/>
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
    S.sections = data.sections.map(sec => ({
      ...sec, id: uid(),
      blocks: (sec.blocks || []).map(blk => ({
        ...blk, id: uid(),
        children: (blk.children || []).map(ch => ({ ...ch, id: uid(), children: [] }))
      }))
    }));
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

    // Build pool: EDS block type → [{ props, children }, ...]  (type already mapped by server)
    const pool = {};
    for (const comp of (data.ordered || [])) {
      (pool[comp.type] = pool[comp.type] || []).push({ props: comp.props, children: comp.children || [] });
    }

    // Walk canvas and fill blocks by type (sequential)
    let filled = 0, skipped = 0;
    function fillBlock(canvasBlk) {
      const queue = pool[canvasBlk.type];
      if (!queue?.length) { skipped++; return; }
      const src = queue.shift();
      Object.assign(canvasBlk.props, src.props);
      if (src.children.length > 0) {
        canvasBlk.children = src.children.map(ch => ({ ...ch, id: uid(), children: [] }));
      }
      filled++;
    }
    for (const sec of S.sections) {
      for (const blk of (sec.blocks || [])) {
        fillBlock(blk);
        for (const child of (blk.children || [])) fillBlock(child);
      }
    }

    if (data.meta) Object.assign(S.meta, data.meta);

    S.modal = null;
    S._migrResult = { filled, skipped, fileName: file.name };
    render();
  } catch (e) {
    if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">${x(e.message)}</div>`;
  }
}

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

  const ueUrl = buildUeUrl(r.path);
  return `<div class="result-overlay">
    <div class="result-box">
      <div class="rb-icon">🎉</div>
      <h2>Page Created!</h2>
      <p style="font-size:.82rem;word-break:break-all;color:var(--muted)">${x(r.path)}</p>
      <div class="rb-actions">
        <a class="btn btn-primary" href="${x(ueUrl)}" target="_blank">Open in Universal Editor</a>
        <button class="btn btn-ghost" id="btn-close-result">Close</button>
      </div>
    </div>
  </div>`;
}

// ── Events ────────────────────────────────────────────────────────────────────
function bind() {
  // Topbar
  on('btn-create', 'click', doCreate);
  on('vtab-canvas',   'click', () => { _view = 'canvas';   render(); });
  on('vtab-settings', 'click', () => { _view = 'settings'; render(); });
  on('btn-clear-draft', 'click', () => {
    if (!confirm('Clear all sections and start fresh?')) return;
    S.sections = []; S.meta = {}; S.collapsed.clear(); S.sel = null;
    localStorage.removeItem(CANVAS_KEY);
    render();
  });
  on('btn-dismiss-draft', 'click', () => { S._draftRestored = false; render(); });
  on('btn-dismiss-migr',  'click', () => { S._migrResult = null; render(); });

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
      if (e.target.closest('[data-del-blk],[data-move-blk],[data-pick-child],[data-sel-child]')) return;
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

  on('stab-settings', 'click', () => { _settingsTab = 'connection'; render(); });
  on('stab-mappings', 'click', () => { _settingsTab = 'mappings';   render(); });
  on('stab-paths',    'click', () => { _settingsTab = 'paths';      render(); });

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

  // Mapping tab
  on('btn-save-mapping', 'click', saveMigrationMap);

  qAll('[data-expand-rt]').forEach(el =>
    el.addEventListener('click', () => {
      _mappingExpanded = _mappingExpanded === el.dataset.expandRt ? null : el.dataset.expandRt;
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

  // Block picker search
  on('picker-search', 'input', () => {
    const q = document.getElementById('picker-search')?.value.toLowerCase() || '';
    qAll('.picker-item').forEach(el => {
      const label = el.querySelector('.pi2-label')?.textContent.toLowerCase() || '';
      el.style.display = label.includes(q) ? '' : 'none';
    });
  });

  // Props panel — live field sync
  qAll('[data-item][data-prop]').forEach(el => {
    const ev = el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(ev, () => syncProp(el));
  });

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

async function doCreate() {
  const { aemHost, username, password, parentPath, pageName } = S.conn;
  if (!aemHost || !username || !password || !parentPath || !pageName) {
    _view = 'settings'; render(); return;
  }
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
