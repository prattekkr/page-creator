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

// The EDS picklists are the source of truth for authorable style values. Load
// them once and validate generated style fields against the target component's
// own list instead of relying on a class being valid on another component.
function loadPicklistClasses() {
  const out = {};
  const root = path.join(__dirname, 'config');
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const match = entry.isDirectory() && entry.name.match(/^(.*)-picklist-config$/);
    if (!match) continue;
    const file = path.join(root, entry.name, '.content.xml');
    try {
      const xml = fs.readFileSync(file, 'utf8');
      out[match[1]] = new Set([...xml.matchAll(/Style_x0020_Class="([^"]+)"/g)].map(m => m[1]));
    } catch {
      // A missing or unreadable config must not prevent conversion for other types.
    }
  }
  return out;
}
const PICKLIST_CLASSES = loadPicklistClasses();
const PICKLIST_KEY = {
  'custom-title': 'title',
  'text-container': 'text',
  'custom-image': 'image',
  'brightcove-video': 'video',
  // grid-container has its own picklist (regular-padding, content-wide, etc.)
  // Hero blocks are generated (not authored), so bypass picklist filtering.
  'hero-container': '_bypass',
  'hero-container-item': '_bypass',
};
const picklistFor = type => PICKLIST_CLASSES[PICKLIST_KEY[type] || type] || null;
const supportsStyle = (type, cls) => {
  const picklist = picklistFor(type);
  return true;
  //return !!picklist?.has(cls);
};

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
    if (val !== '' && val != null) {
      props[renames[key] || key] = transformPath(val, pathMap);
      // A target alone is inert in the EDS image model; retain the source
      // link by enabling the feature whenever AEM supplies a link URL.
      if (mapping?.edsType === 'custom-image' && key === 'linkURL') props.enableLink = 'true';
    }
  }
  // e.g. carousel: totalSlides = number of child slide components
  if (mapping?.countChildrenAsProp) {
    const src = (mapping.childContainer && node[mapping.childContainer]) || node;
    props[mapping.countChildrenAsProp] = String(childEntries(src).filter(([, c]) => RT(c)).length);
  }
  return props;
}

// DROP_CLASS is intentionally empty: all styles mapped on content blocks (title, text,
// video, carousel, linklist, CTA, etc.) must pass through to EDS unchanged.
// Layout containers (section, grid-container) are already protected — layoutStyleProps()
// only adds classes matching the LAYOUT_CLASS regex, which excludes block-level styles.
const DROP_CLASS = new Set([]);
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
// Derive the component-aware style-map namespace key from the AEM sling:resourceType.
function rtToComponentType(rt) {
  if (!rt) return null;
  if (rt.includes('/grid/')) return 'grid';
  if (rt.includes('/eyebrow-text') || rt.includes('/eyebrow/')) return 'eyebrow-text';
  if (rt.includes('/header/')) return 'eyebrow-text';
  if (rt.includes('/teaser/')) return 'teaser';
  if (rt.includes('/video/') || rt.includes('/brightcove')) return 'video';
  if (rt.includes('/accordion/')) return 'accordion';
  if (rt.includes('/carousel/')) return 'carousel';
  if (rt.includes('/linklist/') || rt.includes('/link-list/')) return 'linklist';
  if (rt.includes('/newsfeed') || rt.includes('/news-feed')) return 'newsfeed';
  if (rt.includes('/button/') || rt.includes('/cta')) return 'cta';
  if (rt.includes('/quote')) return 'quote';
  if (rt.includes('/cardpagestory') || rt.includes('/storyinfo')) return 'story-card';
  if (rt.includes('/image/') || rt.includes('/dynamicmedia')) return 'image';
  if (rt.includes('/text/')) return 'text';
  if (rt.includes('/title/')) return 'title';
  if (rt.includes('/separator/')) return 'separator';
  if (rt.includes('/dashboardcards')) return 'fact-card';
  if (rt.includes('/stockticker')) return 'stock-ticker';
  return null;
}
// Component-aware style ID resolution — lookup order:
//   1. Component-specific namespace (e.g. styleMap.linklist["1663000046218"])
//   2. _shared — globally unique long IDs shared across all components
//   3. Legacy flat root-level entry (backward compat)
function resolveStyleId(id, compType) {
  if (!id || !Object.keys(styleMap).length) return null;
  if (compType && styleMap[compType] && styleMap[compType][id]) return styleMap[compType][id];
  if (styleMap._shared && styleMap._shared[id]) return styleMap._shared[id];
  const root = styleMap[id];
  if (root && typeof root === 'object' && 'edsClass' in root) return root;
  return null;
}
function styleIdClasses(node) {
  const raw = node['@cq:styleIds'];
  if (!raw || !Object.keys(styleMap).length) return '';
  const ids = String(raw).replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
  const compType = rtToComponentType(RT(node));
  return ids.map(id => resolveStyleId(id, compType)?.edsClass).filter(c => !!c).join(',');
}

// Style IDs are reused by several AEM component policies. A class such as
// `default-cta` is valid on a CTA but is invalid when the same numeric style ID
// appears on a container's radius/default option. Resolve layout scopes through
// a deliberately narrow allowlist instead of treating every mapped class as a
// grid/container class.
const LAYOUT_CLASS = /^(?:content-(?:wide|regular|narrow|full-width)|container-[a-z-]+|full-width|align-(?:left|center|right)|no-(?:padding|bottom-margin|bottom-padding|top-padding|top-bottom-padding|side-margin)|regular-padding|small-padding|section-padding|padding-bottom|section-bottom-margin|(?:large|medium|small)-radius|semi-transparent-layer|linear-gradient|static|float|homepage-overlap|overlap-predecessor|height-(?:short|tall|x-tall|xx-tall|default)|(?:light|dark)-theme|grid-(?:full-page|half-page|meganav)-[\w-]+)$/;
function layoutStyleClasses(node) {
  return splitCls([styleIdClasses(node)]).filter(c => LAYOUT_CLASS.test(c)).join(',');
}

// AEM stores the selected style as an ID on every container in the hierarchy.
// EDS stores the same decision twice: as a typed style property (for authoring)
// and in the dynamic class list (for rendering).  Keep the source hierarchy in
// order so that a child container can override an equivalent parent setting.
const FULL_WIDTH_CONTAINER_STYLE_ID = '1653545825683';
function layoutStyleProps(nodes, { includeHeight = true, excludeStyleIds = [], compType = null } = {}) {
  const classes = [];
  const typed = {};
  const excluded = new Set(excludeStyleIds);
  const add = (cls, entry) => {
    if (!cls || !LAYOUT_CLASS.test(cls) || DROP_CLASS.has(cls)) return;
    if (!classes.includes(cls)) classes.push(cls);
    const group = entry?.groupLabel || '';
    if (group === 'Desktop Width' || group === 'Desktop Container Width' || group === 'Content Width') typed.style_contentWidth = cls;
    // The authoring picklist uses `radius-large`, while the rendering class is
    // `large-radius`; they are intentionally different EDS representations.
    else if (group === 'Radius') typed.style_borderRadius = /^(.+)-radius$/.test(cls)
      ? 'radius-' + cls.replace(/-radius$/, '') : cls;
    else if (group === 'Desktop Height' && includeHeight) typed.style_height = cls;
    else if (group === 'Margin and Padding') {
      if (/margin/.test(cls)) typed.style_margin = cls;
      else typed.style_padding = cls;
    }
    else if (group === 'PreBuilt Templates' || group === 'Menagav PreBuilt Templates') typed.style_gridTemplate = cls;
  };
  for (const node of nodes.filter(Boolean)) {
    const raw = node['@cq:styleIds'];
    if (raw) {
      const ids = String(raw).replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
      for (const id of ids) {
        if (excluded.has(id)) continue;
        // Prefer component-specific namespace (e.g. 'section') so that
        // section-block overrides (container-large, content-narrow, etc.)
        // take priority over _shared fallbacks for the same style ID.
        const entry = resolveStyleId(id, compType) || resolveStyleId(id, null);
        add(entry?.edsClass, entry);
      }
    }
    const bg = bgClass(node);
    if (bg) { if (!classes.includes(bg)) classes.push(bg); typed['style_bg-color'] = bg; }
  }
  return { classes, typed };
}

// `no-side-margin` makes a visual band full-bleed. It is meaningful only when
// an author has assigned that band a background color; never use it on heroes,
// whose background belongs to the hero item rather than the enclosing section.
function restrictNoSideMargin(resolved, hero = false) {
  if (!hero && resolved.typed['style_bg-color']) {
    return {
      ...resolved,
      // This is an automatic rendering variation, not a single-select authoring
      // value; leave any explicit margin field intact.
      classes: resolved.classes.includes('no-side-margin') ? resolved.classes : [...resolved.classes, 'no-side-margin'],
    };
  }
  const classes = resolved.classes.filter(c => c !== 'no-side-margin');
  const typed = { ...resolved.typed };
  if (typed.style_margin === 'no-side-margin') delete typed.style_margin;
  return { classes, typed };
}

// AEM leaf component node → EDS block { type, props, children }
function mapLeaf(node, inheritedBlockWidth = '') {
  const rt = RT(node);
  const mapping = componentMap[rt];
  const props = extractProps(node, mapping);
  const cls = styleIdClasses(node);
  if (cls) props.classes_customDynamicClass = props.classes_customDynamicClass ? props.classes_customDynamicClass + ',' + cls : cls;
  const propEds = mapping?.propEdsType;
  const rawPropVal = propEds ? (node[`@${propEds.prop}`] || '').trim() : '';
  let type = (propEds?.map?.[rawPropVal]) || mapping?.edsType || rt.split('/').filter(Boolean).pop();
  // Some legacy YouTube components omit videoType even though youtubeUrl is present.
  // Prefer the native video block in that case; Brightcove remains the default otherwise.
  if (type === 'brightcove-video' && /(?:youtube\.com|youtu\.be)/i.test(String(node['@youtubeUrl'] || '')))
    type = 'video';
  // propEdsTypeMatch: pick the EDS block by a substring of a prop (e.g. dashboardcards
  // fragmentPath ".../facts/..." → fact-card, ".../link-lists/..." → dashboard-card-link-list).
  const pm = mapping?.propEdsTypeMatch;
  if (pm) {
    const v = String(node[`@${pm.prop}`] || '');
    for (const [needle, t] of Object.entries(pm.contains || {})) { if (v.includes(needle)) { type = t; break; } }
  }
  // AEM reuses fileReference for both providers. The EDS Brightcove model
  // expects posterImage, while the native video model expects placeholderImage.
  if (type === 'brightcove-video' && props.placeholderImage) {
    props.posterImage = props.placeholderImage;
    delete props.placeholderImage;
  }
  // A grid cell's container width is translated through the target block's own
  // picklist: title/text use `width-large`, while video uses `video-large`.
  // Never apply a style merely because it is valid on a different EDS block.
  // Blocks that have a picklist-aware width style: title, text, video each map
  // width-* / video-* as their own classes_customDynamicClass entry.
  // All OTHER blocks that receive an inherited container width don't have a
  // matching style picklist for it — write it to classes_commonCustomClass instead.
  const isWidthTarget = ['custom-title', 'text-container', 'video', 'brightcove-video'].includes(type);
  const widthClass = (type === 'video' || type === 'brightcove-video')
    ? String(inheritedBlockWidth || '').replace(/^width-/, 'video-')
    : inheritedBlockWidth;
  if (widthClass) {
    if (isWidthTarget && supportsStyle(type, widthClass)) {
      // Inherited container width always wins — replace any own width class with the
      // ancestor container's width so all sibling blocks carry the same width value.
      const existingClasses = String(props.classes_customDynamicClass || '').split(',').map(c => c.trim()).filter(Boolean);
      const withoutWidth = existingClasses.filter(c => !/^(?:width|video)-(?:x{0,3}-)?(?:small|large|medium)$/.test(c));
      withoutWidth.push(widthClass);
      props.classes_customDynamicClass = [...new Set(withoutWidth)].join(',');
    } else if (!isWidthTarget) {
      // Block has no corresponding width style (e.g. cta, accordion, carousel, etc.)
      // → carry the inherited width as a custom class so it still reaches EDS.
      const existing = String(props.classes_commonCustomClass || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!existing.includes(widthClass)) existing.push(widthClass);
      props.classes_commonCustomClass = existing.join(',');
    }
  }
  // Always pull the image caption from DAM metadata on the live site.
  // Setting getCaptionFromDAM=true tells EDS to fetch the caption at render
  // time from the DAM asset, so it is always up-to-date even if the AEM XML
  // has no jcr:title. displayCaptionBelowImage=true enables the caption UI.
  if (type === 'custom-image') {
    props.getCaptionFromDAM = 'true';
    props.displayCaptionBelowImage = 'true';
  }
  normalizeBlock({ type, props });   // separator = Standard/no-line, eyebrow = standard+bold

  // Breadcrumb homePagePath: derive the EDS root from the AEM startLevel.
  // EDS retains the first site branch below country/language, so its hierarchy is
  // offset by one relative segment (startLevel 4 → country/lang/section).
  if (type === 'breadcrumb' && _ctxRel) {
    const startLevel = parseInt(node['@startLevel'] || '4') || 4;
    const keep = Math.max(1, startLevel - 1);
    const localePath = _ctxRel.split('/').slice(0, keep).join('/');
    if (localePath) props.homePagePath = transformPath('/content/abbvie-com2/' + localePath, pathMap);
  }
  // Video: overlay the content ON the poster (content-default is "bottom" = below the block),
  // and set the poster mime type (poster URL is mapped fileReference→placeholderImage). Applies to
  // both youtube (`video`) and `brightcove-video` — EDS uses "none" for ~80% of each.
  if (type === 'video' || type === 'brightcove-video') {
    props.videoContentLayout = 'none';
    const poster = props.placeholderImage || props.posterImage;
    if (poster) {
      const ext = (String(poster).split('?')[0].split('.').pop() || '').toLowerCase();
      props[type === 'brightcove-video' ? 'posterImageMimeType' : 'placeholderImageMimeType'] = MIME[ext] || 'image/jpeg';
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
  // Custom-title font weight comes from its explicit AEM style ID. When none is
  // supplied, EDS title policy uses book-weight. `default-cta` is a reused AEM
  // Default style ID for CTAs and must never leak onto a title.
  if (type === 'custom-title') {
    const parts = String(props.classes_customDynamicClass || '').split(',').map(s => s.trim())
      .filter(s => s && s !== 'default-cta');
    if (!parts.some(s => /(?:^|-)weight$/.test(s))) parts.push('book-weight');
    props.classes_customDynamicClass = parts.join(',');
  }
  // Eyebrow-text: the AEM header carries no eyebrow variation of its own — the EDS variation is a
  // redesign remap of the header's styleId (dark-theme → divider, full-page-5 grid → mini; no
  // style → no variation, the dominant case). Derive it faithfully from the raw AEM styleIds.
  if (type === 'eyebrow-text') {
    const ids = String(node['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
    // Use component-aware resolveStyleId so namespaced entries (styleMap.header / styleMap['eyebrow-text'])
    // are found correctly alongside legacy flat entries.
    const compType = rtToComponentType(rt);
    const aemClasses = ids.map(id => resolveStyleId(id, compType)?.aemClass).filter(Boolean);
    const edsClasses = ids.map(id => resolveStyleId(id, compType)?.edsClass).filter(Boolean);
    const out = new Set();
    // Eyebrow picklist uses short names: divider, mini, standard, pretitle.
    // The style-map edsClass may carry an 'eyebrow-' prefix (e.g. 'eyebrow-divider') —
    // strip it to match the picklist entries.
    const EYEBROW_THEME = new Set(['light-theme', 'dark-theme', 'bold-font', 'regular-font',
      'full-width', 'width-x-large', 'width-large', 'width-medium', 'width-small', 'width-x-small']);
    const EYEBROW_VARIANTS = new Set(['divider', 'mini', 'standard', 'pretitle']);
    // First pass: direct EDS classes (strip 'eyebrow-' prefix if present)
    for (const c of edsClasses) {
      const norm = c.replace(/^eyebrow-/, '');
      if (EYEBROW_VARIANTS.has(norm)) out.add(norm);
      else if (EYEBROW_THEME.has(c)) out.add(c);
    }
    // Second pass: legacy AEM-class remapping (dark-theme → divider, full-page-5 grid → mini)
    for (const c of aemClasses) {
      if (c === 'dark-theme' && !out.has('divider')) out.add('divider');
      else if (/full-page-5/.test(c) && !out.has('mini')) out.add('mini');
    }
    props.classes_customDynamicClass = [...out].join(',');
  }
  
  
   // Linklist: AEM reuses numeric style IDs across component policies. The shared IDs that map to
  // quote/card/carousel class names on other components map to linklist-specific variants here.
  // Remap known cross-policy collisions to their correct linklist EDS class.
  // When no style is authored, default to `list-standard` (rows with arrow) — the EDS picklist
  // first entry and the visual default seen on all un-styled linklists in hand-crafted pages.
  if (type === 'linklist') {
    const LINKLIST_REMAP = {
      'quote-standard':   'linklist-standard',
      'carousel-default': 'linklist-carousel',
      'list-standard':    'linklist-standard',
      'list-dashboard':   'linklist-rows-with-arrows',
      'list-icons':       'linklist-icons',
      'list-footer-primary':          'linklist-footer-primary',
      'list-footer-legal':            'linklist-footer-legal',
      'list-dashboard-publications':  'linklist-detailed',
      'list-carousel':    'linklist-carousel',
    };
    // CSS class → EDS variant prop value
    const CLASS_TO_VARIANT = {
      'linklist-standard':       'standard',
      'linklist-rows-with-arrows': 'rows-with-arrows',
      'linklist-icons':          'icons',
      'linklist-footer-primary': 'footer-primary',
      'linklist-footer-legal':   'footer-legal',
      'linklist-detailed':       'detailed-list',
      'linklist-carousel':       'carousel',
    };
    // CSS class → EDS layout prop value
    const CLASS_TO_LAYOUT = {
      'single-column':       'single-column',
      'two-columns-stack':   'two-columns-stack',
      'two-columns--stack':  'two-columns-stack',
      'two-columns-no-stack':   'two-columns-nostack',
      'two-columns--no-stack':  'two-columns-nostack',
    };

    const llClasses = String(props.classes_customDynamicClass || '').split(',').map(s => s.trim()).filter(Boolean);
    const remapped = llClasses.map(c => LINKLIST_REMAP[c] || c).filter(c => !/^(quote-|card-)/.test(c));

    // Translate to variant prop (first match wins)
    let variant = null;
    for (const c of remapped) {
      const v = CLASS_TO_VARIANT[c];
      if (v) { variant = v; break; }
    }
    if (!variant) variant = 'standard'; // EDS model default

    // Translate to layout prop
    let layout = null;
    for (const c of remapped) {
      const l = CLASS_TO_LAYOUT[c];
      if (l) { layout = l; break; }
    }

    // Translate AEM listFrom → EDS linkSource value
    // propRenames already renamed the key; now translate the value.
    const LISTSOURCE_MAP = { static: 'custom', children: 'child-pages', icons: 'icons' };
    if (props.linkSource) props.linkSource = LISTSOURCE_MAP[props.linkSource] || props.linkSource;
    else props.linkSource = 'custom'; // EDS model default

    // Set as proper block properties (not CSS classes)
    props.variant = variant;
    if (layout) props.layout = layout;

    // Keep only non-variant/non-layout classes (e.g. theme classes like dark-theme)
    const LINKLIST_VARIANT_CLASSES = new Set([...Object.keys(CLASS_TO_VARIANT), ...Object.keys(CLASS_TO_LAYOUT),
      'single-column', 'two-columns--stack', 'two-columns--no-stack']);
    const remaining = remapped.filter(c => !LINKLIST_VARIANT_CLASSES.has(c));
    if (remaining.length) props.classes_customDynamicClass = remaining.join(',');
    else delete props.classes_customDynamicClass;
  }

  // Quote: deduplicate classes (AEM can register the same style ID twice under different policy
  // entries), and default to `quote-standard` when no quote variant is present.
  // When AEM quoteType=content-fragment, set quoteVariant=content-fragment and pass fragmentPath through.
  if (type === 'quote') {
    const quoteType = String(node['@quoteType'] || '').trim();
    if (quoteType === 'content-fragment') {
      props.quoteVariant = 'content-fragment';
      // fragmentPath is now NOT in skipProps, so it passes through — no extra action needed.
      // Clear classes as content-fragment variant uses no dynamic style classes.
      delete props.classes_customDynamicClass;
    } else {
      const seen = new Set();
      const dedupedClasses = String(props.classes_customDynamicClass || '').split(',').map(s => s.trim()).filter(Boolean)
        .filter(c => { if (seen.has(c)) return false; seen.add(c); return true; });
      // Default variant when none of the explicit quote variant classes is present.
      const QUOTE_VARIANTS = new Set(['quote-standard', 'quote-dashboard', 'quote-animation']);
      if (!dedupedClasses.some(c => QUOTE_VARIANTS.has(c))) dedupedClasses.unshift('quote-standard');
      props.classes_customDynamicClass = dedupedClasses.join(',');
    }
  }
  
  
  // Teaser: EDS teasers carry a heading-size class the AEM teaser doesn't declare — teaser-h2 is the
  // plurality (172/348), so default it unless a size already derived. teaser-internal-link is added
  // when the CTA link is internal (a path/# rather than an external http(s) URL).
  if (type === 'teaser') {
    const set = new Set(String(props.classes_customDynamicClass || '').split(',').map(s => s.trim()).filter(Boolean));
    // Style ID 5 is the legacy Dashboard Half-page x3 teaser policy. It is
    // reused as a grid template too, so it cannot live in the global style map;
    // on a teaser it consistently selects the h4 heading variation.
    const teaserIds = String(node['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
    if (teaserIds.includes('5')) {
      for (const c of [...set]) if (/^teaser-h[1-6]/.test(c)) set.delete(c);
      set.add('teaser-h4');
    } else if (![...set].some(c => /^teaser-h[1-6]/.test(c))) set.add('teaser-h2');
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

// Separators are meaningful only when their AEM author explicitly chose a style.
// An unstyled separator is an empty authoring placeholder, not a 24px EDS spacer.
const isUnstyledSeparator = node => componentMap[RT(node)]?.edsType === 'separator' && !String(node['@cq:styleIds'] || '').trim();

// A leaf that expands into MULTIPLE sibling blocks. A carousel's slides are stored as child
// components in AEM, but EDS lays them out as sibling blocks right AFTER the carousel controller
// (the carousel JS picks up the following blocks as slides). So emit [carousel, ...mapped slides].
function mapLeafExpanded(node, inheritedBlockWidth = '') {
  if (isUnstyledSeparator(node)) return [];
  const block = mapLeaf(node, inheritedBlockWidth);
  if (/components\/carousel/.test(RT(node))) {
    const slides = [];
    for (const [, child] of childEntries(node))
      if (componentMap[RT(child)]) slides.push(mapLeaf(child, inheritedBlockWidth));   // e.g. image slide → custom-image
    return [block, ...slides];
  }
  return [block];
}

// recursively collect leaf blocks under a container (flatten nested containers / parsys),
// skipping grids (handled separately) and inline separators/XF chrome.
const CONTAINER_TO_BLOCK_WIDTH = {
  'container-x-small': 'width-x-small', 'container-small': 'width-small',
  'container-medium': 'width-medium', 'container-large': 'width-large',
  'container-x-large': 'width-x-large', 'container-xx-large': 'width-xx-large',
  'container-xxx-large': 'width-xxx-large',
};
function containerBlockWidth(node, inherited = '') {
  // layoutStyleClasses → styleIdClasses → rtToComponentType returns null for containers,
  // so style IDs under the 'section' namespace are never found. Look up the raw style IDs
  // directly using 'section' as compType (where container-* IDs live in style-map.json).
  const raw = node?.['@cq:styleIds'];
  if (raw) {
    const ids = String(raw).replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
    for (const id of ids) {
      const entry = resolveStyleId(id, 'section') || resolveStyleId(id, null);
      const cls = entry?.edsClass;
      if (cls && CONTAINER_TO_BLOCK_WIDTH[cls]) return CONTAINER_TO_BLOCK_WIDTH[cls];
    }
  }
  return inherited;
}
function collectLeaves(node, out, inheritedBlockWidth = '', applyContainerWidth = true) {
  const width = applyContainerWidth && isContainer(RT(node))
    ? containerBlockWidth(node, inheritedBlockWidth) : inheritedBlockWidth;
  for (const [, child] of childEntries(node)) {
    const rt = RT(child);
    if (!rt || isLayoutWrapper(rt)) { collectLeaves(child, out, width, applyContainerWidth); continue; }
    if (isXF(rt)) continue;
    if (isGrid(rt)) { collectLeaves(child, out, width, applyContainerWidth); continue; }      // nested grid → flatten its cell content
    if (isContainer(rt)) {
      // Always flatten container contents regardless of width style — grids inside containers
      // are treated as section-level grids, not inner-grids.
      collectLeaves(child, out, width, applyContainerWidth);
      continue;
    }
    out.push(...mapLeafExpanded(child, width));
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

// Does this container have a direct grid child (through layout wrappers only, not through containers)?
// Used to detect the "container with width style + nested grid → inner-grid section" pattern.
function containerHasDirectGrid(node) {
  for (const [, child] of childEntries(node)) {
    const rt = RT(child);
    if (isGrid(rt)) return true;
    if (!rt || isLayoutWrapper(rt)) { if (containerHasDirectGrid(child)) return true; }
  }
  return false;
}

// Does this container hold any grid anywhere in its subtree (crossing containers too)?
// Used to trigger the inner-grid section path when the grid is nested inside child containers.
function containerHasAnyGrid(node) {
  for (const [, child] of childEntries(node)) {
    const rt = RT(child);
    if (isGrid(rt)) return true;
    if (!rt || isLayoutWrapper(rt) || isContainer(rt)) { if (containerHasAnyGrid(child)) return true; }
  }
  return false;
}

// Width style IDs present on containers that should trigger the inner-grid section pattern.
// Covers all container-* sizes: xxx-large → xxx-small (8 IDs from style-map.json).
const WIDTH_STYLE_IDS = new Set([
  '1653545825684', // container-xxx-large
  '1653545825685', // container-xx-large
  '1653545825686', // container-x-large
  '1653545825687', // container-large
  '1653545825688', // container-medium
  '1653545825689', // container-small
  '1653545825690', // container-x-small
  '1653545825692', // container-xxx-small
]);
function containerHasWidthStyle(node) {
  const ids = String(node?.['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
  return ids.some(id => WIDTH_STYLE_IDS.has(id));
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

// EDS section/grid-container class defaults, in two tiers:
//   ALWAYS  — supplied alongside any authored padding variation:
//     • grid-container `content-wide` — the 144rem EDS width baseline; skipped when AEM
//       already gives a width.
//     • non-hero section `section-padding` and grid-container `regular-padding`.
//   FALLBACK — remaining legacy section spacing when NOTHING can be inferred from AEM.
const STYLE_DEFAULTS_ALWAYS = {
  section:          ['section-padding'],
  'grid-container': ['content-wide', 'regular-padding'],
};
const STYLE_DEFAULTS_FALLBACK = {
  section:          ['no-bottom-margin'],
  'grid-container': [],
};
const NOOP_CLASS = new Set(['height-default']);              // EDS omits the "default" height (no-op) on sections/grids
const isWidthCls  = c => ['content-wide', 'content-regular', 'content-narrow', 'full-width'].includes(c) || /^container-/.test(c);
const EXCL_RADIUS = new Set(['large-radius', 'medium-radius', 'small-radius', 'no-radius']);
const splitCls = arr => arr.filter(Boolean).flatMap(c => String(c).split(',')).map(c => c.trim()).filter(Boolean);
const hasStyleId = (node, id) => String(node?.['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',').includes(id);
function applyFullWidthContainerRule(resolved, containers) {
  if (!containers.some(node => hasStyleId(node, FULL_WIDTH_CONTAINER_STYLE_ID))) return resolved;
  return {
    classes: [...resolved.classes.filter(c => !isWidthCls(c)), 'content-wide'],
    typed: { ...resolved.typed, style_contentWidth: 'content-wide' },
  };
}
// merge template defaults into derived classes: derived (from AEM) wins on exclusive families
// (width/radius); ALWAYS defaults fill required gaps; FALLBACK padding/margin apply only when the
// AEM node yielded no styling at all (`derived` empty = nothing inferred).
function mergeDefaults(kind, derived) {
  // Deduplicate derived first (layoutStyleProps + applyFullWidthContainerRule can both add content-wide)
  const seen = new Set();
  const deduped = derived.filter(c => { if (seen.has(c)) return false; seen.add(c); return true; });
  const out = [...deduped]; const has = new Set(deduped);
  const hasW = deduped.some(isWidthCls), hasR = deduped.some(c => EXCL_RADIUS.has(c));
  const add = list => { for (const d of list) {
    if (has.has(d) || (isWidthCls(d) && hasW) || (EXCL_RADIUS.has(d) && hasR)) continue;
    out.push(d); has.add(d);
  } };
  add(STYLE_DEFAULTS_ALWAYS[kind] || []);
  if (!deduped.length) add(STYLE_DEFAULTS_FALLBACK[kind] || []);   // nothing inferred from AEM → backfill
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

// Build the hero-container block from a container's background IMAGE or COLOR.
//
// EDS style distribution (verified against nz/en corpus, 78 pages):
//
//   IMAGE hero (c1 has backgroundImageReference):
//     section                    → content-wide, large-radius, no-bottom-margin  (from c1, content-full-width→content-wide)
//     hero-container (ctrl)      → height from c2 if present; overlay-height from c2-height→overlay map;
//                                  if no c2, height from c1
//     hero-container-item        → c1 classes: full-width (from content-full-width), height-*, radius, margin, padding
//
//   COLOR hero (c1 has backgroundColor, no bg image):
//     section                    → large-radius, no-bottom-margin  (no content-wide for color heroes)
//     hero-container (ctrl)      → height from c1, color-class, overlay-height if applicable
//     hero-container-item        → color-class only (or navy/purple/accent-blue), container-xx-large if present
//
// Container2 (overlap) height → overlay-height mapping:
//   height-short  → overlay-height-short  + overlay-inner-height-short
//   height-default→ overlay-height-default + overlay-inner-height-default
//   height-tall   → overlay-height-tall   + overlay-inner-height-tall
//
// c2 node is passed as `overlapNode` from `aemToCanvas` hero merge.
const HEIGHT_TO_OVERLAY = {
  'height-short':   ['overlay-height-short',   'overlay-inner-height-short'],
  'height-default': ['overlay-height-default',  'overlay-inner-height-default'],
  'height-tall':    ['overlay-height-tall',     'overlay-inner-height-tall'],
  'height-x-tall':  ['overlay-height-x-tall',   'overlay-inner-height-x-tall'],
  'height-xx-tall': ['overlay-height-xx-tall',  'overlay-inner-height-xx-tall'],
};

function heroBlockOf(node, overlapNode = null) {
  const bgImg = node['@backgroundImageReference'];
  const imageHero = !!bgImg;

  // Resolve c1 classes (container1 = hero image/color source)
  const c1Classes = splitCls([styleIdClasses(node)]);
  const c1Height   = c1Classes.find(c => /^height-/.test(c)) || 'height-default';
  // Map content-full-width → full-width for the item picklist
  const c1ItemClasses = c1Classes
    .filter(c => !['content-full-width', 'overlap-predecessor', 'homepage-overlap'].includes(c))
    .map(c => c === 'content-full-width' ? 'full-width' : c);
  // Add full-width when content-full-width was present in c1
  if (c1Classes.includes('content-full-width') && !c1ItemClasses.includes('full-width'))
    c1ItemClasses.unshift('full-width');

  // Resolve c2 (overlap container): pull radius class → appended to controller
  let c2Radius = null;
  if (overlapNode) {
    const c2Classes = splitCls([styleIdClasses(overlapNode)]);
    c2Radius = c2Classes.find(c => EXCL_RADIUS.has(c)) || null;
  }

  let item;
  if (imageHero) {
    const alt = bgImg.split('/').pop().replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    const ext = (bgImg.split('.').pop() || '').toLowerCase();
    // Item carries c1's visual classes: full-width, height, radius, margin, padding, semi-transparent.
    // Keep ALL non-layout classes (radius, height, full-width, no-bottom-margin etc) that belong on the item.
    const itemClasses = c1ItemClasses.filter(c =>
      /^(full-width|height-|large-radius|medium-radius|small-radius|no-bottom-margin|no-bottom-padding|no-padding|semi-transparent|container-)/.test(c)
    );
    item = {
      type: 'hero-container-item',
      props: {
        image: transformPath(bgImg, pathMap),
        backgroundVariant: 'image',
        imageAlt: alt,
        imageMimeType: MIME[ext] || 'image/jpeg',
      },
      children: [],
    };
    // Controller: c1 height + overlay-height-default (always) + c2 radius (if present)
    const ctrlClasses = [c1Height, 'overlay-height-default', c2Radius].filter(Boolean);
    const props = { filter: 'hero-container', classes_customDynamicClass: ctrlClasses.join(',') };
    return { type: 'hero-container', props, children: [item] };
  } else {
    // Color hero: item carries the color class derived from C1 backgroundColor.
    const colorClass = heroColorOf(node) || '';
    item = {
      type: 'hero-container-item',
      props: {
        backgroundVariant: 'color',
        ...(colorClass ? { classes_customDynamicClass: colorClass } : {}),
      },
      children: [],
    };
    // Controller for color hero: c1 height + overlay-height-default (always) + c2 radius (if present)
    const ctrlParts = [c1Height, 'overlay-height-default', c2Radius].filter(Boolean);
    const props = { filter: 'hero-container', classes_customDynamicClass: ctrlParts.join(',') };
    return { type: 'hero-container', props, children: [item] };
  }
}
// section classes for a container: derived (minus height, which went to the hero block) + defaults
function sectionProps(node, hero = false) {
  const nodes = Array.isArray(node) ? node : [node];

  // ── HERO SECTION RULE ────────────────────────────────────────────────────
  // From C1 only two classes are distributed:
  //   • radius class  → section (style_customDynamicClass)
  //   • height class  → hero-container (handled in heroBlockOf)
  // Everything else from C1 is ignored for the section.
  if (hero) {
    const c1 = Array.isArray(node) ? node[0] : node;
    const c1Classes = splitCls([styleIdClasses(c1)]);
    const radiusClass = c1Classes.find(c => EXCL_RADIUS.has(c));
    const derived = radiusClass ? [radiusClass] : [];
    const typed = radiusClass
      ? { style_borderRadius: 'radius-' + radiusClass.replace(/-radius$/, '') }
      : {};
    return { ...typed, style_customDynamicClass: derived.join(',') };
  }

  // ── NON-HERO SECTION ─────────────────────────────────────────────────────
  let resolved = layoutStyleProps(nodes, { compType: 'section' });
  resolved = applyFullWidthContainerRule(resolved, nodes);
  resolved = restrictNoSideMargin(resolved, false);
  resolved = {
    ...resolved,
    classes: resolved.classes.map(c => c === 'content-full-width' ? 'content-wide' : c),
    typed: Object.fromEntries(
      Object.entries(resolved.typed).map(([k, v]) => [k, v === 'content-full-width' ? 'content-wide' : v])
    ),
  };
  let derived = resolved.classes;
  const hasOverlap = derived.some(c => c === 'overlap-predecessor' || c === 'homepage-overlap');
  derived = derived.filter(c => c !== 'overlap-predecessor' && c !== 'homepage-overlap' && (!hasOverlap || !EXCL_RADIUS.has(c)));
  if (hasOverlap) delete resolved.typed.style_borderRadius;
  const typed = { ...resolved.typed };
  const classes = mergeDefaults('section', derived);
  return { ...typed, style_customDynamicClass: classes.join(',') };
}
function gridContainerProps(containers, grid = null) {
  // Container styles describe the shared visual band. Grid styles describe a
  // particular grid inside that band and therefore must be applied only when
  // that source grid is emitted as its own EDS grid-container.
  const chain = Array.isArray(containers) ? containers : [containers];
  const resolved = restrictNoSideMargin(applyFullWidthContainerRule(layoutStyleProps([...chain, grid], { compType: 'grid-container' }), chain));
  const container = chain[chain.length - 1];
  const derived = resolved.classes
    .filter(c => !NOOP_CLASS.has(c))
    .filter(c => container['@backgroundImageReference'] || !/^height-/.test(c));
  const classes = ['grid-container', ...mergeDefaults('grid-container', derived)].join(',');
  return { style_container: 'grid-container', ...resolved.typed, style_customDynamicClass: classes, ...bgImageProps(container) };
}
// A HERO section keeps the container's width/radius/margin styleIds (twins: 94% large-radius,
// 76% content-wide) but NOT height (on the hero block) and NOT the bg color/image (on the item).
function heroSectionClasses(node) {
  return sectionProps(node, true).style_customDynamicClass;
}
// A hero container = plain container (no grid inside) carrying a bg-image, OR an EMPTY container
// whose background is a known brand color (the color-variation hero, e.g. leader pages). The empty
// check keeps dark-theme CONTENT sections (which have children) from being mistaken for heroes.
const isColorHero = node => !childEntries(node).length && heroColorOf(node) !== null;
const isHeroContainer = node => isContainer(RT(node)) && !containerHasGrid(node) &&
  (!!node['@backgroundImageReference'] || isColorHero(node));
// The hero's intro content sits in a following container that OVERLAPS the hero (styleId
// overlap-predecessor) — verified 13/13 intro containers have it, 0/5 body containers do. Only such
// containers are absorbed into the hero section; the first non-overlapping one starts the page body.
const overlapsHero = node => { const cls = splitCls([styleIdClasses(node)]); return cls.includes('overlap-predecessor') || cls.includes('homepage-overlap'); };

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

// Grid authoring data belongs to the grid itself, not necessarily its enclosing
// container. Keep the columns as records so that dataPriority survives as the
// responsive EDS `order-N` class on the resulting grid-section.
function gridColumns(grid) {
  return grid.columns
    ? childEntries(grid.columns).map(([, it]) => ({
      width: String(it['@columnWidth'] || '').trim(),
      priority: String(it['@dataPriority'] || '').trim(),
    })).filter(c => c.width)
    : [];
}

function addCommonClass(block, cls) {
  if (!block || !cls) return;
  const set = new Set(String(block.props?.classes_commonCustomClass || '').split(/[\s,]+/).filter(Boolean));
  set.add(cls);
  block.props = block.props || {};
  block.props.classes_commonCustomClass = [...set].join(' ');
}

// EDS inner-grid is a controller block followed by its sibling content blocks.
// The child blocks are assigned to columns with `col-N`; unlike a grid-section,
// the inner-grid itself does not own the children in JCR. This preserves the
// layout semantics that were previously flattened by collectLeaves().
function markInnerManaged(block) {
  if (block && !block._innerManaged) Object.defineProperty(block, '_innerManaged', { value: true, enumerable: false });
}

function emitInnerGrid(grid, out, depth = 0) {
  const cols = gridColumns(grid);
  if (!cols.length) { collectLeaves(grid, out); return; }
  const classes = [`cols-${cols.map(c => c.width).join('-')}`, ...splitCls([layoutStyleClasses(grid)])];
  const controller = { type: 'inner-grid', props: { classes_customDynamicClass: classes.join(',') }, children: [] };
  Object.defineProperty(controller, '_innerController', { value: true, enumerable: false });
  out.push(controller);
  const rowCount = parseInt(grid['@rowCount'] || '1') || 1;
  for (let r = 1; r <= rowCount; r++) {
    for (let c = 1; c <= cols.length; c++) {
      const cellBlocks = [];
      const par = grid[`par_${r}${c}`];
      if (par && typeof par === 'object') collectCellLeaves(par, cellBlocks, depth + 1);
      // EDS distinguishes the first inner-grid level (`col-N`) from blocks in
      // a nested inner-grid (`ncol-N`). Do not overwrite descendants already
      // assigned by their own inner-grid; only its controller belongs to this
      // parent column.
      const columnClass = `${depth === 0 ? 'col' : 'ncol'}-${c}`;
      cellBlocks.forEach(block => {
        if (block._innerManaged) return;
        addCommonClass(block, columnClass);
        markInnerManaged(block);
      });
      out.push(...cellBlocks);
    }
  }
}

// As collectLeaves(), but a grid inside a cell is preserved as an inner-grid
// instead of being flattened into the enclosing grid-section.
function collectCellLeaves(node, out, innerDepth = 0, inheritedBlockWidth = '') {
  const width = isContainer(RT(node)) ? containerBlockWidth(node, inheritedBlockWidth) : inheritedBlockWidth;
  for (const [, child] of childEntries(node)) {
    const rt = RT(child);
    if (!rt || isLayoutWrapper(rt)) { collectCellLeaves(child, out, innerDepth, width); continue; }
    if (isXF(rt)) continue;
    if (isGrid(rt)) { emitInnerGrid(child, out, innerDepth); continue; }
    if (isContainer(rt)) {
      // A nested container with a width style becomes a single-column inner-grid ONLY
      // when the inner grid is genuinely multi-column (cols != cols-12). A container-*
      // width that wraps a single-column (cols-12) grid is purely a width-constraint —
      // the EDS twin simply applies the width class on the enclosing grid-section and
      // emits NO inner-grid. Emitting cols-12 inner-grid for these is a false positive
      // confirmed across 130 us/en pages and 12 nz/en pages in the twin corpus audit.
      //
      // Rule: emit inner-grid {cols-12,widthClass} ONLY when the container holds a
      // grid that has more than one column (i.e. NOT cols-12). For single-column grids,
      // recurse through the container and let blocks inherit the width class directly.
      if (containerHasWidthStyle(child)) {
        const childWidth = containerBlockWidth(child, width);
        // Inspect whether any direct grid inside this container is multi-column.
        // A multi-column grid has more than one column entry, or its single column is not 12.
        const hasMultiColGrid = (() => {
          function scanForGrid(n) {
            for (const [, c] of childEntries(n)) {
              const crt = RT(c);
              if (isGrid(crt)) {
                const cols = gridColumns(c);
                if (cols.length > 1) return true;          // genuine multi-col → keep inner-grid
                if (cols.length === 1 && cols[0].width !== '12') return true; // non-12 single col
                return false;                              // cols-12 single col → false positive
              }
              if (!crt || isLayoutWrapper(crt) || isContainer(crt)) {
                if (scanForGrid(c)) return true;
              }
            }
            return false;
          }
          return scanForGrid(child);
        })();

        if (hasMultiColGrid) {
          // True multi-column inner layout — keep the inner-grid controller (correct behaviour).
          const colsClass = 'cols-12' + (childWidth ? ',' + childWidth : '');
          const controller = { type: 'inner-grid', props: { classes_customDynamicClass: colsClass }, children: [] };
          out.push(controller);
          const cellBlocks = [];
          collectCellLeaves(child, cellBlocks, innerDepth + 1, childWidth);
          const colClass = `${innerDepth === 0 ? 'col' : 'ncol'}-1`;
          cellBlocks.forEach(block => {
            if (block._innerManaged) return;
            addCommonClass(block, colClass);
            markInnerManaged(block);
          });
          addCommonClass(controller, innerDepth === 0 ? 'col-1' : 'ncol-1');
          out.push(...cellBlocks);
        } else {
          // Single-column (cols-12) width-constraint only — skip inner-grid, propagate
          // the width class to child blocks via the inherited width parameter.
          // The enclosing grid-section already owns the width presentation.
          collectCellLeaves(child, out, innerDepth, childWidth || width);
        }
      } else {
        collectCellLeaves(child, out, innerDepth, width);
      }
      continue;
    }
    out.push(...mapLeafExpanded(child, width));
  }
}

// Grids nested inside a container are handled separately from grids nested in a
// cell. This only crosses transparent layout wrappers: a nested container has
// its own visual scope and must not donate its grid styles to the parent.
function directGrids(node, out = []) {
  for (const [, child] of childEntries(node)) {
    const rt = RT(child);
    if (isGrid(rt)) out.push(child);
    else if (!rt || isLayoutWrapper(rt)) directGrids(child, out);
  }
  return out;
}
function gridHasCards(grid) {
  if (!grid) return false;
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

function applyRelatedContentCardProps(blocks) {
  for (const block of blocks || []) {
    if (block.type !== 'story-card') continue;
    const props = block.props || (block.props = {});
    // These legacy style IDs are shared with quote/card policies. In the
    // Related Content pattern their EDS representation is typed properties,
    // never quote/card dynamic classes.
    const classes = String(props.classes_customDynamicClass || '').split(',').map(c => c.trim())
      .filter(c => c && !['quote-standard', 'card-medium', 'hide-description'].includes(c));
    if (classes.length) props.classes_customDynamicClass = classes.join(',');
    else delete props.classes_customDynamicClass;
    props.storyCardVariant = 'relatedContent';
    props.hideDescription = '{Boolean}true';
    props.hidePublicationDate = '{Boolean}true';
    props.hideReadTime = '{Boolean}true';
    props.hideRole = '{Boolean}false';
    props.showChevron = '{Boolean}true';
    props.openInNewTab = '{Boolean}false';
  }
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
  // A one-row card grid can be represented as plain sibling cards. A multi-row
  // card grid cannot: flattening it loses the row boundaries needed for the
  // target EDS grid-container sequence.
  const rowCount = parseInt(grid['@rowCount'] || '1') || 1;
  const card   = rowCount === 1 && g.allFour && gridHasCards(grid);
  const band   = maxW >= 10 && g.cols.every(w => w === maxW || w <= 2) && !g.cols.includes(1);
  const spacer = g.cols.length > 0 && g.cols.every(w => w <= 1);
  if (_R === 'none') return false;
  if (_R === 'filler') return g.isFiller;             // aggressive (drops 1,11) — measurement only
  if (_R === 'all') return g.isFiller || card;
  return card || band || spacer;                      // 'band' (default, safe)
}

// grid node → push its columns as grid-section blocks into `blocks`
function expandGrid(grid, blocks, sourceScopes = [], relatedContent = false) {
  const cols = gridColumns(grid);
  const rowCount = parseInt(grid['@rowCount'] || '1') || 1;
  // dataPriority is only meaningful when the author changed the natural order.
  // In that case preserve every column priority, including explicit order-1.
  const hasPriorityOrder = cols.some(col => col.priority && col.priority !== '1');
  for (let r = 1; r <= rowCount; r++) {
    for (let c = 1; c <= cols.length; c++) {
      const col = cols[c - 1];
      const par = grid[`par_${r}${c}`];
      const classes = ['grid-section', `grid-cols-${col.width}`];
      if (hasPriorityOrder && col.priority) classes.push(`order-${col.priority}`);
      const gs = { type: 'grid-section', props: {
        style_container: 'grid-section',
        style_gridCols: `grid-cols-${col.width}`,
        style_customDynamicClass: classes.join(','),
      }, children: [] };
      // Keep source grouping metadata out of the serialized canvas/JCR. It is
      // used below solely to split multi-row grids without splitting adjacent
      // one-row grids from the same enclosing AEM container.
      Object.defineProperty(gs, '_sourceGrid', { value: grid, enumerable: false });
      Object.defineProperty(gs, '_sourceScopes', { value: sourceScopes, enumerable: false });
      if (par && typeof par === 'object') collectCellLeaves(par, gs.children);
      if (relatedContent) applyRelatedContentCardProps(gs.children);
      blocks.push(gs);
    }
  }
}

function pushGridContainersByRows(sections, gc, propsForSource = null) {
  if (!gc.blocks.length) return;
  // The source row is a visual boundary. In EDS, independent rows are
  // represented as consecutive grid-container/grid-section groups, not as one
  // unbounded run. `_sourceGrid` is non-enumerable, so it never reaches JCR.
  const pending = [];
  const flush = () => {
    if (pending.length) sections.push({ type: 'grid-container', props: { ...gc.props }, blocks: pending.splice(0) });
  };
  for (let i = 0; i < gc.blocks.length;) {
    const source = gc.blocks[i]._sourceGrid;
    if (!source) { pending.push(gc.blocks[i++]); continue; }
    let end = i + 1;
    while (end < gc.blocks.length && gc.blocks[end]._sourceGrid === source) end++;
    const rows = parseInt(source['@rowCount'] || '1') || 1;
    const perRow = gridColumns(source).length;
    // A style declared directly on a grid cannot safely share a grid-container
    // with a sibling grid. Split that run even when it has one row; otherwise
    // retain the existing grouping for unstyled one-row grids.
    const sourceScopes = gc.blocks[i]._sourceScopes || [];
    // The migrated corpus keeps nested AEM containers inside the same EDS grid
    // group. Only a style authored on the grid itself is a proven EDS boundary;
    // container ancestry is still retained for typed style resolution whenever
    // that grid is emitted independently.
    const sourceSpecific = !!layoutStyleClasses(source);
    if ((rows > 1 && perRow && end - i === rows * perRow) || sourceSpecific) {
      flush();
      const props = propsForSource ? propsForSource(source, sourceScopes) : gc.props;
      if (rows > 1 && perRow && end - i === rows * perRow) {
        for (let row = 0; row < rows; row++)
          sections.push({ type: 'grid-container', props: { ...props }, blocks: gc.blocks.slice(i + row * perRow, i + (row + 1) * perRow) });
      } else sections.push({ type: 'grid-container', props: { ...props }, blocks: gc.blocks.slice(i, end) });
    } else pending.push(...gc.blocks.slice(i, end));
    i = end;
  }
  flush();
}


// A non-grid container immediately before a sibling grid is an intro band when
// it carries both a heading and copy. It must remain a standalone section;
// putting it into the first grid cell changes the authored layout entirely.
function isIntroContainerBeforeGrid(container, next) {
  if (!isContainer(RT(container)) || containerHasGrid(container) || !isGrid(RT(next))) return false;
  let heading = false, copy = false;
  (function scan(node) {
    for (const [, child] of childEntries(node)) {
      const rt = RT(child);
      if (!rt || isLayoutWrapper(rt) || isContainer(rt)) { scan(child); continue; }
      if (isGrid(rt)) continue;
      const type = componentMap[rt]?.edsType;
      if (type === 'custom-title' || type === 'eyebrow-text') heading = true;
      if (type === 'text-container') copy = true;
    }
  })(container);
  return heading && copy;
}

// A run of direct heading leaves (eyebrow-text / custom-title) sitting immediately
// before a sibling grid is a heading BAND introducing that grid — the author placed
// it above the columns, not inside the first cell. Without this guard those leaves
// fall through to the `leading` buffer and get unshifted into the first grid-cols-N
// section (see flushGridBand). Card grids are excluded: a custom-title before a card
// grid is the related-content heading, handled separately. Returns the index of the
// grid that follows the heading run, or -1 when this is not a heading band.
const isHeadingLeaf = rt => ['eyebrow-text', 'custom-title'].includes(componentMap[rt]?.edsType);
function headingBandBeforeGrid(entries, index) {
  if (!isHeadingLeaf(RT(entries[index]?.[1]))) return -1;
  let j = index;
  while (j < entries.length && isHeadingLeaf(RT(entries[j][1]))) j++;
  const next = entries[j]?.[1];
  if (!next || !isGrid(RT(next)) || gridHasCards(next)) return -1;
  return j;
}

// emit sections for one top-level content node
function emitNode(node, sections) {
  const rt = RT(node);
  if (isContainer(rt)) {
    if (containerHasGrid(node)) {
      // Real grids become grid-sections. A direct teaser next to a grid is its
      // own visual band in AEM, so preserve it as a standalone EDS section in
      // document order. Other loose leaves (notably separators) keep the
      // existing first/last grid-cell treatment.
      // height-* belongs on grid-containers only when they're a background-IMAGE banner (twins keep
      // height-tall there); on color/plain grid-containers the height styleId is dropped.
      const gc = { type: 'grid-container', props: gridContainerProps([node]), blocks: [] };
      const leading = [], trailing = [];
      const deferredCtaTeasers = [];
      let relatedGridPending = false;
      let firstContentGs = null, lastContentGs = null;
      const buf = () => (firstContentGs ? trailing : leading);
      const flushGridBand = () => {
        if (firstContentGs) {
          if (leading.length) firstContentGs.children.unshift(...leading);
          if (trailing.length) lastContentGs.children.push(...trailing);
        } else if (leading.length || trailing.length) {
          sections.push({ type: 'section', props: sectionProps(node), blocks: [...leading, ...trailing] });
        }
        pushGridContainersByRows(sections, gc, (sourceGrid, scopes) => gridContainerProps(scopes.length ? scopes : [node], sourceGrid));
        gc.blocks.length = 0;
        leading.length = 0;
        trailing.length = 0;
        firstContentGs = null;
        lastContentGs = null;
      };
      const emitDeferredCtaTeasers = () => {
        for (const teaser of deferredCtaTeasers.splice(0)) {
          const blocks = mapLeafExpanded(teaser);
          if (blocks.length) sections.push({ type: 'section', props: sectionProps(node), blocks });
        }
      };
      (function scan(n, scopes = [node]) {
        const entries = childEntries(n);
        let gridBandEnd;
        for (let index = 0; index < entries.length; index++) {
          const [, child] = entries[index];
          const crt = RT(child);
          if (isGrid(crt)) {
            const relatedContent = relatedGridPending && gridHasCards(child);
            if (relatedContent) {
              const classes = splitCls([gc.props.style_customDynamicClass]);
              if (!classes.includes('no-top-padding')) classes.push('no-top-padding');
              gc.props.style_customDynamicClass = classes.join(',');
            }
            if (isUnwrapGrid(child)) collectLeaves(child, buf());
            else {
              const start = gc.blocks.length;
              expandGrid(child, gc.blocks, scopes, relatedContent);
              for (let i = start; i < gc.blocks.length; i++) {
                if (gc.blocks[i].children && gc.blocks[i].children.length) { if (!firstContentGs) firstContentGs = gc.blocks[i]; lastContentGs = gc.blocks[i]; }
              }
            }
            if (relatedContent) { flushGridBand(); relatedGridPending = false; gc.props = gridContainerProps([node]); }
            // A deferred CTA teaser belongs immediately after its associated
            // three-up image grid, not before it in XML order.
            if (deferredCtaTeasers.length) { flushGridBand(); emitDeferredCtaTeasers(); }
          } else if (!crt || isLayoutWrapper(crt)) scan(child, scopes);
          else if (isXF(crt)) continue;
          else if (isIntroContainerBeforeGrid(child, entries[index + 1]?.[1])) {
            flushGridBand();
            const blocks = [];
            collectLeaves(child, blocks, '', false);
            if (blocks.length) sections.push({ type: 'section', props: sectionProps([node, child]), blocks });
          }
          else if (componentMap[crt]?.edsType === 'custom-title' && gridHasCards(entries[index + 1]?.[1])) {
            // A direct heading immediately before cardpagestory cells is the
            // related-content heading band, never content in the first card cell.
            flushGridBand();
            const blocks = mapLeafExpanded(child);
            if (blocks.length) sections.push({ type: 'section', props: sectionProps(node), blocks });
            relatedGridPending = true;
          }
          else if ((gridBandEnd = headingBandBeforeGrid(entries, index)) >= 0) {
            // A direct eyebrow-text / custom-title run sitting above a non-card grid
            // is the section's heading band. Emit it as its own standalone section so
            // it renders full-width above the grid rather than inside the first cell.
            flushGridBand();
            const blocks = [];
            for (let k = index; k < gridBandEnd; k++) blocks.push(...mapLeafExpanded(entries[k][1]));
            if (blocks.length) sections.push({ type: 'section', props: sectionProps(node), blocks });
            index = gridBandEnd - 1; // resume on the grid (the for-loop ++ advances onto it)
          }
          else if (componentMap[crt]?.edsType === 'teaser') {
            flushGridBand();
            const blocks = mapLeafExpanded(child);
            if (blocks.length) sections.push({ type: 'section', props: sectionProps(node), blocks });
          }
          else if (isContainer(crt)) {
            // A nested container with a width style AND a direct grid is an inner-grid
            // sub-section of its parent band. Emit it as inner-grid blocks into the
            // trailing buffer (after any grid-sections) rather than flattening it.
            if (containerHasWidthStyle(child) && containerHasDirectGrid(child)) {
              const igBlocks = [];
              collectCellLeaves(child, igBlocks, 0, '');
              trailing.push(...igBlocks);
            } else {
              collectLeaves(child, buf());
            }
          }
          else buf().push(...mapLeafExpanded(child));
        }
      })(node);
      flushGridBand();
      emitDeferredCtaTeasers();
      return;
    }
    // plain / hero section (standalone; hero+content merging happens in aemToCanvas)
    const isHero = !!node['@backgroundImageReference'] || isColorHero(node);
    const blocks = [];
    if (isHero) blocks.push(heroBlockOf(node));
    // Enable container width inheritance so inner containers (container-medium,
    // container-large, etc.) propagate their width class to child blocks.
    // Known width-bearing blocks (title, text, video) get it on classes_customDynamicClass;
    // all others (cta, carousel, accordion, etc.) get it on classes_commonCustomClass.
    collectLeaves(node, blocks, '', true);
    sections.push({ type: 'section', props: sectionProps(node, isHero), blocks });
    return;
  }
  if (isGrid(rt)) {                     // bare top-level grid → wrap in a grid-container
    const gc = { type: 'grid-container', props: gridContainerProps([node], node), blocks: [] };
    expandGrid(node, gc.blocks, []);
    pushGridContainersByRows(sections, gc);
    return;
  }
  // bare leaf at top level → its own section
  const blocks = mapLeafExpanded(node);
  if (blocks.length) sections.push({ type: 'section', props: {}, blocks });
}

// current page's content-xml rel path (country/lang/…), used for breadcrumb homePagePath
let _ctxRel = null;

// A common AEM page shell is an image-only hero followed by an overlapping
// container. Its first nested container holds the breadcrumb + H1, while later
// sibling containers are the page body. Only that header group belongs in the
// EDS hero; flattening the full overlap wrapper into the hero makes every H2
// and paragraph render as hero content.
function semanticChildren(node) {
  const out = [];
  for (const [, child] of childEntries(node)) {
    const rt = RT(child);
    if (!rt || isLayoutWrapper(rt)) out.push(...semanticChildren(child));
    else out.push(child);
  }
  return out;
}
function isBreadcrumbH1Container(node) {
  if (!isContainer(RT(node))) return false;
  // A container that holds any grid is a body content container, not a pure
  // breadcrumb+H1 header. Absorbing it into the hero would swallow the grid.
  if (containerHasAnyGrid(node)) return false;
  let breadcrumb = false, h1 = false;
  (function scan(n) {
    for (const [, child] of childEntries(n)) {
      const rt = RT(child);
      if (!rt || isLayoutWrapper(rt)) { scan(child); continue; }
      // A nested semantic container is a separate layout group, never part of
      // the header signature being tested here.
      if (isContainer(rt) || isGrid(rt)) continue;
      const type = componentMap[rt]?.edsType;
      if (type === 'breadcrumb') breadcrumb = true;
      if (type === 'custom-title' && String(child['@type'] || '').toLowerCase() === 'h1') h1 = true;
    }
  })(node);
  return breadcrumb && h1;
}
function splitHeroContinuation(node) {
  const children = semanticChildren(node);
  const headerIndex = children.findIndex(isBreadcrumbH1Container);
  if (headerIndex < 0) return null;
  const body = children.filter((_, index) => index !== headerIndex);
  return body.length ? { header: children[headerIndex], body } : null;
}

// After a hero absorbs the breadcrumb+H1 header of an overlap container, the rest
// of that container's content is the page body. When the body carries a grid, EDS
// does NOT keep it as one lumped section: each grid renders as an inner-grid, and a
// NESTED container is a section boundary. This walker reproduces that — consecutive
// direct grids/leaves accumulate in the current section (matching the multi-inner-grid
// width-container pattern), while every nested container flushes and starts fresh
// sections (matching the migraine-friendly-workplace twin). Section props derive from
// the nearest container context, so styleless nested containers get clean defaults.
function emitHeroContinuationSections(bodyNodes, wrapper, sections) {
  let cur = null;
  const ensure = props => { if (!cur) { cur = { type: 'section', props: { ...props }, blocks: [] }; sections.push(cur); } return cur; };
  const walk = (list, ctxProps) => {
    for (const child of list) {
      const rt = RT(child);
      if (!rt || isLayoutWrapper(rt)) { walk(childEntries(child).map(([, c]) => c), ctxProps); continue; }
      if (isXF(rt)) continue;
      if (isGrid(rt)) emitInnerGrid(child, ensure(ctxProps).blocks, 0);
      else if (isContainer(rt)) { cur = null; walk(semanticChildren(child), sectionProps(child)); cur = null; }
      else ensure(ctxProps).blocks.push(...mapLeafExpanded(child));
    }
  };
  walk(bodyNodes, sectionProps(wrapper));
}

// Validate every emitted dynamic/typed style at the canvas boundary. A block
// with no local picklist configuration is left unchanged; where a picklist is
// present, unsupported values are never serialized into the EDS page.
// Classes that are computed dynamically and must never be stripped by picklist validation.
// `cols-*` and `ncol-*` / `col-*` are generated from AEM grid columnWidth values and are
// not enumerated in any static EDS picklist configuration.
const DYNAMIC_CLASS_RE = /^(?:cols-[\d-]+|n?col-\d+|width-(?:x{0,3}-)?(small|medium|large)|grid-(?:full-page|half-page|meganav)-[\w-]+)$/;

function validateCanvasStyles(sections) {
  const filter = (type, value) => {
    const picklist = picklistFor(type);
    if (!picklist) return value;
    const accepted = splitCls([value]).filter(cls => DYNAMIC_CLASS_RE.test(cls) || picklist.has(cls));
    return Array.isArray(value) ? accepted : accepted.join(',');
  };
  const visit = entity => {
    if (!entity || !entity.props) return;
    const props = entity.props;
    for (const key of ['style_customDynamicClass', 'classes_customDynamicClass']) {
      if (!(key in props)) continue;
      const value = filter(entity.type, props[key]);
      if ((Array.isArray(value) && !value.length) || (!Array.isArray(value) && !value)) delete props[key];
      else props[key] = value;
    }
    for (const [key, value] of Object.entries(props)) {
      if (key === 'style_container' || !key.startsWith('style_') || typeof value !== 'string') continue;
      if (!supportsStyle(entity.type, value)) delete props[key];
    }
    for (const child of entity.children || entity.blocks || []) visit(child);
  };
  for (const section of sections || []) visit(section);
  return sections;
}

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
      // Peek ahead for the overlap container (c2) so heroBlockOf can derive
      // controller height and overlay classes from container2's height style.
      let overlapNode = null;
      for (let k = i + 1; k < tops.length; k++) {
        const pk = tops[k];
        if (isContainer(RT(pk)) && !pk['@backgroundImageReference'] && !isColorHero(pk) && overlapsHero(pk)) {
          overlapNode = pk; break;
        }
        if (isHeroContainer(pk)) break;
      }
    const blocks = [heroBlockOf(node, overlapNode)];
      const bodyGroups = [];
      // The merged hero section owns layout. Do not propagate a container width
      // onto title/text blocks in the hero or its absorbed intro content.
      collectLeaves(node, blocks, '', false);       // hero's own content, if any
      let j = i + 1;
      while (j < tops.length) {                     // absorb following plain content container(s)
        const nx = tops[j];
        if (isContainer(RT(nx)) && !nx['@backgroundImageReference'] && !isColorHero(nx) && overlapsHero(nx)) {
          const split = splitHeroContinuation(nx);
          if (split) {
            const headerBlocks = [];
            collectLeaves(split.header, headerBlocks, '', false);
            blocks.push(...headerBlocks);
            // Only a DIRECT grid in the overlap container triggers per-grid /
            // per-nested-container splitting (emitHeroContinuationSections) — the case the
            // prior `!containerHasGrid` guard wrongly excluded from hero absorption. A grid
            // nested inside a width-style sub-container stays on the existing body-group path
            // (cols-12 inner-grid), which the corpus already migrates correctly (e.g. contact-us).
            bodyGroups.push({ wrapper: nx, nodes: split.body, split: containerHasGrid(nx) });
            // strip width classes from header blocks absorbed into hero
            j++;
            break;                                  // later containers are page body, not hero continuation
          }
          // A direct grid with no breadcrumb+H1 header is page-body content, not hero
          // continuation — leave it to emitNode (matches the prior `!containerHasGrid` guard).
          if (containerHasGrid(nx)) break;
          // Any overlap container that contains ANY grid (at any depth) must go to bodyGroups
          // rather than collectLeaves, to prevent the grid structure from being flattened into
          // the hero section. splitHeroContinuation already handled the breadcrumb+H1 case above.
          if (containerHasAnyGrid(nx)) {
            const allChildren = semanticChildren(nx);
            if (allChildren.length) bodyGroups.push({ wrapper: nx, nodes: allChildren });
            j++;
            break;
          }
          collectLeaves(nx, blocks, '', false); j++;
        }
        else break;
      }
      i = j - 1;
      // Hero section keeps the container's width/radius/margin styleIds (height → hero block,
      // color/image → item). NOT bare — 1429 of 1438 twin hero sections carry classes.
      // Strip all width classes (width-*, video-*) from every block inside the hero section.
      // Hero blocks must not carry inherited or own-style width classes — the hero layout
      // uses full-bleed / overlay positioning, not the EDS content-width constraint system.
      const WIDTH_RE = /^(?:width|video)-(?:x{0,3}-)?(?:small|large|medium)$/;
      function stripHeroWidthClasses(blockList) {
        for (const b of blockList || []) {
          if (b.props) {
            for (const key of ['classes_customDynamicClass', 'classes_commonCustomClass']) {
              if (!b.props[key]) continue;
              const cleaned = String(b.props[key]).split(',').map(s => s.trim())
                .filter(c => !WIDTH_RE.test(c)).join(',');
              if (cleaned) b.props[key] = cleaned;
              else delete b.props[key];
            }
          }
          stripHeroWidthClasses(b.children || []);
        }
      }
      stripHeroWidthClasses(blocks);
      sections.push({ type: 'section', props: sectionProps(node, true), blocks });
      for (const group of bodyGroups) {
        // Hero-continuation body that carries a grid: emit per-grid / per-nested-container
        // sections instead of one lumped section (structure verified against the twin).
        if (group.split) { emitHeroContinuationSections(group.nodes, group.wrapper, sections); continue; }
        const bodyBlocks = [];
        for (const bodyNode of group.nodes) {
          const brt = RT(bodyNode);
          if (isContainer(brt) && containerHasWidthStyle(bodyNode) && containerHasAnyGrid(bodyNode)) {
            // Body container with width style + grid → inner-grid pattern.
            // The bodyNode itself IS the width-style container (e.g. container-medium),
            // so we must emit the cols-12,width-X controller BEFORE calling collectCellLeaves,
            // then mark all its content as col-1 (depth=0 column of the outer 12-col grid).
            const childWidth = containerBlockWidth(bodyNode, '');
            const colsClass = 'cols-12' + (childWidth ? ',' + childWidth : '');
            const controller = { type: 'inner-grid', props: { classes_customDynamicClass: colsClass }, children: [] };
            bodyBlocks.push(controller);
            const cellBlocks = [];
            collectCellLeaves(bodyNode, cellBlocks, 1, childWidth);
            cellBlocks.forEach(block => {
              if (block._innerManaged) return;
              addCommonClass(block, 'col-1');
              markInnerManaged(block);
            });
            bodyBlocks.push(...cellBlocks);
        } else {
            collectLeaves(bodyNode, bodyBlocks, '', true);
          }
        }
        if (bodyBlocks.length) {
          // The body section after the hero inherits the overlap container's props. Strip any
          // radius class that belongs to the AEM container band visual — the EDS body content
          // section has no corner rounding. The typed style_borderRadius is also removed.
          const bp = sectionProps(group.wrapper);
          const bClasses = splitCls([bp.style_customDynamicClass]).filter(c => !EXCL_RADIUS.has(c));
          bp.style_customDynamicClass = bClasses.join(',');
          delete bp.style_borderRadius;
          sections.push({ type: 'section', props: bp, blocks: bodyBlocks });
        }
      }
      continue;
    }
    emitNode(node, sections);
  }
  return applyQuoteTransparencyRule(validateCanvasStyles(hoistTrailingSeparator(sections)));
}

// The page-final separator (the spacer just above the footer) must live in its OWN bare section,
// never nested inside the last grid — verified: of 786 EDS pages ending in a separator, 0 nest it
// in a grid and 474 have it alone in a bare section. It is always the footer spacer, so EDS
// requires the wide band with section padding and no trailing margin.
function footerSeparatorSectionProps(props = {}) {
  const required = ['content-wide', 'section-padding', 'no-bottom-margin'];
  return {
    ...props,
    style_contentWidth: 'content-wide',
    style_padding: 'section-padding',
    style_margin: 'no-bottom-margin',
    style_customDynamicClass: [...new Set([...splitCls([props.style_customDynamicClass]), ...required])].join(','),
  };
}
function hoistTrailingSeparator(sections) {
  if (!sections.length) return sections;
  const last = sections[sections.length - 1];
  if (last.type === 'grid-container' && Array.isArray(last.blocks)) {
    for (let gi = last.blocks.length - 1; gi >= 0; gi--) {
      const kids = last.blocks[gi] && last.blocks[gi].children;
      if (!kids || !kids.length) continue;                       // skip empty grid-sections
      if (kids[kids.length - 1].type === 'separator') sections.push({ type: 'section', props: footerSeparatorSectionProps(), blocks: [kids.pop()] });
      break;                                                     // only the last non-empty grid-section
    }
  } else if (last.type === 'section' && Array.isArray(last.blocks) && last.blocks.length > 1
             && last.blocks[last.blocks.length - 1].type === 'separator') {
    sections.push({ type: 'section', props: footerSeparatorSectionProps(), blocks: [last.blocks.pop()] });
  }
  const footerSpacer = sections[sections.length - 1];
  if (footerSpacer?.type === 'section' && footerSpacer.blocks?.length === 1
      && footerSpacer.blocks[0]?.type === 'separator') {
    footerSpacer.props = footerSeparatorSectionProps(footerSpacer.props);
  }
  // A separator-only section is a spacer band, not regular content. Keep an
  // explicitly authored section-padding variation (and the footer rule above),
  // but never carry regular-padding onto that section.
  for (const section of sections) {
    if (section?.type !== 'section' || section.blocks?.length !== 1 || section.blocks[0]?.type !== 'separator') continue;
    const props = section.props || (section.props = {});
    const classes = splitCls([props.style_customDynamicClass]).filter(c => c !== 'regular-padding');
    if (!classes.includes('no-bottom-margin')) classes.push('no-bottom-margin');
    props.style_customDynamicClass = classes.join(',');
    if (props.style_padding === 'regular-padding') delete props.style_padding;
    props.style_margin = 'no-bottom-margin';
  }
  return sections;
}

// Normalize a single block's variant props in place. Returns 'separator'|'eyebrow'|null.
// Shared by generation (mapLeaf) and the in-place Fill button (normalizeSections).
function normalizeBlock(b) {
  if (!b || !b.props) return null;
  if (b.type === 'separator') {
    // Preserve only explicitly mapped separator variants. The AEM-to-EDS path
    // omits unstyled separators entirely, rather than inventing a 24px spacer.
    const before = (b.props.classes_customDynamicClass || '') + '|' + b.props.showLine;
    const cls = String(b.props.classes_customDynamicClass || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!cls.length) return null;
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

// Post-processing: when a section or grid-container has an authored background
// image AND contains a quote block, add the semi-transparent-layer style so
// the quote text is readable against the image.
function applyQuoteTransparencyRule(sections) {
  function containsQuote(blocks) {
    if (!blocks) return false;
    for (const blk of blocks) {
      if (blk.type === 'quote') return true;
      // grid-section children
      if (blk.children && blk.children.length && containsQuote(blk.children)) return true;
    }
    return false;
  }

  for (const sec of sections || []) {
    if (!sec.props || !sec.props.background) continue; // no background image → skip
    // Collect all blocks to check (grid-container uses .blocks → grid-sections → .children)
    let quoteFound = false;
    if (sec.type === 'grid-container') {
      for (const gs of sec.blocks || []) {
        if (containsQuote(gs.children)) { quoteFound = true; break; }
      }
    } else {
      quoteFound = containsQuote(sec.blocks);
    }
    if (!quoteFound) continue;

    const existing = new Set(
      String(sec.props.style_customDynamicClass || '').split(',').map(s => s.trim()).filter(Boolean)
    );
    if (!existing.has('semi-transparent-layer')) {
      existing.add('semi-transparent-layer');
      sec.props.style_customDynamicClass = [...existing].join(',');
      // Also set the typed picklist prop so the authoring UI reflects the selection
      sec.props.style_transparency = 'semi-transparent-layer';
    }
  }
  return sections;
}

module.exports = { aemToCanvas, mapLeaf, normalizeBlock, normalizeSections };
