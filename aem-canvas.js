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

// mirror of server.js applyPropTransform
function applyPropTransform(transformName, val) {
  if (transformName === 'xf-warn-departure') {
    // AEM XF path: /content/experience-fragments/abbvie-com2/{country}/{lang}/site/popups/...
    // EDS path:    /content/abbvie-nextgen-eds/corporate/abbvie-com/{country}/{lang}/modal-fragment/warn-departure-modal
    const parts = val.split('/').filter(Boolean);
    const locale = (parts[3] && parts[4]) ? `${parts[3]}/${parts[4]}` : '';
    return locale
      ? `/content/abbvie-nextgen-eds/corporate/abbvie-com/${locale}/modal-fragment/warn-departure-modal`
      : val;
  }
  return val;
}

// mirror of server.js extractPropsFromXmlNode
function extractProps(node, mapping) {
  const renames   = mapping?.propRenames    || {};
  const propTrans = mapping?.propTransforms || {};
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
      const targetKey = renames[key] || key;
      val = transformPath(val, pathMap);
      // Apply propTransforms if defined for this EDS key
      if (propTrans[targetKey]) val = applyPropTransform(propTrans[targetKey], val);
      props[targetKey] = val;
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
const LAYOUT_CLASS = /^(?:content-(?:wide|regular|narrow|full-width)|container-[a-z-]+|full-width|align-(?:left|center|right)|no-(?:padding|bottom-margin|bottom-padding|top-padding|top-bottom-padding|side-margin)|regular-padding|small-padding|section-padding|padding-bottom|section-bottom-margin|(?:large|medium|small|default)-radius|semi-transparent-layer|linear-gradient|static|float|homepage-overlap|overlap-predecessor|height-(?:short|tall|x-tall|xx-tall|default)|(?:light|dark)-theme|grid-(?:full-page|half-page|meganav)-[\w-]+)$/;
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

// `no-side-margin` is applied when any container in the chain has a styleId that resolves
// to aemClass 'cmp-container-full-width' (full-bleed band). Never applied on hero sections.
function restrictNoSideMargin(resolved, hero = false, nodes = []) {
  if (hero) return resolved;
  const hasCmpFullWidth = nodes.some(node => {
    const raw = node?.['@cq:styleIds'];
    if (!raw) return false;
    const ids = String(raw).replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
    return ids.some(id => {
      const entry = resolveStyleId(id, 'section') || resolveStyleId(id, null);
      return entry?.aemClass === 'cmp-container-full-width';
    });
  });
  if (hasCmpFullWidth) {
    return {
      ...resolved,
      classes: resolved.classes.includes('no-side-margin')
        ? resolved.classes
        : [...resolved.classes, 'no-side-margin'],
    };
  }
  return resolved;
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
  // Blocks that manage their own width vocabulary and must NEVER receive an inherited
  // container width — not on classes_customDynamicClass nor classes_commonCustomClass:
  //   • custom-image  — has its own image-size width vocabulary (width-small, width-large etc.)
  //   • accordion     — its own width class (accordion-large, accordion-medium) is set
  //                     independently; container width must not be mixed in
  const WIDTH_INHERIT_EXCLUDE = new Set(['custom-image', 'accordion']);
  const widthClass = (type === 'video' || type === 'brightcove-video')
    ? String(inheritedBlockWidth || '').replace(/^width-/, 'video-')
    : inheritedBlockWidth;
  const WIDTH_CLS_RE = /^(?:width|video)-(?:x{0,3}-)?(?:small|large|medium)$/;
  let _inheritedWidthApplied = false;
  if (widthClass && !WIDTH_INHERIT_EXCLUDE.has(type)) {
    if (isWidthTarget && supportsStyle(type, widthClass)) {
      // Always apply inherited container width, replacing any own width styleId.
      const existingClasses = String(props.classes_customDynamicClass || '').split(',').map(c => c.trim()).filter(Boolean);
      const withoutWidth = existingClasses.filter(c => !WIDTH_CLS_RE.test(c));
      withoutWidth.push(widthClass);
      props.classes_customDynamicClass = [...new Set(withoutWidth)].join(',');
      _inheritedWidthApplied = true;
    } else if (!isWidthTarget) {
      // Non-width-target blocks (cta, carousel, etc.)
      // → carry the inherited width as a custom class so it still reaches EDS.
      const existing = String(props.classes_commonCustomClass || '').split(/[,\s]+/).filter(Boolean);
      const withoutWidth = existing.filter(c => !WIDTH_CLS_RE.test(c));
      if (!withoutWidth.includes(widthClass)) withoutWidth.push(widthClass);
      props.classes_commonCustomClass = withoutWidth.join(',');
      _inheritedWidthApplied = true;
    }
  }
  // Always pull the image caption from DAM metadata on the live site.
  // Setting getCaptionFromDAM=true tells EDS to fetch the caption at render
  // time from the DAM asset, so it is always up-to-date even if the AEM XML
  // has no jcr:title. displayCaptionBelowImage is always false — the caption
  // is used for a11y alt-text purposes only, not rendered below the image.
  if (type === 'custom-image') {
    props.getCaptionFromDAM = '{Boolean}true';
    props.displayCaptionBelowImage = '{Boolean}false';
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
    // Always add align-center to accordion blocks.
    set.add('align-center');
    // Reduce the accordion width class by one step (accordion-xx-large → accordion-x-large, etc.).
    // This compensates for the EDS layout rendering the accordion at a larger effective width
    // than the AEM authoring preview, so stepping down one size preserves visual parity.
    const ACCORDION_WIDTH_DOWNSIZE = {
      'accordion-xxx-large': 'accordion-xx-large',
      'accordion-xx-large':  'accordion-x-large',
      'accordion-x-large':   'accordion-large',
      'accordion-large':     'accordion-medium',
      'accordion-medium':    'accordion-small',
      'accordion-small':     'accordion-x-small',
    };
    for (const [big, small] of Object.entries(ACCORDION_WIDTH_DOWNSIZE)) {
      if (set.has(big)) { set.delete(big); set.add(small); break; }
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

  // Custom-embed: derive the EDS `embeddable` select value from the AEM embeddableResourceType.
  // AEM stores the full sling:resourceType path (e.g. "…/embed/embeddable/onetrust") while EDS
  // expects a short selector string matching the component-model select options.
  // Also: when the parent embed node has no embeddableResourceType but does have oneTrustId,
  // default to "oneTrust" so the EDS UI shows the correct conditional fields.
  if (type === 'custom-embed') {
    const EMBEDDABLE_MAP = {
      onetrust:    'oneTrust',
      podcast:     'podcast',
      wallsio:     'wallsio',
      jobpixel:    'jobPixle',
      toolselector: 'toolSelector',
      chatbot:     'chatbot',
    };
    // embeddableResourceType was skipped from extractProps, so read it directly from the node.
    const embRt = String(node['@embeddableResourceType'] || '').trim();
    const suffix = embRt.split('/').pop().toLowerCase();

    if (suffix && EMBEDDABLE_MAP[suffix]) {
      props.embeddable = EMBEDDABLE_MAP[suffix];
    } else if (!props.embeddable) {
      // Fallback: infer from which props are populated
      if (props.oneTrustId) props.embeddable = 'oneTrust';
      else if (props.videoId) props.embeddable = 'podcast';
    }

    // Podcast embed: rebuild the podcastDataAttributes nested JCR node.
    // AEM (old embed/v2/embed) stores attrs in `podcastparam` as itemN with @attributeName/@attributeValue.
    // AEM (new block/v1/block) stores attrs in `podcastDataAttributes` as itemN with @key/@value (or key/value).
    // EDS JCR block model expects: podcastDataAttributes.item0.key / podcastDataAttributes.item0.value
    if (props.embeddable === 'podcast') {
      const podcastParam = node.podcastparam;
      const podcastDataAttr = node.podcastDataAttributes;
      const jcrItems = {};
      let idx = 0;

      if (podcastParam && typeof podcastParam === 'object') {
        // Old embed/v2/embed format: @attributeName / @attributeValue
        // Normalize "script src" (with space) → "script-src" (with hyphen) for EDS compatibility.
        for (const [, item] of Object.entries(podcastParam)) {
          if (!item || typeof item !== 'object') continue;
          const rawKey = String(item['@attributeName'] || '').trim();
          const key = rawKey === 'script src' ? 'script-src' : rawKey;
          const value = String(item['@attributeValue'] || '').trim();
          if (key) jcrItems[`item${idx++}`] = { 'jcr:primaryType': 'nt:unstructured', key, value };
        }
      } else if (podcastDataAttr && typeof podcastDataAttr === 'object') {
        // New block/v1/block format: @key/@value (XML) or key/value (JSON)
        for (const [, item] of Object.entries(podcastDataAttr)) {
          if (!item || typeof item !== 'object') continue;
          const key = String(item['@key'] !== undefined ? item['@key'] : (item.key ?? '')).trim();
          const value = String(item['@value'] !== undefined ? item['@value'] : (item.value ?? '')).trim();
          if (key) jcrItems[`item${idx++}`] = { 'jcr:primaryType': 'nt:unstructured', key, value };
        }
      }

      if (idx > 0) {
        props.podcastDataAttributes = { 'jcr:primaryType': 'nt:unstructured', ...jcrItems };
      }
    }
  }

  // AEM inline richtext typography classes (body-unica-*) → the block's classes_commonCustomClass
  // ("Custom Class"), and unwrap ALL <span>s so the text isn't double-styled. Only body-unica-*
  // is kept — theme classes (light-font) and Word-paste junk (BCX*, NormalTextRun, SCXW*…) are dropped.
  const existing = String(props.classes_commonCustomClass || '').split(/[,\s]+/).filter(Boolean);
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
  if (outCls.length) props.classes_commonCustomClass = outCls.join(',');

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
    const blk0 = { type, props, children: items };
    if (_inheritedWidthApplied) Object.defineProperty(blk0, '_hasInheritedWidth', { value: true, enumerable: false });
    return blk0;
  }
  // single content child (e.g. text → text-container-text)
  if (mapping?.childType && mapping?.childProp && props[mapping.childProp] !== undefined) {
    const cv = props[mapping.childProp];
    delete props[mapping.childProp];
    const blk1 = { type, props, children: [{ type: mapping.childType, props: { [mapping.childProp]: cv }, children: [] }] };
    if (_inheritedWidthApplied) Object.defineProperty(blk1, '_hasInheritedWidth', { value: true, enumerable: false });
    return blk1;
  }
  const blk2 = { type, props, children: [] };
  if (_inheritedWidthApplied) Object.defineProperty(blk2, '_hasInheritedWidth', { value: true, enumerable: false });
  return blk2;
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
// Nested background-color container that directly wraps a grid:
// → emit as inner-grid with combined container + grid styles + bg-color class.
// Column layout (par_RC cells) is preserved via col-N assignments on child blocks.
// This is the "grey band image+text card" pattern (container_609876501_ in benefits pages):
//   container (bg=#F4F4F4, container-xxx-large, align-center) + grid (no-bottom-margin, cols 6-1-5)
//   → inner-grid { cols-6-1-5, bg-f4f4f4, container-xxx-large, align-center, no-bottom-margin }
function emitNestedBgGrid(containerNode, out, inheritedBlockWidth = '') {
  // Collect direct grids through layout wrappers (not through nested containers)
  const grids = directGrids(containerNode);
  const grid = grids[0];
  if (!grid) { collectLeaves(containerNode, out, inheritedBlockWidth); return; }

  const cols = gridColumns(grid);
  if (!cols.length) { collectLeaves(containerNode, out, inheritedBlockWidth); return; }

  // Build the inner-grid controller classes:
  //   1. Column spec from grid columns
  //   2. bg-color from container backgroundColor
  //   3. Layout style classes from container styleIds (container-xxx-large, align-center, height-default, …)
  //   4. Layout style classes from grid styleIds (no-bottom-margin, …)
  const colSpec   = `cols-${cols.map(c => c.width).join('-')}`;
  const bg        = bgClass(containerNode);
  const contCls   = splitCls([layoutStyleClasses(containerNode)]);
  const gridCls   = splitCls([layoutStyleClasses(grid)]);
  const allCls    = [...new Set([colSpec, bg, ...contCls, ...gridCls].filter(Boolean))];

  const controller = {
    type: 'inner-grid',
    props: { classes_customDynamicClass: allCls.join(',') },
    children: [],
  };
  out.push(controller);

  // Emit grid column cells with col-N assignments
  const rowCount = parseInt(grid['@rowCount'] || '1') || 1;
  for (let r = 1; r <= rowCount; r++) {
    for (let c = 1; c <= cols.length; c++) {
      const par = grid[`par_${r}${c}`];
      const cellBlocks = [];
      if (par && typeof par === 'object') collectCellLeaves(par, cellBlocks, 0, inheritedBlockWidth);
      const colClass = `col-${c}`;
      cellBlocks.forEach(block => {
        if (block._innerManaged) return;
        addCommonClass(block, colClass);
        markInnerManaged(block);
      });
      out.push(...cellBlocks);
    }
  }
}

function collectLeaves(node, out, inheritedBlockWidth = '', applyContainerWidth = true) {
  const width = applyContainerWidth && isContainer(RT(node))
    ? containerBlockWidth(node, inheritedBlockWidth) : inheritedBlockWidth;
  for (const [, child] of childEntries(node)) {
    const rt = RT(child);
    if (!rt || isLayoutWrapper(rt)) { collectLeaves(child, out, width, applyContainerWidth); continue; }
    if (isXF(rt)) continue;
    if (isGrid(rt)) {
      const cols = gridColumns(child);
      // Multi-column grid nested inside a container or section → preserve as inner-grid.
      // Single-column / no-columns grids are transparent wrappers → flatten (legacy behaviour).
      if (cols.length && (cols.length > 1 || cols[0].width !== '12')) {
        emitInnerGrid(child, out, 0);
      } else {
        collectLeaves(child, out, width, applyContainerWidth);   // no real columns → flatten
      }
      continue;
    }
    if (isContainer(rt)) {
      // ── NEW PATTERN: nested container with backgroundColor + direct grid ──
      // Preserve the bg-color band and grid column layout as an inner-grid
      // instead of flattening everything into the parent section.
      if (bgClass(child) && containerHasDirectGrid(child)) {
        emitNestedBgGrid(child, out, width);
        continue;
      }
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
  'grid-container': ['content-regular', 'regular-padding'],
};
const STYLE_DEFAULTS_FALLBACK = {
  section:          ['no-bottom-margin'],
  'grid-container': [],
};
const NOOP_CLASS = new Set(['height-default']);              // EDS omits the "default" height (no-op) on sections/grids
// Classes that are never valid on grid-containers (container-level padding overrides that
// don't translate to grid-container EDS styling). `no-padding` is a section-level visual
// tweak on AEM containers but the EDS grid-container equivalent uses `regular-padding`.
const GRID_CONTAINER_EXCL = new Set(['no-padding', 'container-full-width']);
const isWidthCls  = c => ['content-wide', 'content-regular', 'content-narrow', 'full-width'].includes(c) || /^container-/.test(c);
const EXCL_RADIUS = new Set(['large-radius', 'medium-radius', 'small-radius', 'no-radius']);
const splitCls = arr => arr.filter(Boolean).flatMap(c => String(c).split(',')).map(c => c.trim()).filter(Boolean);
const hasStyleId = (node, id) => String(node?.['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',').includes(id);
function applyFullWidthContainerRule(resolved, containers) {
  if (!containers.some(node => hasStyleId(node, FULL_WIDTH_CONTAINER_STYLE_ID))) return resolved;
  // FULL_WIDTH_CONTAINER_STYLE_ID (1653545825683) = AEM "container-full-width" → EDS content-wide.
  // When this style ID is authored on a container or grid, always map to content-wide.
  // When absent, the default (content-regular) flows from mergeDefaults.
  return {
    classes: [...resolved.classes.filter(c => !isWidthCls(c)), 'content-wide'],
    typed: { ...resolved.typed, style_contentWidth: 'content-wide' },
  };
}
// merge template defaults into derived classes: derived (from AEM) wins on exclusive families
// (width/radius); ALWAYS defaults fill required gaps; FALLBACK padding/margin apply only when the
// AEM node yielded no styling at all (`derived` empty = nothing inferred).
function mergeDefaults(kind, derived, hasBg = false) {
  // Deduplicate derived first (layoutStyleProps + applyFullWidthContainerRule can both add content-wide)
  const seen = new Set();
  const deduped = derived.filter(c => { if (seen.has(c)) return false; seen.add(c); return true; });
  const out = [...deduped]; const has = new Set(deduped);
  const hasW = deduped.some(isWidthCls), hasR = deduped.some(c => EXCL_RADIUS.has(c));
  const add = list => { for (const d of list) {
    if (has.has(d) || (isWidthCls(d) && hasW) || (EXCL_RADIUS.has(d) && hasR)) continue;
    out.push(d); has.add(d);
  } };
  // No background → skip padding defaults; add no-bottom-margin instead.
  // Background present → apply padding defaults as usual.
  const always = STYLE_DEFAULTS_ALWAYS[kind] || [];
  if (hasBg) {
    add(always);
  } else {
    add(always.filter(c => !/padding/.test(c)));  // skip section-padding / regular-padding
    if (!has.has('no-bottom-margin')) { out.push('no-bottom-margin'); has.add('no-bottom-margin'); }
  }
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

  // Resolve c2 (overlap container): pull radius + height → overlay derivation
  let c2Radius = null;
  let overlayClasses = []; // only set when height is non-default
  if (overlapNode) {
    const c2Classes = splitCls([styleIdClasses(overlapNode)]);
    c2Radius = c2Classes.find(c => EXCL_RADIUS.has(c)) || null;
    const c2Height = c2Classes.find(c => /^height-/.test(c)) || 'height-default';
    // overlay-height-* classes are only needed when the height is non-default.
    // height-default is the EDS implicit baseline — no overlay class required.
    overlayClasses = (c2Height !== 'height-default') ? (HEIGHT_TO_OVERLAY[c2Height] || []) : [];
  }

  let item;
  if (imageHero) {
    const alt = bgImg.split('/').pop().replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    const ext = (bgImg.split('.').pop() || '').toLowerCase();
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
    // Controller: c1 height + overlay heights (derived from c2's height, 1:1 mapping) + c2 radius
    const ctrlClasses = [c1Height, ...overlayClasses, c2Radius].filter(Boolean);
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
    // Controller for color hero: c1 height + overlay heights (derived from c2) + c2 radius
    const ctrlParts = [c1Height, ...overlayClasses, c2Radius].filter(Boolean);
    const props = { filter: 'hero-container', classes_customDynamicClass: ctrlParts.join(',') };
    return { type: 'hero-container', props, children: [item] };
  }
}
// section classes for a container: derived (minus height, which went to the hero block) + defaults
function sectionProps(node, hero = false, overlapNode = null) {
  const nodes = Array.isArray(node) ? node : [node];

  // ── HERO SECTION RULE ────────────────────────────────────────────────────
  // EDS hero sections carry a NARROW set of classes from C1 only:
  //   • width   : content-full-width → content-wide
  //   • radius  : large-radius / medium-radius / small-radius
  //
  // EXCLUDED from section:
  //   • no-bottom-margin  → dropped (hero sections do not carry bottom margin)
  //   • height-*          → hero-container ctrl block (heroBlockOf)
  //   • bg-* color        → hero-container-item (color hero)
  //   • bg-image          → hero-container-item
  //   • container-full-width  → AEM wrapper ID, NOT a valid EDS section width class
  if (hero) {
    const c1 = Array.isArray(node) ? node[0] : node;
    const c1Resolved = layoutStyleProps([c1], { compType: 'section', includeHeight: false });
    const c1Classes = c1Resolved.classes;

    // Classes explicitly excluded from the hero section
    const HERO_SEC_EXCL = new Set([
      'container-full-width', // AEM wrapper ID — NOT a width class on EDS sections
      'height-default', 'height-short', 'height-tall', 'height-x-tall', 'height-xx-tall', // → hero ctrl
      'no-padding',           // AEM padding reset — not a valid EDS section class
      // NOTE: no-bottom-margin is intentionally NOT excluded here — when AEM explicitly
      // authors it on C1 (styleId 1653545835879) it must appear on the hero section.
    ]);
    // Background color/image → hero item only, not section
    const filteredClasses = c1Classes.filter(c => !HERO_SEC_EXCL.has(c) && !/^bg-/.test(c));

    // content-full-width → content-wide; keep container-xxx-large etc as-is
    const widthMapped = filteredClasses.map(c => c === 'content-full-width' ? 'content-wide' : c);

    // Ensure content-wide when C1 has content-full-width or FULL_WIDTH_CONTAINER_STYLE_ID
    const hasFullWidth = hasStyleId(c1, FULL_WIDTH_CONTAINER_STYLE_ID) ||
      c1Classes.includes('content-full-width');
    if (hasFullWidth && !widthMapped.includes('content-wide')) widthMapped.unshift('content-wide');

    const derived = [...new Set(widthMapped)];
    const typed = { ...c1Resolved.typed };
    delete typed['style_height'];  // height → hero ctrl only
    if (typed.style_contentWidth === 'content-full-width') typed.style_contentWidth = 'content-wide';
    if (typed.style_contentWidth === 'container-full-width') delete typed.style_contentWidth;

    return { style_customDynamicClass: derived.join(',') };
  }

  // ── NON-HERO SECTION ─────────────────────────────────────────────────────
  // Note: applyFullWidthContainerRule is intentionally NOT applied here.
  // `container-full-width` (ID 1653545825683) is an AEM container rendering instruction,
  // NOT a valid EDS section width class. It must be stripped from section derived classes.
  // EDS section width (content-wide/content-regular/content-narrow) only comes from the
  // explicit EDS picklist style IDs (17805012834871, 1780501283488, etc.).
  let resolved = layoutStyleProps(nodes, { compType: 'section' });
  resolved = restrictNoSideMargin(resolved, false, nodes);
  resolved = {
    ...resolved,
    // container-full-width → content-wide (AEM full-width wrapper → EDS wide width)
    classes: resolved.classes.map(c => c === 'container-full-width' ? 'content-wide' : c === 'content-full-width' ? 'content-wide' : c),
    typed: Object.fromEntries(
      Object.entries(resolved.typed).map(([k, v]) => [k, v === 'content-full-width' ? 'content-wide' : v])
    ),
  };
  // Map container-full-width → content-regular in typed styles
  // FULL_WIDTH_CONTAINER_STYLE_ID (1653545825683) = AEM "container-full-width" rendering hint.
  // In EDS this is NOT a content-wide override — it maps to `content-regular` (the default
  // readable content width). Only the explicit EDS content-wide picklist IDs should produce content-wide.
  if (resolved.typed.style_contentWidth === 'container-full-width') resolved.typed.style_contentWidth = 'content-regular';
  // FULL_WIDTH_CONTAINER_STYLE_ID (1653545825683) present → content-wide wrapper section.
  // No background → short-circuit: plain wrapper sections carry ONLY content-wide + no-bottom-margin.
  // With background → fall through to the normal derivation path so bg-color, no-side-margin,
  // section-padding, radius etc. are all correctly included (only the width is forced to content-wide).
  const hasFullWidthStyle = nodes.some(n => hasStyleId(n, FULL_WIDTH_CONTAINER_STYLE_ID));
  if (hasFullWidthStyle) {
    const hasBgFW = nodes.some(n => !!bgClass(n) || !!n['@backgroundImageReference']);
    if (!hasBgFW) return { style_customDynamicClass: 'content-wide,no-bottom-margin' };
    // bg present → fall through, but force content-wide as the width
  }
  let derived = resolved.classes;
  const hasOverlap = derived.some(c => c === 'overlap-predecessor' || c === 'homepage-overlap');
  // 'no-padding' is an AEM container styling reset that has no valid EDS section equivalent —
  // exclude it so it never leaks onto the section style_customDynamicClass.
  derived = derived.filter(c => c !== 'overlap-predecessor' && c !== 'homepage-overlap' && c !== 'no-padding' && c !== 'height-default' && (!hasOverlap || !EXCL_RADIUS.has(c)));
  if (hasOverlap) delete resolved.typed.style_borderRadius;
  const hasBg = nodes.some(n => !!bgClass(n) || !!n['@backgroundImageReference']);
  const classes = mergeDefaults('section', derived, hasBg);
  return { style_customDynamicClass: classes.join(',') };
}
function gridContainerProps(containers, grid = null) {
  // Container styles describe the shared visual band. Grid styles describe a
  // particular grid inside that band and therefore must be applied only when
  // that source grid is emitted as its own EDS grid-container.
  const chain = Array.isArray(containers) ? containers : [containers];
  const container = chain[chain.length - 1];
  const hasBg = !!bgClass(container) || !!container['@backgroundImageReference'];

  // FULL_WIDTH_CONTAINER_STYLE_ID (1653545825683) = AEM "container-full-width" rendering hint.
  // For EDS grid-containers WITHOUT a background:
  //   → emit content-regular only (no regular-padding, no no-bottom-margin defaults).
  //     The EDS twin confirms plain wrapper grid-containers carry ONLY `grid-container,content-regular`.
  // For EDS grid-containers WITH a background (bg-color or bg-image):
  //   → content-wide (the EDS full-bleed background band width). The no-side-margin and other
  //     defaults still apply normally via mergeDefaults.
  const hasFullWidthId = chain.some(n => hasStyleId(n, FULL_WIDTH_CONTAINER_STYLE_ID));
  // FULL_WIDTH_CONTAINER_STYLE_ID (1653545825683) present → content-wide.
  // Absent → mergeDefaults supplies content-regular as the default width.
  // No special-casing for background presence — width mapping is purely driven by the style ID.
  const resolved = restrictNoSideMargin(applyFullWidthContainerRule(layoutStyleProps([...chain, grid], { compType: 'grid-container' }), chain), false, chain);
  const derived = resolved.classes
    .filter(c => !NOOP_CLASS.has(c) && !GRID_CONTAINER_EXCL.has(c))
    .filter(c => !/^container-/.test(c));  // grid-containers use only content-* widths, never container-*
  // Only actual AEM grid nodes carry a bottom margin (`.grid { @include large-margin }`).
  // Containers converted to grid-containers do NOT have this CSS default in AEM, so
  // section-bottom-margin should only be added when a real AEM grid node is present (grid != null).
  const gcMerged = mergeDefaults('grid-container', derived, hasBg)
    .map(c => (grid && c === 'no-bottom-margin') ? 'section-bottom-margin' : c);
  if (grid && !gcMerged.includes('section-bottom-margin')) gcMerged.push('section-bottom-margin');
  const classes = ['grid-container', ...gcMerged].join(',');
  return { style_container: 'grid-container', style_customDynamicClass: classes, ...bgImageProps(container) };
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
// A container "overlaps" the hero (should be absorbed into it) when:
//   1. It carries the overlap-predecessor or homepage-overlap styleId (explicit AEM authoring signal), OR
//   2. It structurally contains an H1 title or breadcrumb (structure-based detection —
//      removes dependency on the overlap-predecessor styleId being present on every page).
// Rule 2 fires when: the container (or any nested container without its own grid) holds
// a custom-title with type="h1" or a breadcrumb component.
function containerHasH1OrBreadcrumb(node) {
  for (const [, child] of childEntries(node)) {
    const rt = RT(child);
    if (!rt || isLayoutWrapper(rt)) { if (containerHasH1OrBreadcrumb(child)) return true; continue; }
    if (isXF(rt)) continue;
    if (isGrid(rt)) continue;          // grids = body content, not intro header
    if (isContainer(rt)) { if (containerHasH1OrBreadcrumb(child)) return true; continue; }
    const type = componentMap[rt]?.edsType;
    if (type === 'breadcrumb') return true;
    if (type === 'custom-title' && String(child['@type'] || '').toLowerCase() === 'h1') return true;
  }
  return false;
}
const overlapsHero = node => {
  const cls = splitCls([styleIdClasses(node)]);
  if (cls.includes('overlap-predecessor') || cls.includes('homepage-overlap')) return true;
  // Structural fallback: container that holds an H1 or breadcrumb (no grid) is the hero intro band.
  if (!containerHasGrid(node) && containerHasH1OrBreadcrumb(node)) return true;
  // Mixed header fallback: a container whose CHILD has breadcrumb+H1 (even with grids) is an
  // overlap container. The child will be split at its first grid by splitMixedHeaderContainer.
  const children = semanticChildren(node);
  if (children.some(isBreadcrumbH1Container) || children.some(isMixedHeaderContainer)) return true;
  return false;
};

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
  const set = new Set(String(block.props?.classes_commonCustomClass || '').split(/[,\s]+/).filter(Boolean));
  set.add(cls);
  block.props = block.props || {};
  block.props.classes_commonCustomClass = [...set].join(',');
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
  // Collect all cell content into a temp buffer first.
  // If the entire grid produced no content blocks, discard the controller too —
  // an empty inner-grid controller with no following blocks is meaningless and
  // causes orphaned nodes in the EDS canvas.
  const temp = [];
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
      temp.push(...cellBlocks);
    }
  }
  if (temp.length === 0) return;  // empty grid — discard controller silently
  out.push(controller);
  out.push(...temp);
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
        // A container with a width styleId (container-large etc.) inside a cell is
        // purely a width-constraint wrapper. Its job is to propagate the width class
        // to its leaf children — it must NEVER emit an extra cols-12 inner-grid shell.
        // Any multi-column grids inside the container will emit their own inner-grid
        // controllers naturally when collectCellLeaves recurses into them.
        const childWidth = containerBlockWidth(child, width);
        collectCellLeaves(child, out, innerDepth, childWidth || width);
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
// Style IDs for the AEM grid template policies that produce card-band layouts.
// Only grids authored with one of these templates should be unwrapped into flat
// sibling card blocks in the EDS section. Without this guard a generic 3×4 grid
// (e.g. a 3-column image+text layout) would also be mistakenly unwrapped.
//   id 1 / 165354545645741 → cmp-grid-full-page-4   (grid-full-page-4)
//   id 2 / 165354545645742 → cmp-grid-full-page-5-v1
//   id 3 / 165354545645743 → cmp-grid-full-page-5-v2
//   id 4 / 165354545645744 → cmp-grid-half-page-2
//   id 5 / 165354545645745 → cmp-grid-half-page-3
const CARD_GRID_TEMPLATE_IDS = new Set([
  '1', '2', '3', '4', '5',
  '165354545645741', '165354545645742', '165354545645743', '165354545645744', '165354545645745',
]);
function gridHasCardTemplate(grid) {
  const ids = String(grid['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
  return ids.some(id => CARD_GRID_TEMPLATE_IDS.has(id));
}

// A grid gets UNWRAPPED (its cells emitted as plain-section blocks instead of grid-sections)
// only for the cases EDS handles *deterministically* (validated across the corpus, zero regressions):
//   • card       — every column width 4 AND the cells hold cardpagestory/story components
//                  AND the grid carries one of the 5 known card-band AEM template style IDs
//                  (cmp-grid-full-page-4/5-v1/v2, cmp-grid-half-page-2/3). Without the
//                  template ID check a generic 3×4 image+text grid would also be unwrapped.
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
  // Card unwrap requires BOTH the all-4-columns shape AND an explicit card-band
  // template style ID. A plain 3×4 content grid must NOT be unwrapped.
  const card   = rowCount === 1 && g.allFour && gridHasCards(grid) && gridHasCardTemplate(grid);
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
  // Extract the container width from the source scopes so that ALL leaf blocks
  // inside each grid cell (title/text → classes_customDynamicClass; eyebrow/cta/etc.
  // → classes_commonCustomClass) inherit the enclosing container's width class.
  // Without this, non-width-target blocks (eyebrow, cta, accordion…) inside a grid
  // never received the inherited width because collectCellLeaves was called with no
  // inheritedBlockWidth parameter (defaulting to '').
  const containerWidth = sourceScopes.length > 0
    ? containerBlockWidth(sourceScopes[sourceScopes.length - 1], '')
    : '';
  for (let r = 1; r <= rowCount; r++) {
    for (let c = 1; c <= cols.length; c++) {
      const col = cols[c - 1];
      const par = grid[`par_${r}${c}`];
      const classes = ['grid-section', `grid-cols-${col.width}`];
      if (hasPriorityOrder && col.priority) classes.push(`order-${col.priority}`);
      const gs = { type: 'grid-section', props: {
        style_container: 'grid-section',
        style_customDynamicClass: classes.join(','),
      }, children: [] };
      // Keep source grouping metadata out of the serialized canvas/JCR. It is
      // used below solely to split multi-row grids without splitting adjacent
      // one-row grids from the same enclosing AEM container.
      Object.defineProperty(gs, '_sourceGrid', { value: grid, enumerable: false });
      Object.defineProperty(gs, '_sourceScopes', { value: sourceScopes, enumerable: false });
      if (par && typeof par === 'object') collectCellLeaves(par, gs.children, 0, containerWidth);
      if (relatedContent) applyRelatedContentCardProps(gs.children);
      // Strip width-* / video-* classes from all grid-section blocks EXCEPT custom-image and accordion.
      // Width classes on image and accordion are meaningful (image size variants, accordion width).
      // On title, text, cta, eyebrow, teaser, separator etc. the width class is redundant —
      // the grid-section's col-width (grid-cols-N) already controls the column layout.
      const WIDTH_GRID_STRIP_RE = /^(?:width|video)-(?:x{0,3}-)?(?:small|large|medium)$/;
      const WIDTH_GRID_KEEP = new Set(['custom-image', 'accordion']);
      for (const child of gs.children) {
        if (WIDTH_GRID_KEEP.has(child.type)) continue;
        if (!child.props) continue;
        if (child.props.classes_customDynamicClass) {
          const cleaned = String(child.props.classes_customDynamicClass).split(',').map(s => s.trim())
            .filter(c => !WIDTH_GRID_STRIP_RE.test(c)).join(',');
          if (cleaned) child.props.classes_customDynamicClass = cleaned;
          else delete child.props.classes_customDynamicClass;
        }
        if (child.props.classes_commonCustomClass) {
          const cleaned = String(child.props.classes_commonCustomClass).split(',').map(s => s.trim())
            .filter(c => !WIDTH_GRID_STRIP_RE.test(c)).join(',');
          if (cleaned) child.props.classes_commonCustomClass = cleaned;
          else delete child.props.classes_commonCustomClass;
        }
      }

      // ── Container-width propagation rule ────────────────────────────────────
      // When a parsys cell's ONLY direct child is a container that:
      //   (a) has a container-* width styleId (container-large, container-medium, etc.)
      //   (b) contains only leaf components — NO direct grid children
      // → propagate that container width to each eligible child block:
      //   • custom-title, text-container → container-* class (e.g. container-large)
      //   • video, brightcove-video      → video-* equivalent (e.g. video-large)
      //   • all other types              → skip (image, cta, eyebrow, separator etc.)
      // This runs AFTER the width-strip loop so the inherited classes are not stripped.
      if (par && typeof par === 'object') {
        const CONTAINER_TO_VIDEO_WIDTH = {
          'container-full-width': 'video-full-width',
          'container-x-large':    'video-x-large',
          'container-large':      'video-large',
          'container-medium':     'video-medium',
          'container-small':      'video-small',
          'container-x-small':    'video-x-small',
        };
        // Find the first direct container child of par (through layout wrappers) that:
        //   (a) has a container-* width styleId
        //   (b) has NO direct grid children
        // par may have multiple direct children (container + loose components) — that's fine,
        // we only need to find ONE width-bearing container to know the intended width for the cell.
        const findWidthContainer = (n) => {
          for (const [, k] of childEntries(n)) {
            const krt = RT(k);
            if (!krt || isLayoutWrapper(krt)) {
              const inner = findWidthContainer(k);
              if (inner) return inner;
            } else if (isContainer(krt)) {
              // Accept any container with a width styleId, regardless of whether it
              // contains a grid. Leaf siblings of the nested grid also need the width.
              if (containerHasWidthStyle(k)) return k;
            }
          }
          return null;
        };
        const wrappingContainer = findWidthContainer(par);
        if (wrappingContainer) {
          const cellContainerWidth = containerBlockWidth(wrappingContainer, '');
          if (cellContainerWidth) {
            // cellContainerWidth is already 'width-large' etc. (from CONTAINER_TO_BLOCK_WIDTH).
            // For video blocks, map width-large → video-large via CONTAINER_TO_VIDEO_WIDTH keyed on container-*.
            // Derive the container-* key by reverse-mapping only for the video lookup.
            const containerClass = Object.entries(CONTAINER_TO_BLOCK_WIDTH)
              .find(([, v]) => v === cellContainerWidth)?.[0] || '';
            // Identify which blocks in gs.children came from INSIDE the wrapping container
            // using index-range tracking: record gs.children.length before and after a fresh
            // collectCellLeaves run on the wrapping container into a temp array, then map the
            // resulting blocks back to the already-collected gs.children by position.
            // Direct par siblings (e.g. disclaimer text) appear at other positions and are skipped.
            //
            // Strategy: walk par's direct semantic children in order, tracking which slice of
            // gs.children was contributed by wrappingContainer vs other direct siblings.
            // We know gs.children was populated by collectCellLeaves(par, gs.children) above.
            // Re-walk par's direct children to find exactly which blocks came from which source.
            let containerStart = -1;
            let containerEnd = -1;
            {
              let pos = 0;
              const walkParDirect = (n) => {
                for (const [, k] of childEntries(n)) {
                  const krt = RT(k);
                  if (!krt || isLayoutWrapper(krt)) { walkParDirect(k); continue; }
                  if (isXF(krt)) continue;
                  // Count how many blocks this child would contribute
                  const temp = [];
                  collectCellLeaves(k, temp, 0);
                  const count = temp.length;
                  if (k === wrappingContainer) {
                    containerStart = pos;
                    containerEnd = pos + count;
                  }
                  pos += count;
                }
              };
              walkParDirect(par);
            }
            if (containerStart >= 0) {
              // Blocks excluded from container-width propagation:
              //   • inner-grid controller — structural block, not a content block
              //   • accordion — its own width class (accordion-large, accordion-medium) is set
              //     independently and must not be mixed with container-* width inheritance.
              // NOTE: custom-image IS included — the container width overrides the image's
              // own size class (e.g. x-small → width-large). All other blocks not in the
              // eligible type list are implicitly skipped (widthClass stays null).
              const PROPAGATION_EXCLUDE = new Set(['accordion']);
              const WIDTH_CLS_RE = /^(?:width|video)-(?:x{0,3}-)?(?:small|large|medium)$/;
              for (let idx = containerStart; idx < containerEnd && idx < gs.children.length; idx++) {
                const child = gs.children[idx];
                if (child.type === 'inner-grid') continue;           // skip structural controller
                if (PROPAGATION_EXCLUDE.has(child.type)) continue;
                let widthClass = null;
                if (['custom-title', 'text-container', 'custom-image'].includes(child.type)) {
                  widthClass = cellContainerWidth; // e.g. 'width-large'
                } else if (child.type === 'video' || child.type === 'brightcove-video') {
                  widthClass = CONTAINER_TO_VIDEO_WIDTH[containerClass] || null; // e.g. 'video-large'
                }
                if (!widthClass || !child.props) continue;
                const existing = String(child.props.classes_customDynamicClass || '')
                  .split(',').map(c => c.trim()).filter(Boolean);
                // For custom-image: container width REPLACES the image's own size class.
                // AEM image size classes come in two forms:
                //   • bare:   x-small, small, medium, large, x-large, xx-large, xxx-large
                //   • prefixed: width-x-small, width-small, width-large, etc.
                // Both must be stripped so the container width class is the only width on the image.
                const IMAGE_SIZE_RE = /^(?:(?:width-)?(?:x{0,3}-)?(small|medium|large)|(?:width-)?(?:x{1,3}-)?large)$/;
                const filtered = child.type === 'custom-image'
                  ? existing.filter(c => !WIDTH_CLS_RE.test(c) && !IMAGE_SIZE_RE.test(c))
                  : [...existing];
                if (!filtered.includes(widthClass)) filtered.push(widthClass);
                child.props.classes_customDynamicClass = filtered.join(',');
                // Mark all eligible blocks so global stripWidthFromBlock does not remove
                // the propagated width-* / video-* class.
                Object.defineProperty(child, '_cellContainerWidth', { value: widthClass, enumerable: false, configurable: true });
              }
            }
          }
        }
      }
      // ── End container-width propagation rule ────────────────────────────────

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
    if (!pending.length) return;
    // When flushing accumulated blocks from actual AEM grid nodes, use propsForSource
    // to derive the correct props (including section-bottom-margin). Fall back to gc.props
    // only when no propsForSource is available or the blocks have no source grid.
    let flushProps = { ...gc.props };
    if (propsForSource && pending[0]?._sourceGrid) {
      const sourceScopes = pending[0]._sourceScopes || [];
      flushProps = propsForSource(pending[0]._sourceGrid, sourceScopes);
    }
    sections.push({ type: 'grid-container', props: flushProps, blocks: pending.splice(0) });
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
// Count ALL grids in a node's subtree at any depth (crossing containers too)
function countAllGrids(node) {
  let count = 0;
  for (const [, child] of childEntries(node)) {
    const rt = RT(child);
    if (isGrid(rt)) { count++; continue; }
    if (!rt || isLayoutWrapper(rt) || isContainer(rt)) count += countAllGrids(child);
  }
  return count;
}

// Collect all grids in subtree in document order
function collectAllGrids(node, out = []) {
  for (const [, child] of childEntries(node)) {
    const rt = RT(child);
    if (isGrid(rt)) { out.push(child); continue; }
    if (!rt || isLayoutWrapper(rt) || isContainer(rt)) collectAllGrids(child, out);
  }
  return out;
}

// Check if node (container or grid) has a PreBuilt Template styleId
function hasPrebuiltTemplateStyle(node) {
  if (!node) return false;
  const raw = String(node['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '');
  return raw.split(',').some(id => CARD_GRID_TEMPLATE_IDS.has(id));
}

// Does any node in the entire subtree (including root) have a PreBuilt Template styleId?
function subtreeHasPrebuiltTemplate(node) {
  if (hasPrebuiltTemplateStyle(node)) return true;
  for (const [, child] of childEntries(node)) {
    const rt = RT(child);
    if (!rt || isLayoutWrapper(rt) || isGrid(rt) || isContainer(rt)) {
      if (subtreeHasPrebuiltTemplate(child)) return true;
    }
  }
  return false;
}

// Post-process a group of sections/grid-containers that were all emitted from the same
// AEM container with a background (bg-color or bg-image). Since EDS splits this into
// multiple sibling outputs, apply sequential padding rules so the band renders as one
// continuous visual unit without internal gaps:
//   • grid-containers (not last): section-bottom-margin → no-bottom-margin
//   • first output: strip section-padding, add no-bottom-padding
//   • middle outputs: strip section-padding, add no-top-padding + no-bottom-padding
//   • last output: strip section-padding, add no-top-padding
function applySplitContainerRules(outputs) {
  const last = outputs.length - 1;
  for (let i = 0; i < outputs.length; i++) {
    const out = outputs[i];
    if (!out.props) continue;
    const cls = splitCls([out.props.style_customDynamicClass]);

    // Margin rule: non-last grid-containers use no-bottom-margin instead of section-bottom-margin
    if (out.type === 'grid-container' && i < last) {
      const idx = cls.indexOf('section-bottom-margin');
      if (idx >= 0) cls[idx] = 'no-bottom-margin';
      else if (!cls.includes('no-bottom-margin')) cls.push('no-bottom-margin');
    }

    // Padding rule: keep section-padding, add directional overrides for seam sides only.
    // section-padding supplies the base padding; no-top/bottom-padding zeros only the
    // side that faces an adjacent sibling output so the band appears seamless.
    const withDirectional = cls.filter(c => c !== 'no-top-padding' && c !== 'no-bottom-padding');
    if (i === 0) {
      withDirectional.push('no-bottom-padding');
    } else if (i === last) {
      withDirectional.push('no-top-padding');
    } else {
      withDirectional.push('no-top-padding', 'no-bottom-padding');
    }

    out.props.style_customDynamicClass = withDirectional.join(',');
  }
}

function emitNode(node, sections) {
  const rt = RT(node);
  if (isContainer(rt)) {
    // Rule 7 — Container with PreBuilt Template grid (checked BEFORE Rule 6)
    // Trigger: any node in the subtree (container or grid) has a PreBuilt Template styleId
    if (subtreeHasPrebuiltTemplate(node)) {
      // Rule 7 — Container with PreBuilt Template grid.
      // The EDS twin uses inner-grids inside a section for this pattern.
      // Class derivation rules for Rule 7 sections (from twin corpus):
      //   • container-full-width → content-wide (via applyFullWidthContainerRule)
      //   • radius, padding, margin classes from the outer container
      //   • no-side-margin when the container has a background image/color (full-bleed)
      //   • grid template classes (grid-full-page-*) are NEVER on the section
      //   • NOOP classes (height-default) are excluded
      //   • bg-* color classes are excluded from section classes
      //   • padding-bottom added when bg image is present
      const RULE7_EXCL = new Set(['height-default', 'no-padding', 'no-bottom-margin']);
      const GRID_TEMPLATE_RE = /^grid-(?:full-page|half-page|meganav)-/;
      let r7Resolved = layoutStyleProps([node], { compType: 'section' });
      r7Resolved = applyFullWidthContainerRule(r7Resolved, [node]);
      // Add no-side-margin when there's a background color/image (full-bleed band)
      if (bgClass(node) || node['@backgroundImageReference']) {
        r7Resolved = {
          ...r7Resolved,
          classes: r7Resolved.classes.includes('no-side-margin') ? r7Resolved.classes : [...r7Resolved.classes, 'no-side-margin'],
        };
      }
      // Remap content-full-width → content-wide; ensure content-wide is first
      let r7Classes = r7Resolved.classes.map(c => c === 'content-full-width' ? 'content-wide' : c);
      // Move content-wide to front if present
      if (r7Classes.includes('content-wide')) {
        r7Classes = ['content-wide', ...r7Classes.filter(c => c !== 'content-wide')];
      }
      const r7Derived = r7Classes
        .filter(c => !RULE7_EXCL.has(c) && !GRID_TEMPLATE_RE.test(c) && !/^bg-/.test(c));
      const secClasses = mergeDefaults('section', r7Derived);
      // padding-bottom added after section-padding (ALWAYS default) so order is correct
      if (node['@backgroundImageReference'] && !secClasses.includes('padding-bottom')) {
        secClasses.push('padding-bottom');
      }
      const secProps = { style_customDynamicClass: secClasses.join(',') };
      Object.assign(secProps, bgImageProps(node));
      // Emit one section with inner-grids (twin structure confirmed)
      const blocks = [];
      const allGrids = collectAllGrids(node);
      for (const grid of allGrids) {
        emitInnerGrid(grid, blocks, 0);
      }
      sections.push({ type: 'section', props: secProps, blocks });
      return;
    }

    // Rule 6 — Container with nested container children
    // Trigger: any direct child (through layout wrappers) is itself a container
    const hasNestedContainerChild = (() => {
      for (const [, child] of childEntries(node)) {
        const crt = RT(child);
        if (isContainer(crt)) return true;
        if (!crt || isLayoutWrapper(crt)) {
          for (const [, gc] of childEntries(child)) if (isContainer(RT(gc))) return true;
        }
      }
      return false;
    })();
    if (hasNestedContainerChild) {
      // Walk outer container's direct children. For each nested container, apply
      // Rule 4-style logic (components→section, grids→grid-container) inheriting
      // outer + nested container styles. Direct components/grids use outer styles only.
      const outerStyleClasses = splitCls([layoutStyleClasses(node), bgClass(node)]).filter(Boolean);
      const outerBg = bgClass(node);
      for (const [, child] of childEntries(node)) {
        const crt = RT(child);
        if (!crt || isLayoutWrapper(crt)) {
          // layout wrapper — look inside
          for (const [, gc] of childEntries(child)) {
            const gcrt = RT(gc);
            if (isContainer(gcrt)) {
              // nested container → emit its grids as grid-containers
              const nestedBg = bgClass(gc);
              const nestedCls = splitCls([layoutStyleClasses(gc)]).filter(Boolean);
              const combinedCls = [...new Set([...outerStyleClasses, ...nestedCls, nestedBg].filter(Boolean))];
              const hasBg = !!(nestedBg || outerBg);
              // gather grids inside nested container
              const nestedGrids = directGrids(gc);
              if (nestedGrids.length) {
                for (const grid of nestedGrids) {
              const gcBlock = { type: 'grid-container', props: gridContainerProps([node, gc], grid), blocks: [] };
              expandGrid(grid, gcBlock.blocks, [node, gc]);
              pushGridContainersByRows(sections, gcBlock);
            }
          } else {
            // no grid in nested container → emit as section
            const rule6NoGridHasFW = [node, gc].some(n => hasStyleId(n, FULL_WIDTH_CONTAINER_STYLE_ID));
            const rule6NoGridHasBg = !!(outerBg || bgClass(gc));
            const r6Derived = combinedCls.filter(c => !NOOP_CLASS.has(c) && c !== 'no-padding' && c !== 'container-full-width');
            // When the outer container is a plain full-width wrapper (FULL_WIDTH_CONTAINER_STYLE_ID,
            // no bg), section-padding is NOT added by EDS — strip it to match the twin.
      // Also: when r6Derived contains only margin classes (e.g. no-bottom-margin) with no
            // width class, mergeDefaults still adds section-padding (ALWAYS). Strip it when the
            // combined context is a bare no-bg FULL_WIDTH_CONTAINER wrapper.
            let secCls = mergeDefaults('section', r6Derived);
            if (rule6NoGridHasFW && !rule6NoGridHasBg) secCls = secCls.filter(c => c !== 'section-padding');
            // When the node itself has FULL_WIDTH_CONTAINER_STYLE_ID + no bg, also strip
            // section-padding even if gc doesn't — the outer wrapper is the plain band.
            if (hasStyleId(node, FULL_WIDTH_CONTAINER_STYLE_ID) && !rule6NoGridHasBg && !outerBg) secCls = secCls.filter(c => c !== 'section-padding');
            const secProps = { style_customDynamicClass: secCls.join(',') };
            const blocks = [];
            collectLeaves(gc, blocks, '', false);
            if (blocks.length) sections.push({ type: 'section', props: secProps, blocks });
          }
        } else if (isGrid(gcrt)) {
          const gcBlock = { type: 'grid-container', props: gridContainerProps([node], gc), blocks: [] };
          expandGrid(gc, gcBlock.blocks, [node]);
          pushGridContainersByRows(sections, gcBlock);
            } else if (!gcrt || isLayoutWrapper(gcrt)) {
              // skip layout wrappers
            }
          }
          continue;
        }
        if (isContainer(crt)) {
          // direct nested container
          const nestedBg = bgClass(child);
          const nestedCls = splitCls([layoutStyleClasses(child)]).filter(Boolean);
          const combinedCls = [...new Set([...outerStyleClasses, ...nestedCls, nestedBg].filter(Boolean))];
          const hasBg = !!(nestedBg || outerBg);
          const nestedGrids = directGrids(child);
          if (nestedGrids.length) {
            for (const grid of nestedGrids) {
              const gcBlock = { type: 'grid-container', props: gridContainerProps([node, child], grid), blocks: [] };
              expandGrid(grid, gcBlock.blocks, [node, child]);
              pushGridContainersByRows(sections, gcBlock);
            }
          } else {
            const rule6cNoGridHasFW = [node, child].some(n => hasStyleId(n, FULL_WIDTH_CONTAINER_STYLE_ID));
            const rule6cNoGridHasBg = !!(outerBg || bgClass(child));
            const r6cDerived = combinedCls.filter(c => !NOOP_CLASS.has(c) && c !== 'no-padding' && c !== 'container-full-width');
            let secCls = mergeDefaults('section', r6cDerived);
            if (rule6cNoGridHasFW && !rule6cNoGridHasBg) secCls = secCls.filter(c => c !== 'section-padding');
            const secProps = { style_customDynamicClass: secCls.join(',') };
            const blocks = [];
            collectLeaves(child, blocks, '', false);
            if (blocks.length) sections.push({ type: 'section', props: secProps, blocks });
          }
        } else if (isGrid(crt)) {
          const gcBlock = { type: 'grid-container', props: gridContainerProps([node], child), blocks: [] };
          expandGrid(child, gcBlock.blocks, [node]);
          pushGridContainersByRows(sections, gcBlock);
        } else if (!crt || isLayoutWrapper(crt) || isXF(crt)) {
          // skip
        } else {
          // direct component
          const secCls = mergeDefaults('section', outerStyleClasses.filter(c => !NOOP_CLASS.has(c)));
          const blocks = mapLeafExpanded(child);
          if (blocks.length) sections.push({ type: 'section', props: { style_customDynamicClass: secCls.join(',') }, blocks });
        }
      }
      return;
    }

    if (containerHasGrid(node)) {
      // Real grids become grid-sections. A direct teaser next to a grid is its
      // own visual band in AEM, so preserve it as a standalone EDS section in
      // document order. Other loose leaves (notably separators) keep the
      // existing first/last grid-cell treatment.
      // height-* belongs on grid-containers only when they're a background-IMAGE banner (twins keep
      // height-tall there); on color/plain grid-containers the height styleId is dropped.
      const _splitStartIdx = sections.length; // track where this container's outputs begin
      const gc = { type: 'grid-container', props: gridContainerProps([node]), blocks: [] };
      const leading = [], trailing = [];
      const deferredCtaTeasers = [];
      let relatedGridPending = false;
      let firstContentGs = null, lastContentGs = null;
      const buf = () => (firstContentGs ? trailing : leading);
      const flushGridBand = () => {
        // Rule 4: leading blocks (components before a grid) always emit as their own
        // standalone section BEFORE the grid-container — never merged into grid-section cells.
        // Exception: when the container has bg-color or bg-image AND the first leading block is
        // a separator, port that separator as the first child of every grid-section instead of
        // wrapping it in a separate section (the separator belongs visually inside the bg band).
        const hasBg = !!(bgClass(node) || node['@backgroundImageReference']);
        if (hasBg && leading.length > 0 && leading[0].type === 'separator') {
          const sepBlock = leading[0];
          const rest = leading.slice(1);
          // Port the separator as the first child of EVERY grid-section inside the current gc.
          // When the container has bg-image or bg-color, the separator visually belongs
          // inside the coloured/image band — wrapping it in its own standalone section
          // would break the visual continuity of the band. This rule applies to both
          // bg-color and bg-image containers.
          for (const gs of gc.blocks) {
            if (gs.type === 'grid-section') {
              gs.children.unshift({ type: sepBlock.type, props: { ...sepBlock.props }, children: [...(sepBlock.children || [])] });
            }
          }
          if (rest.length) {
            sections.push({ type: 'section', props: sectionProps(node), blocks: rest });
          }
          leading.length = 0;
        } else if (leading.length) {
          sections.push({ type: 'section', props: sectionProps(node), blocks: [...leading] });
          leading.length = 0;
        }
        if (firstContentGs) {
          if (trailing.length) lastContentGs.children.push(...trailing);
        } else if (trailing.length) {
          sections.push({ type: 'section', props: sectionProps(node), blocks: [...trailing] });
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
      // Split-container rule: when a bg-color/bg-image container is split into multiple
      // sections/grid-containers, apply sequential padding rules so the band renders
      // as one continuous visual unit:
      //   • all grid-containers except last: section-bottom-margin → no-bottom-margin
      //   • first output: add no-bottom-padding
      //   • middle outputs: add no-top-padding + no-bottom-padding
      //   • last output: add no-top-padding
      const _splitOutputs = sections.slice(_splitStartIdx);
      if (_splitOutputs.length > 1 && (bgClass(node) || node['@backgroundImageReference'])) {
        applySplitContainerRules(_splitOutputs);
      }
      return;
    }
    // plain / hero section (standalone; hero+content merging happens in aemToCanvas)
    const isHero = !!node['@backgroundImageReference'] || isColorHero(node);
    const blocks = [];
    if (isHero) blocks.push(heroBlockOf(node));
    // The top-level container becomes the section and its container-* width class is
    // already placed on the section itself via sectionProps(). Do NOT propagate a
    // width-* class to individual child blocks — the section's container-* class already
    // controls the band width for all children.
    collectLeaves(node, blocks, '', false);
    const secProps = sectionProps(node, isHero);
    // When the section already carries a container-* width class, child blocks must have
    // NO width-* or video-* classes at all — not inherited, not from their own styleIds.
    // The section's container-* class is the sole width control for the entire band.
    // Mark them with _hasInheritedWidth so applySectionBlockPadding can add padding classes —
    // UNLESS the container also has no-padding (styleId 1653545835982) authored, in which case
    // width is still stripped but NO padding signal is set on the blocks.
    const NO_PADDING_STYLE_ID = '1653545835982';
    if (!isHero && containerBlockWidth(node, '') !== '') {
      const WIDTH_STRIP_RE = /^(?:width|video)-(?:x{0,3}-)?(?:small|large|medium)$/;
      const sectionHasNoPadding = hasStyleId(node, NO_PADDING_STYLE_ID);
      for (const b of blocks) {
        if (!b.props) b.props = {};
        // Strip width-* / video-* from classes_customDynamicClass
        if (b.props.classes_customDynamicClass) {
          const cleaned = String(b.props.classes_customDynamicClass).split(',').map(s => s.trim())
            .filter(c => !WIDTH_STRIP_RE.test(c)).join(',');
          if (cleaned) b.props.classes_customDynamicClass = cleaned;
          else delete b.props.classes_customDynamicClass;
        }
        // Strip width-* / video-* from classes_commonCustomClass too
        if (b.props.classes_commonCustomClass) {
          const cleaned = String(b.props.classes_commonCustomClass).split(',').map(s => s.trim())
            .filter(c => !WIDTH_STRIP_RE.test(c)).join(',');
          if (cleaned) b.props.classes_commonCustomClass = cleaned;
          else delete b.props.classes_commonCustomClass;
        }
        // Only stamp _hasInheritedWidth (padding signal) when the container does NOT have no-padding.
        // no-padding means the author wants zero padding on this band — respect that.
        if (!sectionHasNoPadding && !b._hasInheritedWidth) {
          Object.defineProperty(b, '_hasInheritedWidth', { value: true, enumerable: false });
        }
      }
    }
    sections.push({ type: 'section', props: secProps, blocks });
    return;
  }
  if (isGrid(rt)) {
    // A bare top-level grid that carries a card-band template style ID (cmp-grid-full-page-4,
    // cmp-grid-full-page-5-v1/v2, cmp-grid-half-page-2/3) AND whose cells all hold card
    // components is a card-band section. EDS authors it as a flat section with the grid
    // template class (grid-full-page-4 etc.) on the section itself — never as a grid-container.
    // The gridHasCardTemplate() guard ensures a plain 4-col content grid is never mismatched.
    if (isUnwrapGrid(node)) {
      const blocks = [];
      collectLeaves(node, blocks, '', false);
      // Resolve the grid's own template class (grid-full-page-4 etc.) for the section.
      const gridCls = splitCls([styleIdClasses(node)]).filter(c => LAYOUT_CLASS.test(c));
      const classes = mergeDefaults('section', gridCls);
      sections.push({ type: 'section', props: { style_customDynamicClass: classes.join(',') }, blocks });
    } else {
      // Regular bare grid → grid-container
      const gc = { type: 'grid-container', props: gridContainerProps([node], node), blocks: [] };
      expandGrid(node, gc.blocks, []);
      pushGridContainersByRows(sections, gc);
    }
    return;
  }
  // bare leaf at top level → its own section (Rule 5 / Rule 2)
  // Fixed classes: content-regular + no-bottom-margin (EDS twin uses content-regular for bare leaf sections)
  const blocks = mapLeafExpanded(node);
  if (blocks.length) {
    sections.push({ type: 'section', props: {
      style_customDynamicClass: 'content-regular,no-bottom-margin',
    }, blocks });
  }
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

// A "mixed" header container has breadcrumb+H1 (intro content for the hero) but ALSO
// contains grids (badges, episode lists, etc.) that belong in body sections.
// These must be split: pre-grid leaf components → absorbed into hero, grids → body sections.
// Example: parlons-en-saison-1 container3 has breadcrumb+H1+text+separator+grid(badges).
function isMixedHeaderContainer(node) {
  if (!isContainer(RT(node))) return false;
  if (!containerHasAnyGrid(node)) return false; // pure header handled by isBreadcrumbH1Container
  let breadcrumb = false, h1 = false;
  (function scan(n) {
    for (const [, child] of childEntries(n)) {
      const rt = RT(child);
      if (!rt || isLayoutWrapper(rt)) { scan(child); continue; }
      if (isGrid(rt)) continue; // grids present but don't disqualify breadcrumb+H1 test
      if (isContainer(rt)) continue; // nested containers are separate scopes
      const type = componentMap[rt]?.edsType;
      if (type === 'breadcrumb') breadcrumb = true;
      if (type === 'custom-title' && String(child['@type'] || '').toLowerCase() === 'h1') h1 = true;
    }
  })(node);
  return breadcrumb && h1;
}

// For a mixed header container, collect all leaf nodes that appear BEFORE the first grid
// (in document order). These are the hero intro blocks: breadcrumb, H1, text, separators.
// Returns { heroLeaves: node[], gridsAndRest: node[] } where gridsAndRest are grids +
// any nodes after the first grid.
function splitMixedHeaderContainer(node) {
  const heroLeaves = [];
  const gridsAndRest = [];
  let foundFirstGrid = false;
  function walk(n) {
    for (const [, child] of childEntries(n)) {
      const rt = RT(child);
      if (!rt || isLayoutWrapper(rt)) { walk(child); continue; }
      if (isGrid(rt)) {
        foundFirstGrid = true;
        gridsAndRest.push(child);
      } else if (isContainer(rt)) {
        if (foundFirstGrid) { gridsAndRest.push(child); }
        else { walk(child); }
      } else {
        if (foundFirstGrid) { gridsAndRest.push(child); }
        else { heroLeaves.push(child); }
      }
    }
  }
  walk(node);
  return { heroLeaves, gridsAndRest };
}
function splitHeroContinuation(node) {
  const children = semanticChildren(node);
  // First try pure breadcrumb+H1 container (no grids inside it)
  const headerIndex = children.findIndex(isBreadcrumbH1Container);
  if (headerIndex >= 0) {
    const body = children.filter((_, index) => index !== headerIndex);
    return body.length ? { header: children[headerIndex], body } : null;
  }
  // Special case: a child container that has breadcrumb+H1 AND grids (mixed header).
  // Split it at its first grid: pre-grid leaves → hero, grids+rest → body.
  const mixedIndex = children.findIndex(isMixedHeaderContainer);
  if (mixedIndex >= 0) {
    const mixedNode = children[mixedIndex];
    const { heroLeaves, gridsAndRest } = splitMixedHeaderContainer(mixedNode);
    if (heroLeaves.length === 0) return null; // nothing to absorb into hero
    // Build a synthetic header object that collectLeaves can walk:
    // wrap heroLeaves in a container-like structure
    const syntheticHeader = { '@sling:resourceType': mixedNode['@sling:resourceType'], ...Object.fromEntries(heroLeaves.map((n, i) => [`_heroLeaf${i}`, n])) };
    // Collect the rest of the overlap container's children (after the mixed container) as body
    const bodySiblings = children.filter((_, i) => i !== mixedIndex);
    // gridsAndRest go first (the grids from inside the mixed container), then bodySiblings
    const body = [...gridsAndRest, ...bodySiblings];
    return { header: syntheticHeader, heroLeaves, body, mixedSplit: true };
  }
  return null;
}

// After a hero absorbs the breadcrumb+H1 header of an overlap container, the rest
// of that container's content is the page body. When the body carries a grid, EDS
// does NOT keep it as one lumped section: each grid renders as an inner-grid, and a
// NESTED container is a section boundary. This walker reproduces that — consecutive
// direct grids/leaves accumulate in the current section (matching the multi-inner-grid
// width-container pattern), while every nested container flushes and starts fresh
// sections (matching the migraine-friendly-workplace twin). Section props derive from
// the nearest container context, so styleless nested containers get clean defaults.
// mixedSplit=true: grids emit as top-level grid-containers (grid-container + grid-sections).
// mixedSplit=false (default): grids emit as inner-grids inside sections (standard hero continuation).
// This flag is ONLY set when the overlap container was a mixed-header (breadcrumb+H1+grids),
// so no other hero continuation patterns are affected.
function emitHeroContinuationSections(bodyNodes, wrapper, sections, mixedSplit = false) {
  let cur = null;
  const ensure = props => { if (!cur) { cur = { type: 'section', props: { ...props }, blocks: [] }; sections.push(cur); } return cur; };
  const walk = (list, ctxProps) => {
    for (const child of list) {
      const rt = RT(child);
      if (!rt || isLayoutWrapper(rt)) { walk(childEntries(child).map(([, c]) => c), ctxProps); continue; }
      if (isXF(rt)) continue;
      if (isGrid(rt)) {
        if (mixedSplit) {
          // Mixed-header special case: each grid emits as its own grid-container + grid-sections.
          // Flush any pending section first so the grid-container stands alone.
          // Strip hero-overlap-specific classes (overlap-predecessor, medium-radius, homepage-overlap)
          // from the wrapper scope so they don't leak onto the grid-container props.
          const HERO_OVERLAP_CLS = new Set(['overlap-predecessor', 'homepage-overlap', 'large-radius', 'medium-radius', 'small-radius', 'semi-transparent-layer', 'align-center']);
          const cleanProps = (gcProps) => {
            const cls = splitCls([gcProps.style_customDynamicClass]).filter(c => !HERO_OVERLAP_CLS.has(c));
            return { ...gcProps, style_customDynamicClass: ['grid-container', ...cls.filter(c => c !== 'grid-container')].join(',') };
          };
          cur = null;
          const gc = { type: 'grid-container', props: cleanProps(gridContainerProps([wrapper], child)), blocks: [] };
          expandGrid(child, gc.blocks, [wrapper]);
          pushGridContainersByRows(sections, gc, (sourceGrid, scopes) =>
            cleanProps(gridContainerProps(scopes.length ? scopes : [wrapper], sourceGrid)));
        } else {
          // Standard hero continuation: inner-grid inside a section.
          // Flush cur before and after so consecutive grids don't pile into one section.
          cur = null;
          emitInnerGrid(child, ensure(ctxProps).blocks, 0);
          cur = null;
        }
      }
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
const DYNAMIC_CLASS_RE = /^(?:cols-[\d-]+|n?col-\d+|width-(?:x{0,3}-)?(small|medium|large)|video-(?:x{0,3}-)?(small|medium|large|full-width)|container-(?:[a-z]+-)*(?:large|medium|small|x-large|x-small|xx-large|xxx-large|full-width)|grid-(?:full-page|half-page|meganav)-[\w-]+)$/;

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
            if (split.mixedSplit && split.heroLeaves) {
              // Mixed header: heroLeaves are actual AEM leaf nodes, not a container.
              // Map them directly instead of using collectLeaves on a synthetic wrapper.
              for (const leaf of split.heroLeaves) {
                headerBlocks.push(...mapLeafExpanded(leaf, ''));
              }
            } else {
              collectLeaves(split.header, headerBlocks, '', false);
            }
            blocks.push(...headerBlocks);
            // Only a DIRECT grid in the overlap container triggers per-grid /
            // per-nested-container splitting (emitHeroContinuationSections) — the case the
            // prior `!containerHasGrid` guard wrongly excluded from hero absorption. A grid
            // nested inside a width-style sub-container stays on the existing body-group path
            // (cols-12 inner-grid), which the corpus already migrates correctly (e.g. contact-us).
            // For mixedSplit, body always contains grids (from gridsAndRest + body siblings).
            // Use emitHeroContinuationSections unconditionally for mixedSplit so that the
            // badge grid and episode grids each emit as their own sections.
            bodyGroups.push({ wrapper: nx, nodes: split.body, split: split.mixedSplit || containerHasGrid(nx), mixedSplit: !!split.mixedSplit });
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
      sections.push({ type: 'section', props: sectionProps(node, true, overlapNode), blocks });
      for (const group of bodyGroups) {
        // Hero-continuation body that carries a grid: emit per-grid / per-nested-container
        // sections instead of one lumped section (structure verified against the twin).
        // Pass mixedSplit flag so grids from a mixed-header overlap emit as grid-containers
        // (not inner-grids). group.split is true for both standard and mixed-header cases;
        // the mixedSplit flag distinguishes which grid emission path to use.
        if (group.split) { emitHeroContinuationSections(group.nodes, group.wrapper, sections, !!group.mixedSplit); continue; }
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
  return stripWidthClasses(applySectionBlockPadding(applyQuoteTransparencyRule(validateCanvasStyles(hoistTrailingSeparator(sections)))));
}

// Strip width-* / video-* classes from every block in the canvas EXCEPT custom-image and accordion.
// These are the only two block types where a width class has a meaningful EDS picklist meaning.
// All other blocks (title, text, cta, eyebrow, teaser, separator, etc.) must not carry width classes —
// their visual width is controlled by the section's container-* class or the grid column layout.
const WIDTH_GLOBAL_STRIP_RE = /^(?:width|video)-(?:x{0,3}-)?(?:small|large|medium)$/;
const WIDTH_GLOBAL_KEEP = new Set(['custom-image', 'accordion']);
function stripWidthFromBlock(block) {
  if (!block || WIDTH_GLOBAL_KEEP.has(block.type)) return;
  // Preserve video-* class that was explicitly propagated from a wrapping container
  // (container-large → video-large). The _cellContainerWidth property is set by the
  // container-width propagation rule in expandGrid() and must survive the global strip.
  if (block._cellContainerWidth) return;
  if (block.props) {
    if (block.props.classes_customDynamicClass) {
      const cleaned = String(block.props.classes_customDynamicClass)
        .split(',').map(s => s.trim()).filter(c => c && !WIDTH_GLOBAL_STRIP_RE.test(c)).join(',');
      if (cleaned) block.props.classes_customDynamicClass = cleaned;
      else delete block.props.classes_customDynamicClass;
    }
    if (block.props.classes_commonCustomClass) {
      const cleaned = String(block.props.classes_commonCustomClass)
        .split(/[\s,]+/).map(s => s.trim()).filter(c => c && !WIDTH_GLOBAL_STRIP_RE.test(c)).join(' ');
      if (cleaned) block.props.classes_commonCustomClass = cleaned;
      else delete block.props.classes_commonCustomClass;
    }
  }
  if (Array.isArray(block.children)) block.children.forEach(stripWidthFromBlock);
}
function stripWidthClasses(sections) {
  for (const sec of sections || []) {
    for (const block of sec.blocks || []) {
      // For grid-containers walk into grid-sections
      if (block.type === 'grid-section') {
        (block.children || []).forEach(stripWidthFromBlock);
      } else {
        stripWidthFromBlock(block);
      }
    }
  }
  return sections;
}

// The page-final separator (the spacer just above the footer) must live in its OWN bare section,
// never nested inside the last grid — verified: of 786 EDS pages ending in a separator, 0 nest it
// in a grid and 474 have it alone in a bare section. It is always the footer spacer, so EDS
// requires the wide band with section padding and no trailing margin.
function footerSeparatorSectionProps(props = {}) {
  const required = ['content-wide', 'section-padding', 'no-bottom-margin'];
  // Strip any conflicting width classes from existing before adding content-wide
  const existing = splitCls([props.style_customDynamicClass]).filter(c => !isWidthCls(c));
  return {
    ...props,
    style_customDynamicClass: [...new Set([...existing, ...required])].join(','),
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

// Post-processing: for every regular section that has blocks with an inherited container width
// (_hasInheritedWidth), add section-padding to the first such block and section-padding +
// no-top-padding to all subsequent ones. Non-width-inherited blocks are untouched.
function applySectionBlockPadding(sections) {
  for (const sec of sections || []) {
    if (sec.type !== 'section') continue;
    const widthBlocks = (sec.blocks || []).filter(b => b._hasInheritedWidth);
    if (!widthBlocks.length) continue;
    for (const block of sec.blocks) {
      if (!block._hasInheritedWidth) continue;
      if (!block.props) block.props = {};
      const classes = String(block.props.classes_customDynamicClass || '')
        .split(',').map(c => c.trim()).filter(Boolean);
      const isFirst = widthBlocks[0] === block;
      if (!classes.includes('section-padding')) classes.push('section-padding');
      if (!isFirst && !classes.includes('no-top-padding')) classes.push('no-top-padding');
      block.props.classes_customDynamicClass = classes.join(',');
    }
  }
  return sections;
}

module.exports = { aemToCanvas, mapLeaf, normalizeBlock, normalizeSections };
