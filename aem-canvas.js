// ── AEM classic JCR  →  EDS canvas (sections[]) converter ────────────────────
// Structural rules derived + validated across the migrated-page corpus (see _verify.js):
//   • container                       → section
//   • container w/ backgroundImage    → section whose first block is a hero-container
//   • container wrapping grid(s)       → grid-container  (+ bg-<hex> class from backgroundColor)
//   • grid `columns[w…]`               → N sibling grid-sections, each grid-cols-w, in column order
//   • par_RC parsys                    → the grid-section for column C  (missing par = empty spacer col)
//   • nested containers                → collapse into the enclosing section
//   • experiencefragment / inline sep  → dropped as page chrome / noise
// Leaf block mapping + prop renames reuse migration-map.json (same logic as server.js walkXmlNode).
//
// Output shape is exactly what buildJcr() in server.js consumes:
//   section        : { type, props, blocks:[ block ] }
//   grid-container : { type:'grid-container', props, blocks:[ grid-section ] }
//   grid-section   : { type:'grid-section', props, children:[ block ] }
//   block          : { type, props, children:[ item ] }
const fs = require('fs');
const path = require('path');

const load = f => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')); } catch { return {}; } };
const migrationMap = load('migration-map.json');
const styleMap     = load('style-map.json');
const pathMap      = load('path-map.json');
const componentMap = migrationMap.componentMap || {};
const JCR_SYS_SET  = new Set(migrationMap.jcrSystemProps || []);
const WRITEBACK_SKIP = new Set(['cq:styleIds', 'textIsRich', 'cq:lastModified', 'cq:lastModifiedBy',
  'cq:template', 'cq:designPath', 'cq:tags']);

// ── helpers on the object-mode parsed tree (attributes prefixed '@') ──────────
const RT = n => (n && n['@sling:resourceType'] || '').trim();
const isGrid      = rt => rt.includes('/grid/');
const isContainer = rt => rt.includes('/container/') && !rt.includes('/form/');
function isLayoutWrapper(rt) {
  if (!rt) return true;
  const last = rt.split('/').filter(Boolean).pop();
  return last === 'responsivegrid' || last === 'parsys' || last === 'iparsys' ||
    rt.startsWith('wcm/foundation/') || rt.startsWith('foundation/components/');
}
const isXF = rt => rt.includes('/experiencefragment');
// child element entries of a node, in document order (skip attributes / text)
const childEntries = node => Object.entries(node).filter(([k, v]) =>
  !k.startsWith('@') && k !== '#text' && v && typeof v === 'object');

function transformPath(value) {
  if (typeof value !== 'string') return value;
  if (value.includes('youtube-nocookie.com')) value = value.replace(/youtube-nocookie\.com/g, 'youtube.com');
  // YouTube embed URLs aren't playable in the EDS video block — convert to watch?v= form.
  value = value.replace(/youtube\.com\/embed\/([\w-]+)(\?[^\s"]*)?/g, 'youtube.com/watch?v=$1');
  if (!value.startsWith('/content/')) return value;
  if (value.startsWith('/content/dam/')) {
    let up = value;
    for (const r of (pathMap.damPrefixRules || [])) if (r.aemPrefix && value.startsWith(r.aemPrefix)) { up = (r.edsPrefix || '') + value.slice(r.aemPrefix.length); break; }
    if (up.includes('content-fragments')) return up;
    const dm = (pathMap.assetMap || {})[up];
    return (dm && dm.trim()) ? dm.trim() : up;
  }
  for (const r of (pathMap.contentPrefixRules || [])) if (r.aemPrefix && value.startsWith(r.aemPrefix)) return (r.edsPrefix || '') + value.slice(r.aemPrefix.length);
  return value;
}

// mirror of server.js extractPropsFromXmlNode
function extractProps(node, mapping) {
  const renames   = mapping?.propRenames || {};
  const skipSet   = new Set([...(mapping?.skipProps || []), ...JCR_SYS_SET, ...WRITEBACK_SKIP]);
  const invertSet = new Set(mapping?.invertBoolProps || []);
  const props = {};
  for (const [k, v] of Object.entries(node)) {
    if (!k.startsWith('@')) continue;
    const key = k.slice(1);
    if (skipSet.has(key) || key.startsWith('xmlns:') || key.startsWith('cq:')) continue;
    let val = typeof v === 'string' ? v.replace(/^\{[A-Za-z]+\}/, '') : v;
    if (val !== null && typeof val === 'object') continue;
    if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) val = val.slice(1, -1).trim();
    if (invertSet.has(key)) { if (val === 'true') val = 'false'; else if (val === 'false') val = 'true'; }
    if (val !== '' && val != null) props[renames[key] || key] = transformPath(val, pathMap);
  }
  // e.g. carousel: totalSlides = number of child slide components
  if (mapping?.countChildrenAsProp) {
    const src = (mapping.childContainer && node[mapping.childContainer]) || node;
    props[mapping.countChildrenAsProp] = String(childEntries(src).filter(([, c]) => RT(c)).length);
  }
  return props;
}

// AEM's default title/text width (cmp-title-xx-large → width-xx-large). EDS omits it everywhere —
// it's used on <1% of blocks (163 of the whole corpus) and setting it distorts the layout, e.g.
// the hero title/text. Dropped globally at the source so no block (title, text-container, …) gets it.
const DROP_CLASS = new Set(['width-xx-large']);
// Accordion Expand/Collapse-All labels by page language. The AEM accordion has no labels, and EDS
// localizes them per language. en/es/el are corpus-confirmed from the migrated twins; the rest are
// standard translations of "Expand All"/"Collapse All".
const ACCORDION_LABELS = {
  en: ['Expand All', 'Collapse All'],            de: ['Alle erweitern', 'Alle reduzieren'],
  fr: ['Tout développer', 'Tout réduire'],       es: ['Expandir todo', 'Contraer todo'],
  it: ['Espandi tutto', 'Comprimi tutto'],       pt: ['Expandir tudo', 'Recolher tudo'],
  nl: ['Alles uitvouwen', 'Alles samenvouwen'],  el: ['Ανάπτυξη όλων', 'Σύμπτυξη όλων'],
  cs: ['Rozbalit vše', 'Sbalit vše'],            da: ['Udvid alle', 'Skjul alle'],
  fi: ['Laajenna kaikki', 'Tiivistä kaikki'],    hu: ['Az összes kibontása', 'Az összes összecsukása'],
  bg: ['Разгъване на всички', 'Свиване на всички'], he: ['הרחבת הכול', 'כיווץ הכול'], iw: ['הרחבת הכול', 'כיווץ הכול'],
  ja: ['すべて展開', 'すべて折りたたむ'],          ko: ['모두 펼치기', '모두 접기'],
  zh: ['全部展开', '全部折叠'],                    'zh-tw': ['全部展開', '全部收合'],
  pl: ['Rozwiń wszystko', 'Zwiń wszystko'],      ru: ['Развернуть все', 'Свернуть все'],
  sk: ['Rozbaliť všetko', 'Zbaliť všetko'],      sl: ['Razširi vse', 'Strni vse'],
  sv: ['Expandera alla', 'Komprimera alla'],     tr: ['Tümünü genişlet', 'Tümünü daralt'],
  no: ['Utvid alle', 'Skjul alle'],              uk: ['Розгорнути все', 'Згорнути все'],
};
function styleIdClasses(node) {
  const raw = node['@cq:styleIds'];
  if (!raw || !Object.keys(styleMap).length) return '';
  const ids = String(raw).replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
  return ids.map(id => styleMap[id]?.edsClass).filter(c => c && !DROP_CLASS.has(c)).join(',');
}

// AEM leaf component node → EDS block { type, props, children }
function mapLeaf(node) {
  const rt = RT(node);
  const mapping = componentMap[rt];
  const props = extractProps(node, mapping);
  const cls = styleIdClasses(node);
  if (cls) props.classes_customDynamicClass = props.classes_customDynamicClass ? props.classes_customDynamicClass + ',' + cls : cls;
  const propEds = mapping?.propEdsType;
  const rawPropVal = propEds ? (node[`@${propEds.prop}`] || '').trim() : '';
  let type = (propEds?.map?.[rawPropVal]) || mapping?.edsType || rt.split('/').filter(Boolean).pop();
  // propEdsTypeMatch: pick the EDS block by a substring of a prop (e.g. dashboardcards
  // fragmentPath ".../facts/..." → fact-card, ".../link-lists/..." → dashboard-card-link-list).
  const pm = mapping?.propEdsTypeMatch;
  if (pm) {
    const v = String(node[`@${pm.prop}`] || '');
    for (const [needle, t] of Object.entries(pm.contains || {})) { if (v.includes(needle)) { type = t; break; } }
  }
  normalizeBlock({ type, props });   // separator = Standard/no-line, eyebrow = standard+bold

  // Breadcrumb homePagePath: derive from the page locale + AEM startLevel (the "depth").
  // AEM path = /content/abbvie-com2/<rel>; content+site = 2 fixed segments, so keep
  // (startLevel-2) rel segments (startLevel 4 → country/lang locale home).
  if (type === 'breadcrumb' && _ctxRel) {
    const startLevel = parseInt(node['@startLevel'] || '4') || 4;
    const keep = Math.max(1, startLevel - 2);
    const localePath = _ctxRel.split('/').slice(0, keep).join('/');
    if (localePath) props.homePagePath = transformPath('/content/abbvie-com2/' + localePath, pathMap);
  }
  // Video: overlay the content ON the poster (content-default is "bottom" = below the block),
  // and set the poster mime type (poster URL is mapped fileReference→placeholderImage). Applies to
  // both youtube (`video`) and `brightcove-video` — EDS uses "none" for ~80% of each.
  if (type === 'video' || type === 'brightcove-video') {
    props.videoContentLayout = 'none';
    if (props.placeholderImage) {
      const ext = (String(props.placeholderImage).split('?')[0].split('.').pop() || '').toLowerCase();
      props.placeholderImageMimeType = MIME[ext] || 'image/jpeg';
    }
  }
  // Accordion: build classes_customDynamicClass faithfully from the AEM styleIds (theme/align)
  // plus the heading size EDS accordions always carry (h5-size; h4-size when the AEM
  // headingElement is h4). AEM width classes are cmp-accordion-{size} → EDS accordion-{size}.
  // Setting it here guarantees the content-default's placeholder classes never leak through.
  if (type === 'accordion') {
    const set = new Set(
      String(props.classes_customDynamicClass || '').split(',').map(s => s.trim()).filter(Boolean)
        .map(c => c.replace(/^cmp-accordion-/, 'accordion-'))   // AEM width class → EDS width class
    );
    set.delete('light-theme');   // default theme — EDS omits it (89% of accordions carry no theme)
    // Desktop Width: the ONLY AEM signal is the grid-context styleId (half-page grid → accordion-
    // medium, full-page-5 → accordion-large; ~70% of those pairs). Most accordion widths are a
    // per-page EDS redesign choice absent from the AEM XML, so with no signal we leave it unset
    // (many live EDS accordions also carry no width). Alignment (align-center) already flows
    // through from the AEM align styleId via styleIdClasses.
    if (![...set].some(c => /^accordion-/.test(c))) {
      const aem = String(node['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',')
        .map(id => styleMap[id]?.aemClass || '').join(' ');
      const cmp = aem.match(/cmp-accordion-([a-z-]+)/);   // explicit AEM accordion width (accordion-only)
      if (cmp) set.add('accordion-' + cmp[1]);
      else if (/half-page-2/.test(aem)) set.add('accordion-medium');
      else if (/full-page-5/.test(aem)) set.add('accordion-large');
    }
    if (![...set].some(c => /^h[1-6]-size$/.test(c))) {
      const he = String(node['@headingElement'] || '').toLowerCase();
      set.add(he === 'h4' ? 'h4-size' : 'h5-size');
    }
    props.classes_customDynamicClass = [...set].join(',');
    // Localize the Expand/Collapse-All labels from the page language (AEM carries no labels).
    const lbl = ACCORDION_LABELS[String(_ctxRel ? _ctxRel.split('/')[1] : '').toLowerCase()];
    if (lbl) { props.expandAllLabel = lbl[0]; props.collapseAllLabel = lbl[1]; }
  }
  // Custom-title: always populate the Decorative Title Size. An explicit AEM size styleId (h2-size…)
  // wins; otherwise derive it from the semantic heading (H3 → h3-size). This equals the heading tag's
  // own size (verified: base h3 = .h3-size = font-size-26), so it's the visual size made explicit.
  // custom-title.css only defines h1..h5, so H6 → h5-size. (width-xx-large already dropped globally.)
  if (type === 'custom-title') {
    const parts = String(props.classes_customDynamicClass || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.some(c => /^h[1-6]-size$/.test(c))) {
      const m = /^h([1-6])$/.exec(String(props.titleType || '').toLowerCase());
      if (m) parts.push('h' + Math.min(5, parseInt(m[1])) + '-size');
    }
    props.classes_customDynamicClass = parts.join(',');
  }
  // Eyebrow-text: the AEM header carries no eyebrow variation of its own — the EDS variation is a
  // redesign remap of the header's styleId (dark-theme → divider, full-page-5 grid → mini; no
  // style → no variation, the dominant case). Derive it faithfully from the raw AEM styleIds.
  if (type === 'eyebrow-text') {
    const ids = String(node['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
    const aemClasses = ids.map(id => styleMap[id]?.aemClass).filter(Boolean);
    const out = new Set();
    for (const c of aemClasses) {
      if (c === 'dark-theme') out.add('divider');
      else if (/full-page-5/.test(c)) out.add('mini');
    }
    props.classes_customDynamicClass = [...out].join(',');
  }
  // Teaser: EDS teasers carry a heading-size class the AEM teaser doesn't declare — teaser-h2 is the
  // plurality (172/348), so default it unless a size already derived. teaser-internal-link is added
  // when the CTA link is internal (a path/# rather than an external http(s) URL).
  if (type === 'teaser') {
    const set = new Set(String(props.classes_customDynamicClass || '').split(',').map(s => s.trim()).filter(Boolean));
    if (![...set].some(c => /^teaser-h[1-6]/.test(c))) set.add('teaser-h2');
    const link = String(props.buttonURL || props.link || '').trim();
    if (link && /^(\/|#)/.test(link)) set.add('teaser-internal-link');
    props.classes_customDynamicClass = [...set].join(',');
  }

  // AEM inline richtext typography classes (body-unica-*) → the block's classes_commonCustomClass
  // ("Custom Class"), and unwrap ALL <span>s so the text isn't double-styled. Only body-unica-*
  // is kept — theme classes (light-font) and Word-paste junk (BCX*, NormalTextRun, SCXW*…) are dropped.
  const existing = String(props.classes_commonCustomClass || '').split(/\s+/).filter(Boolean);
  const nonBody = existing.filter(c => !/^body-unica/.test(c));
  const bodyFreq = {};                                    // body-unica-* → occurrence count
  existing.filter(c => /^body-unica/.test(c)).forEach(c => (bodyFreq[c] = (bodyFreq[c] || 0) + 1));
  for (const k of Object.keys(props)) {
    const v = props[k];
    if (typeof v !== 'string' || !/<span[^>]*\sclass=/i.test(v)) continue;
    for (const m of v.matchAll(/<span[^>]*\sclass="([^"]+)"[^>]*>/gi))
      m[1].split(/\s+/).forEach(c => { if (/^body-unica/.test(c)) bodyFreq[c] = (bodyFreq[c] || 0) + 1; });
    props[k] = v.replace(/<span[^>]*>/gi, '').replace(/<\/span>/gi, '');   // unwrap spans, keep inner content
  }
  // A text-container carries ONE block-level body size (EDS twins never have >1); when the richtext
  // mixes sizes across spans, keep only the DOMINANT (most-frequent) one.
  const topBody = Object.entries(bodyFreq).sort((a, b) => b[1] - a[1])[0];
  const outCls = [...nonBody, ...(topBody ? [topBody[0]] : [])];
  if (outCls.length) props.classes_commonCustomClass = outCls.join(' ');

  // Text alignment lives INLINE in the richtext (`text-align: left|center|right`); EDS lifts it to
  // an `align-*` class on the text-container. Use the dominant alignment across the block's markup.
  if (type === 'text-container') {
    const alignFreq = {};
    for (const v of Object.values(props))
      if (typeof v === 'string')
        for (const m of v.matchAll(/text-align\s*:\s*(left|center|right)/gi))
          alignFreq[m[1].toLowerCase()] = (alignFreq[m[1].toLowerCase()] || 0) + 1;
    const topAlign = Object.entries(alignFreq).sort((a, b) => b[1] - a[1])[0];
    if (topAlign) {
      const cls = new Set(String(props.classes_customDynamicClass || '').split(',').map(s => s.trim()).filter(Boolean));
      if (![...cls].some(c => /^align-/.test(c))) cls.add('align-' + topAlign[0]);
      props.classes_customDynamicClass = [...cls].join(',');
    }
  }

  // accordion-style: typed sub-items collected from child nodes
  if (mapping?.childType && mapping?.childPropRenames) {
    const items = [];
    const src = (mapping.childContainer && node[mapping.childContainer] && typeof node[mapping.childContainer] === 'object') ? node[mapping.childContainer] : node;
    for (const [, v] of childEntries(src)) {
      const ip = {};
      for (const [pk, pv] of Object.entries(v)) {
        if (!pk.startsWith('@')) continue;
        const bk = pk.slice(1);
        if (Object.prototype.hasOwnProperty.call(mapping.childPropRenames, bk) && pv !== '' && pv != null) {
          let cv = typeof pv === 'string' ? pv.replace(/^\{[A-Za-z]+\}/, '') : pv;
          if (typeof cv === 'string' && cv.startsWith('[') && cv.endsWith(']')) cv = cv.slice(1, -1).trim();
          ip[mapping.childPropRenames[bk]] = transformPath(cv, pathMap);
        }
      }
      items.push({ type: mapping.childType, props: ip, children: [] });
    }
    // NOTE: a dynamic linklist (listFrom=children) legitimately has no static items —
    // EDS renders it from parentPage/linkSource at request time, so we keep the config
    // props and leave children empty rather than baking in a stale snapshot.
    return { type, props, children: items };
  }
  // single content child (e.g. text → text-container-text)
  if (mapping?.childType && mapping?.childProp && props[mapping.childProp] !== undefined) {
    const cv = props[mapping.childProp];
    delete props[mapping.childProp];
    return { type, props, children: [{ type: mapping.childType, props: { [mapping.childProp]: cv }, children: [] }] };
  }
  return { type, props, children: [] };
}

// A leaf that expands into MULTIPLE sibling blocks. A carousel's slides are stored as child
// components in AEM, but EDS lays them out as sibling blocks right AFTER the carousel controller
// (the carousel JS picks up the following blocks as slides). So emit [carousel, ...mapped slides].
function mapLeafExpanded(node) {
  const block = mapLeaf(node);
  if (/components\/carousel/.test(RT(node))) {
    const slides = [];
    for (const [, child] of childEntries(node))
      if (componentMap[RT(child)]) slides.push(mapLeaf(child));   // e.g. image slide → custom-image
    return [block, ...slides];
  }
  return [block];
}

// recursively collect leaf blocks under a container (flatten nested containers / parsys),
// skipping grids (handled separately) and inline separators/XF chrome.
function collectLeaves(node, out) {
  for (const [, child] of childEntries(node)) {
    const rt = RT(child);
    if (!rt || isLayoutWrapper(rt)) { collectLeaves(child, out); continue; }
    if (isXF(rt)) continue;
    if (isGrid(rt)) { collectLeaves(child, out); continue; }      // nested grid → flatten its cell content
    if (isContainer(rt)) { collectLeaves(child, out); continue; } // nested container → flatten
    out.push(...mapLeafExpanded(child));
  }
}

// does this container (through parsys wrappers, not through nested containers) hold a grid?
function containerHasGrid(node) {
  for (const [, child] of childEntries(node)) {
    const rt = RT(child);
    if (isGrid(rt)) return true;
    if (!rt || isLayoutWrapper(rt)) { if (containerHasGrid(child)) return true; }
  }
  return false;
}

const bgClass = node => {
  const c = (node['@backgroundColor'] || '').replace('#', '').toLowerCase();
  return (c && c !== 'ffffff') ? `bg-${c}` : '';
};
// AEM container backgroundImageReference → EDS section/grid-container background props.
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
function bgImageProps(node) {
  const ref = node['@backgroundImageReference'];
  if (!ref) return {};
  const file = ref.split('/').pop();
  const ext = (file.split('.').pop() || '').toLowerCase();
  return {
    background: transformPath(ref, pathMap),
    backgroundAlt: file.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '),
    backgroundMimeType: MIME[ext] || 'image/jpeg',
  };
}

// EDS section/grid-container class defaults, in two tiers so the AEM XML stays the source of truth:
//   ALWAYS  — supplied on every node because they're required and AEM can't carry them:
//     • grid-container `content-regular` — the EDS width baseline (measured: removing it collapses
//       grid-container match 63→11%); skipped when AEM already gives a width.
//     • grid-container `no-side-margin` — required for grid-containers to render correctly.
//   FALLBACK — padding/bottom-margin, added ONLY when NOTHING could be inferred from the AEM XML
//     (the node has no mapped styleIds / background). When AEM does specify styling we use only
//     that — no invented padding/margin — which keeps the output faithful to the source.
const STYLE_DEFAULTS_ALWAYS = {
  section:          [],
  'grid-container': ['content-regular', 'no-side-margin'],
};
const STYLE_DEFAULTS_FALLBACK = {
  section:          ['regular-padding', 'no-bottom-margin', 'no-side-margin'],
  'grid-container': ['regular-padding', 'no-bottom-margin'],
};
const NOOP_CLASS = new Set(['height-default']);              // EDS omits the "default" height (no-op) on sections/grids
const isWidthCls  = c => ['content-wide', 'content-regular', 'content-narrow', 'full-width'].includes(c) || /^container-/.test(c);
const EXCL_RADIUS = new Set(['large-radius', 'medium-radius', 'small-radius', 'no-radius']);
const splitCls = arr => arr.filter(Boolean).flatMap(c => String(c).split(',')).map(c => c.trim()).filter(Boolean);
// merge template defaults into derived classes: derived (from AEM) wins on exclusive families
// (width/radius); ALWAYS defaults fill required gaps; FALLBACK padding/margin apply only when the
// AEM node yielded no styling at all (`derived` empty = nothing inferred).
function mergeDefaults(kind, derived) {
  const out = [...derived]; const has = new Set(derived);
  const hasW = derived.some(isWidthCls), hasR = derived.some(c => EXCL_RADIUS.has(c));
  const add = list => { for (const d of list) {
    if (has.has(d) || (isWidthCls(d) && hasW) || (EXCL_RADIUS.has(d) && hasR)) continue;
    out.push(d); has.add(d);
  } };
  add(STYLE_DEFAULTS_ALWAYS[kind] || []);
  if (!derived.length) add(STYLE_DEFAULTS_FALLBACK[kind] || []);   // nothing inferred from AEM → backfill
  return out;
}

// AEM hero background-color (hex) → EDS hero-item color-variation class. navy/accent-blue/purple/
// gray-medium are twin-confirmed; the light variants come from the EDS color tokens (inner-grid.css
// bg-<hex> → --color-*). Covers all 8 hexes seen on empty hero containers corpus-wide.
const HERO_COLOR = {
  '071d49': 'navy',        '0066f5': 'accent-blue',       '8a2ecc': 'purple',      'b9b4b4': 'gray-medium',
  'a6b5e0': 'blue-light',  '479ff8': 'accent-blue-light', 'a86bde': 'purple-light', 'f4f4f4': 'gray-light',
};
// Returns the color-class NAME for a non-white background, '' for an unmapped non-white color
// (still a hero — never drop it), or null when there's no color (not a color hero).
const heroColorOf = node => {
  const c = (node['@backgroundColor'] || '').replace('#', '').toLowerCase();
  return (c && c !== 'ffffff') ? (HERO_COLOR[c] || '') : null;
};

// Build the hero-container block from a container's background IMAGE or COLOR. The container's
// height/radius style-classes belong on the hero-container BLOCK (with the EDS overlay-height
// defaults) — not the section — or the hero renders collapsed/small.
function heroBlockOf(node) {
  const bgImg = node['@backgroundImageReference'];
  const cont = splitCls([styleIdClasses(node)]);   // color/image go on the ITEM, not these classes
  const height = cont.filter(c => /^height-/.test(c));
  // AEM hero containers carry a `large-radius` styleId, but the EDS hero redesign drops it (0 of
  // 414 twins keep large-radius); medium/small-radius, when present, ARE kept. And EDS heroes very
  // rarely set overlay-inner-height (13%) — the converter must NOT force it. overlay-height-short
  // stays (dropping it measurably worsened the match). Measured: these two changes 0%→21% exact.
  const radius = cont.filter(c => EXCL_RADIUS.has(c) && c !== 'large-radius');
  const heroDyn = [...(height.length ? height : ['height-short']), 'overlay-height-short', ...radius];
  let item;
  if (bgImg) {
    const alt = bgImg.split('/').pop().replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    const ext = (bgImg.split('.').pop() || '').toLowerCase();
    item = { type: 'hero-container-item', props: { image: transformPath(bgImg, pathMap), backgroundVariant: 'image', imageAlt: alt, imageMimeType: MIME[ext] || 'image/jpeg' }, children: [] };
  } else {
    // color hero (e.g. leader pages): the brand background color becomes the item's color variation.
    item = { type: 'hero-container-item', props: { backgroundVariant: 'color', classes_customDynamicClass: heroColorOf(node) || '' }, children: [] };
  }
  return { type: 'hero-container', props: { filter: 'hero-container', classes_customDynamicClass: heroDyn.join(',') }, children: [item] };
}
// section classes for a container: derived (minus height, which went to the hero block) + defaults
function sectionClasses(node) {
  const derived = splitCls([bgClass(node), styleIdClasses(node)]).filter(c => !/^height-/.test(c));
  return mergeDefaults('section', derived).join(',');
}
// A HERO section keeps the container's width/radius/margin styleIds (twins: 94% large-radius,
// 76% content-wide) but NOT height (on the hero block) and NOT the bg color/image (on the item).
function heroSectionClasses(node) {
  const derived = splitCls([styleIdClasses(node)]).filter(c => !/^height-/.test(c));
  return mergeDefaults('section', derived).join(',');
}
// A hero container = plain container (no grid inside) carrying a bg-image, OR an EMPTY container
// whose background is a known brand color (the color-variation hero, e.g. leader pages). The empty
// check keeps dark-theme CONTENT sections (which have children) from being mistaken for heroes.
const isColorHero = node => !childEntries(node).length && heroColorOf(node) !== null;
const isHeroContainer = node => isContainer(RT(node)) && !containerHasGrid(node) &&
  (!!node['@backgroundImageReference'] || isColorHero(node));

// Grid layout classification (derived from corpus): EDS drops two kinds of grid rows
// from the grid-section sequence and renders their content as plain / card blocks:
//   • full-width filler — one content column ≥10 wide, the rest gutters ≤2 (e.g. 1,11 / 10,2 / 1,10,1)
//   • card grid — every column width 4 AND the cells hold cardpagestory/story components
function gridInfo(grid) {
  const cols = grid.columns ? childEntries(grid.columns).map(([, it]) => parseInt(it['@columnWidth'] || '0')).filter(Boolean) : [];
  const maxW = cols.length ? Math.max(...cols) : 0;
  const isFiller = maxW >= 10 && cols.every(w => w === maxW || w <= 2);
  const allFour = cols.length > 0 && cols.every(w => w === 4);
  return { cols, isFiller, allFour };
}
function gridHasCards(grid) {
  let found = false;
  (function scan(n) {
    for (const [, c] of childEntries(n)) {
      if (found) return;
      const rt = RT(c);
      if (/cardpagestory|storyinfo|storypage/.test(rt)) { found = true; return; }
      if (!rt || isLayoutWrapper(rt) || isContainer(rt) || isGrid(rt)) scan(c);
    }
  })(grid);
  return found;
}
// A grid gets UNWRAPPED (its cells emitted as plain-section blocks instead of grid-sections)
// only for the cases EDS handles *deterministically* (validated across the corpus, zero regressions):
//   • card       — every column width 4 AND cells hold cardpagestory/story → EDS story-cards
//   • band       — one full-width column ≥10 with only ≤2 gutters and NO width-1 gutter (e.g. 10,2)
//   • spacer     — pure width-1 gutter grid (decorative spacer row)
// NOTE: `1,11` is intentionally NOT unwrapped — the data shows EDS keeps it ~half the time
// (kept in gr/el, dropped in us/en), so always-dropping it trades wins for losses. The
// RULES env var stays for future A/B measurement; default is the safe "band" set.
const _R = process.env.RULES || 'band';
function isUnwrapGrid(grid) {
  const g = gridInfo(grid);
  const maxW = g.cols.length ? Math.max(...g.cols) : 0;
  const card   = g.allFour && gridHasCards(grid);
  const band   = maxW >= 10 && g.cols.every(w => w === maxW || w <= 2) && !g.cols.includes(1);
  const spacer = g.cols.length > 0 && g.cols.every(w => w <= 1);
  if (_R === 'none') return false;
  if (_R === 'filler') return g.isFiller;             // aggressive (drops 1,11) — measurement only
  if (_R === 'all') return g.isFiller || card;
  return card || band || spacer;                      // 'band' (default, safe)
}

// grid node → push its columns as grid-section blocks into `blocks`
function expandGrid(grid, blocks) {
  const cols = grid.columns ? childEntries(grid.columns).map(([, it]) => String(it['@columnWidth'] || '')).filter(Boolean) : [];
  const rowCount = parseInt(grid['@rowCount'] || '1') || 1;
  for (let r = 1; r <= rowCount; r++) {
    for (let c = 1; c <= cols.length; c++) {
      const width = cols[c - 1];
      const gs = { type: 'grid-section', props: { style_container: 'grid-section', style_customDynamicClass: `grid-section,grid-cols-${width}` }, children: [] };
      const par = grid[`par_${r}${c}`];
      if (par && typeof par === 'object') collectLeaves(par, gs.children); // recurse: nested containers/grids flatten
      blocks.push(gs);
    }
  }
}

// emit sections for one top-level content node
function emitNode(node, sections) {
  const rt = RT(node);
  if (isContainer(rt)) {
    if (containerHasGrid(node)) {
      // ONE grid-container (bg image + section styles on it). Real grids → grid-sections.
      // Loose leaves that are direct children of the container (e.g. a leading/trailing
      // separator) are folded INTO the grid content — leading ones prepended to the first
      // content grid-section, trailing ones appended to the last — NOT emitted as their own
      // section. filler/card grids unwrap into that same buffer.
      // height-* belongs on grid-containers only when they're a background-IMAGE banner (twins keep
      // height-tall there); on color/plain grid-containers the height styleId is dropped.
      const gcDerived = splitCls([bgClass(node), styleIdClasses(node)]).filter(c => !NOOP_CLASS.has(c))
        .filter(c => node['@backgroundImageReference'] || !/^height-/.test(c));
      const gcCls = ['grid-container', ...mergeDefaults('grid-container', gcDerived)].join(',');
      const gc = { type: 'grid-container', props: { style_container: 'grid-container', style_customDynamicClass: gcCls, ...bgImageProps(node) }, blocks: [] };
      const leading = [], trailing = [];
      let firstContentGs = null, lastContentGs = null;
      const buf = () => (firstContentGs ? trailing : leading);
      (function scan(n) {
        for (const [, child] of childEntries(n)) {
          const crt = RT(child);
          if (isGrid(crt)) {
            if (isUnwrapGrid(child)) collectLeaves(child, buf());
            else {
              const start = gc.blocks.length;
              expandGrid(child, gc.blocks);
              for (let i = start; i < gc.blocks.length; i++) {
                if (gc.blocks[i].children && gc.blocks[i].children.length) { if (!firstContentGs) firstContentGs = gc.blocks[i]; lastContentGs = gc.blocks[i]; }
              }
            }
          } else if (!crt || isLayoutWrapper(crt)) scan(child);
          else if (isXF(crt)) continue;
          else if (isContainer(crt)) collectLeaves(child, buf());
          else buf().push(...mapLeafExpanded(child));
        }
      })(node);
      if (firstContentGs) {
        if (leading.length) firstContentGs.children.unshift(...leading);
        if (trailing.length) lastContentGs.children.push(...trailing);
      } else if (leading.length || trailing.length) {
        // grid has no content cell — put the loose leaves in their own section (fallback)
        sections.push({ type: 'section', props: { style_customDynamicClass: sectionClasses(node) }, blocks: [...leading, ...trailing] });
      }
      if (gc.blocks.length) sections.push(gc);
      return;
    }
    // plain / hero section (standalone; hero+content merging happens in aemToCanvas)
    const isHero = !!node['@backgroundImageReference'] || isColorHero(node);
    const blocks = [];
    if (isHero) blocks.push(heroBlockOf(node));
    collectLeaves(node, blocks);
    sections.push({ type: 'section', props: { style_customDynamicClass: isHero ? heroSectionClasses(node) : sectionClasses(node) }, blocks });
    return;
  }
  if (isGrid(rt)) {                     // bare top-level grid → wrap in a grid-container
    const cls = ['grid-container', ...mergeDefaults('grid-container', [])].join(',');
    const gc = { type: 'grid-container', props: { style_container: 'grid-container', style_customDynamicClass: cls }, blocks: [] };
    expandGrid(node, gc.blocks);
    sections.push(gc);
    return;
  }
  // bare leaf at top level → its own section
  sections.push({ type: 'section', props: {}, blocks: mapLeafExpanded(node) });
}

// current page's content-xml rel path (country/lang/…), used for breadcrumb homePagePath
let _ctxRel = null;

// find the content root (jcr:content) and walk its top-level content nodes
function aemToCanvas(jcrContent, opts) {
  _ctxRel = (opts && opts.rel) ? String(opts.rel).replace(/^\/+|\/+$/g, '') : null;
  const sections = [];
  // gather top-level content nodes: descend through layout wrappers, skip XF chrome
  const tops = [];
  (function gather(n) {
    for (const [, child] of childEntries(n)) {
      const rt = RT(child);
      if (isXF(rt)) continue;
      if (isContainer(rt) || isGrid(rt)) { tops.push(child); continue; }
      if (!rt || isLayoutWrapper(rt)) { gather(child); continue; }
      tops.push(child);                 // bare leaf
    }
  })(jcrContent);
  // Hero merge: EDS wraps the hero image + the following intro content into ONE section
  // (see sections/hero-*.json templates). AEM authors it as an empty bg-image container
  // followed by a sibling content container — merge them here.
  for (let i = 0; i < tops.length; i++) {
    const node = tops[i];
    if (isHeroContainer(node)) {
      const blocks = [heroBlockOf(node)];
      collectLeaves(node, blocks);                 // hero's own content, if any
      let j = i + 1;
      while (j < tops.length) {                     // absorb following plain content container(s)
        const nx = tops[j];
        if (isContainer(RT(nx)) && !nx['@backgroundImageReference'] && !containerHasGrid(nx) && !isColorHero(nx)) { collectLeaves(nx, blocks); j++; }
        else break;
      }
      i = j - 1;
      // Hero section keeps the container's width/radius/margin styleIds (height → hero block,
      // color/image → item). NOT bare — 1429 of 1438 twin hero sections carry classes.
      sections.push({ type: 'section', props: { style_customDynamicClass: heroSectionClasses(node) }, blocks });
      continue;
    }
    emitNode(node, sections);
  }
  return hoistTrailingSeparator(sections);
}

// The page-final separator (the spacer just above the footer) must live in its OWN bare section,
// never nested inside the last grid — verified: of 786 EDS pages ending in a separator, 0 nest it
// in a grid and 474 have it alone in a bare section. Extract it into a trailing standalone section.
function hoistTrailingSeparator(sections) {
  if (!sections.length) return sections;
  const last = sections[sections.length - 1];
  if (last.type === 'grid-container' && Array.isArray(last.blocks)) {
    for (let gi = last.blocks.length - 1; gi >= 0; gi--) {
      const kids = last.blocks[gi] && last.blocks[gi].children;
      if (!kids || !kids.length) continue;                       // skip empty grid-sections
      if (kids[kids.length - 1].type === 'separator') sections.push({ type: 'section', props: {}, blocks: [kids.pop()] });
      break;                                                     // only the last non-empty grid-section
    }
  } else if (last.type === 'section' && Array.isArray(last.blocks) && last.blocks.length > 1
             && last.blocks[last.blocks.length - 1].type === 'separator') {
    sections.push({ type: 'section', props: {}, blocks: [last.blocks.pop()] });
  }
  return sections;
}

// Normalize a single block's variant props in place. Returns 'separator'|'eyebrow'|null.
// Shared by generation (mapLeaf) and the in-place Fill button (normalizeSections).
function normalizeBlock(b) {
  if (!b || !b.props) return null;
  if (b.type === 'separator') {
    // Real EDS separators are 81% just a height spacer with NO variation class (divider 13%,
    // standard 6%). AEM separators carry no line/variation info, so emit height-only + no line —
    // don't force separator-standard (the old behavior) or keep separator-divider.
    const before = (b.props.classes_customDynamicClass || '') + '|' + b.props.showLine;
    let cls = String(b.props.classes_customDynamicClass || '').split(',').map(s => s.trim()).filter(Boolean)
      .filter(c => c !== 'separator-divider' && c !== 'separator-standard');
    if (!cls.some(c => /^separator-height-/.test(c))) cls.unshift('separator-height-24');
    b.props.classes_customDynamicClass = cls.join(',');
    b.props.showLine = '{Boolean}false';
    return before !== (b.props.classes_customDynamicClass + '|' + b.props.showLine) ? 'separator' : null;
  }
  // Eyebrow variation is derived from the AEM header styleIds at generation time (mapLeaf); it must
  // NOT be forced here. Post-hoc (Fill button / match-reuse) the styleIds are gone and the block
  // already carries its correct EDS variation, so leave it untouched.
  return null;
}
// Walk a canvas sections[] and normalize separators + eyebrows in place. Returns counts.
function normalizeSections(sections) {
  const stats = { separators: 0, eyebrows: 0 };
  const visit = b => { const r = normalizeBlock(b); if (r === 'separator') stats.separators++; else if (r === 'eyebrow') stats.eyebrows++; for (const c of (b.children || [])) visit(c); };
  for (const s of (sections || [])) for (const b of (s.blocks || [])) visit(b);
  return stats;
}

module.exports = { aemToCanvas, mapLeaf, normalizeBlock, normalizeSections };
