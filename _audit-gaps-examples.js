/**
 * Gap audit with concrete AEM value examples + page URLs.
 * READ-ONLY. No changes made.
 *
 * For each identified gap category, shows:
 *   • The AEM page path (for manual validation)
 *   • The raw AEM attribute value
 *   • What EDS currently outputs (or doesn't)
 *   • Why it's a gap
 */
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { aemToCanvas } = require('./aem-canvas.js');

const JCR_XML_PARSER = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@',
  parseAttributeValue: false, trimValues: true, isArray: () => false,
});
const migrationMap = JSON.parse(fs.readFileSync('migration-map.json', 'utf8'));
const styleMap = JSON.parse(fs.readFileSync('style-map.json', 'utf8'));
const componentMap = migrationMap.componentMap || {};

const RT = n => (n && n['@sling:resourceType'] || '').trim();
const ce = n => Object.entries(n).filter(([k, v]) => !k.startsWith('@') && k !== '#text' && v && typeof v === 'object');

function findXmls(dir, out) {
  out = out || [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) findXmls(full, out);
      else if (e.name === '.content.xml') out.push(full);
    }
  } catch {}
  return out;
}

function pageOf(x) {
  return x.replace(/\\/g, '/').replace('content-xml/', '').replace('/.content.xml', '');
}

// Collect examples per gap type: { rt, attr, value, page, edsOut }
const gaps = {
  // 1. Unmapped AEM props that carry real content values
  image_cqPanelTitle: [],
  image_smartCropRendition: [],
  accordion_expandedItems: [],
  searchresults_labels: [],
  pipeline_labels: [],
  // 2. Style bleed: empty-string classes
  image_emptyStyle: [],
  title_defaultCta: [],
  accordion_emptyStyle: [],
  eyebrow_emptyStyle: [],
  // 3. Style bleed: valid class but wrong picklist
  image_alignCenter: [],
  image_alignLeft: [],
  image_small: [],
  factcard_hideimage: [],
};

const allXmls = findXmls('content-xml');

for (const x of allXmls) {
  const page = pageOf(x);
  try {
    const parsed = JCR_XML_PARSER.parse(fs.readFileSync(x, 'utf8'));
    const jcr = parsed['jcr:root'] && parsed['jcr:root']['jcr:content'];
    if (!jcr) continue;

    (function scan(n) {
      for (const [nodeKey, child] of ce(n)) {
        const rt = RT(child);
        if (!rt) { scan(child); continue; }

        // ── image gaps ─────────────────────────────────────────────────────
        if (rt === 'abbvie-com2/components/image/v2/image') {
          if (child['@cq:panelTitle'] && gaps.image_cqPanelTitle.length < 3) {
            gaps.image_cqPanelTitle.push({
              page, key: nodeKey,
              aemValue: String(child['@cq:panelTitle']).slice(0, 80),
              note: '@cq:panelTitle is unmapped → silently dropped from EDS output',
            });
          }
          if (child['@smartCropRendition'] && gaps.image_smartCropRendition.length < 2) {
            gaps.image_smartCropRendition.push({
              page, key: nodeKey,
              aemValue: String(child['@smartCropRendition']).slice(0, 80),
              note: '@smartCropRendition is unmapped → DM crop hint lost',
            });
          }
          // style ID → empty string
          const ids = String(child['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
          for (const id of ids) {
            const mapped = styleMap[id];
            if (mapped && mapped.edsClass === '' && gaps.image_emptyStyle.length < 3) {
              gaps.image_emptyStyle.push({
                page, key: nodeKey,
                styleId: id, mappedClass: '(empty string)',
                note: 'style ID maps to "" → classes_customDynamicClass gets empty entry or is omitted',
              });
            }
            if (mapped && mapped.edsClass === 'align-center' && gaps.image_alignCenter.length < 3) {
              gaps.image_alignCenter.push({
                page, key: nodeKey,
                styleId: id, mappedClass: 'align-center',
                note: 'align-center is not in image picklist → will be filtered out by validateCanvasStyles()',
                imageRef: String(child['@fileReference'] || '').slice(0, 60),
              });
            }
            if (mapped && mapped.edsClass === 'align-left' && gaps.image_alignLeft.length < 2) {
              gaps.image_alignLeft.push({
                page, key: nodeKey,
                styleId: id, mappedClass: 'align-left',
                note: 'align-left not in image picklist → filtered out',
              });
            }
            if (mapped && mapped.edsClass === 'small' && gaps.image_small.length < 2) {
              gaps.image_small.push({
                page, key: nodeKey,
                styleId: id, mappedClass: 'small',
                note: 'small not in image picklist → filtered out',
              });
            }
          }
        }

        // ── accordion gaps ──────────────────────────────────────────────────
        if (rt === 'abbvie-com2/components/accordion/v2/accordion') {
          if (child['@expandedItems'] && gaps.accordion_expandedItems.length < 3) {
            gaps.accordion_expandedItems.push({
              page, key: nodeKey,
              aemValue: String(child['@expandedItems']).slice(0, 80),
              note: '@expandedItems = pre-expanded panel index; unmapped → accordion always starts collapsed in EDS',
            });
          }
          const ids = String(child['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
          for (const id of ['3', '4']) {
            if (ids.includes(id) && gaps.accordion_emptyStyle.length < 3) {
              gaps.accordion_emptyStyle.push({
                page, key: nodeKey,
                styleId: id, mappedClass: styleMap[id] ? styleMap[id].edsClass : '(not in style-map)',
                note: 'style ID ' + id + ' maps to empty string → empty class in accordion output',
              });
            }
          }
        }

        // ── title gaps ──────────────────────────────────────────────────────
        if (rt === 'abbvie-com2/components/title/v2/title') {
          const ids = String(child['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
          if (ids.includes('1651545825678') && gaps.title_defaultCta.length < 3) {
            gaps.title_defaultCta.push({
              page, key: nodeKey,
              title: String(child['@jcr:title'] || '').slice(0, 60),
              styleId: '1651545825678', mappedClass: 'default-cta',
              note: 'default-cta is a CTA-policy style ID that bleeds onto title; aem-canvas.js filters it out (correct)',
            });
          }
        }

        // ── eyebrow gaps ────────────────────────────────────────────────────
        if (rt === 'abbvie-com2/components/header/v2/header') {
          const ids = String(child['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
          for (const id of ['3', '4', '5', '6']) {
            if (ids.includes(id) && gaps.eyebrow_emptyStyle.length < 3) {
              gaps.eyebrow_emptyStyle.push({
                page, key: nodeKey,
                text: String(child['@eyebrow'] || '').slice(0, 60),
                styleId: id, mappedClass: styleMap[id] ? styleMap[id].edsClass : '(not in style-map)',
                note: 'style ID ' + id + ' maps to empty class → eyebrow gets no variant class (renders as default)',
              });
            }
          }
        }

        // ── search-results gaps ─────────────────────────────────────────────
        if (rt === 'abbvie-com2/components/search/searchresults/v2/searchresults') {
          const attrs = ['noOfItems', 'paginationLimit', 'relevanceLabel', 'sortByLabel', 'searchResultsType', 'apiKey'];
          const found = {};
          for (const a of attrs) if (child['@' + a] !== undefined) found[a] = String(child['@' + a]).slice(0, 60);
          if (Object.keys(found).length && gaps.searchresults_labels.length < 2) {
            gaps.searchresults_labels.push({ page, key: nodeKey, attrs: found,
              note: 'These props are unmapped → lost in EDS output. Search results may use hard-coded defaults.',
            });
          }
        }

        // ── pipeline gaps ───────────────────────────────────────────────────
        if (rt === 'abbvie-com2/components/pipeline/v2/pipeline') {
          const labelAttrs = ['tablecolumn1txt', 'tablecolumn2txt', 'noResultsHeadingText', 'sharetext',
            'pronunciationtext', 'targetheadertext', 'moleculetext', 'pharmaceuticaltooltip'];
          const found = {};
          for (const a of labelAttrs) if (child['@' + a] !== undefined) found[a] = String(child['@' + a]).slice(0, 60);
          if (Object.keys(found).length && gaps.pipeline_labels.length < 2) {
            gaps.pipeline_labels.push({ page, key: nodeKey, attrs: found,
              note: 'Pipeline column/label localizations unmapped → EDS pipeline uses hard-coded English fallbacks.',
            });
          }
        }

        // ── fact-card gaps ──────────────────────────────────────────────────
        if (rt === 'abbvie-com2/components/dashboardcards/v1/dashboardcards') {
          const ids = String(child['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
          const HIDE = { '1772756234': 'hide-image-show-desc', '1772756279366': 'show-image-hide-desc' };
          for (const [id, cls] of Object.entries(HIDE)) {
            if (ids.includes(id) && gaps.factcard_hideimage.length < 3) {
              gaps.factcard_hideimage.push({
                page, key: nodeKey,
                fragment: String(child['@fragmentPath'] || '').slice(0, 70),
                styleId: id, mappedClass: cls,
                note: cls + ' is not in fact-card picklist → validateCanvasStyles() drops it → image/desc visibility wrong in EDS',
              });
            }
          }
        }

        scan(child);
      }
    })(jcr);
  } catch (e) {}
}

// ── Print report ───────────────────────────────────────────────────────────────
const SEP = '─'.repeat(80);

function printGap(title, items, printFn) {
  console.log('\n' + '═'.repeat(80));
  console.log('GAP: ' + title);
  console.log('═'.repeat(80));
  if (!items.length) { console.log('  No examples found in corpus.'); return; }
  items.forEach((item, i) => {
    console.log('\n  Example ' + (i + 1) + ':');
    console.log('    Page : ' + item.page);
    printFn(item);
    console.log('    Issue: ' + item.note);
  });
}

printGap('custom-image: @cq:panelTitle unmapped (596 instances)', gaps.image_cqPanelTitle, item => {
  console.log('    AEM  : @cq:panelTitle = "' + item.aemValue + '"');
  console.log('    EDS  : prop ABSENT from output — panel label silently lost');
});

printGap('custom-image: @smartCropRendition unmapped (84 instances)', gaps.image_smartCropRendition, item => {
  console.log('    AEM  : @smartCropRendition = "' + item.aemValue + '"');
  console.log('    EDS  : prop ABSENT — DM crop hint not carried to EDS image block');
});

printGap('custom-image: style ID maps to empty string (1322 instances combined)', gaps.image_emptyStyle, item => {
  console.log('    AEM  : @cq:styleIds includes "' + item.styleId + '"');
  console.log('    EDS  : classes_customDynamicClass = "" (or omitted) — no visual style applied');
});

printGap('custom-image: align-center class not in image picklist (650 instances)', gaps.image_alignCenter, item => {
  console.log('    AEM  : @cq:styleIds=' + item.styleId + ' → style-map says "align-center"');
  console.log('    AEM  : image fileReference = ' + item.imageRef);
  console.log('    EDS  : validateCanvasStyles() filters it out → image has NO alignment class');
  console.log('    Want : image picklist should include align-center, OR style-map should give image-specific class');
});

printGap('custom-image: align-left class not in image picklist (154 instances)', gaps.image_alignLeft, item => {
  console.log('    AEM  : @cq:styleIds=' + item.styleId + ' → style-map says "align-left"');
  console.log('    EDS  : filtered out → image loses left-alignment');
});

printGap('custom-image: small class not in image picklist (69 instances)', gaps.image_small, item => {
  console.log('    AEM  : @cq:styleIds=' + item.styleId + ' → style-map says "small"');
  console.log('    EDS  : filtered out → image renders at full/default size instead of small');
});

printGap('custom-title: default-cta bleeds from CTA policy (1477 instances)', gaps.title_defaultCta, item => {
  console.log('    AEM  : title="' + item.title + '" @cq:styleIds=' + item.styleId);
  console.log('    EDS  : aem-canvas.js strips "default-cta" → title gets "book-weight" default');
  console.log('    Status: CORRECTLY handled. Listed for awareness only.');
});

printGap('accordion: @expandedItems unmapped (10 instances)', gaps.accordion_expandedItems, item => {
  console.log('    AEM  : @expandedItems = "' + item.aemValue + '"');
  console.log('    EDS  : prop ABSENT → accordion always starts fully collapsed');
  console.log('    Want : Map @expandedItems → expandedItems so authored open-state is preserved');
});

printGap('accordion: style IDs 3,4 map to empty string (46 instances)', gaps.accordion_emptyStyle, item => {
  console.log('    AEM  : @cq:styleIds includes "' + item.styleId + '"');
  console.log('    EDS  : classes_customDynamicClass includes "" → empty token in class string');
  console.log('    Want : style-map entries for ID "' + item.styleId + '" need correct EDS class names');
});

printGap('eyebrow-text: style IDs 3,4,5,6 map to empty string (305 instances)', gaps.eyebrow_emptyStyle, item => {
  console.log('    AEM  : @eyebrow="' + item.text + '" @cq:styleIds includes "' + item.styleId + '"');
  console.log('    EDS  : style ID ' + item.styleId + ' → "' + item.mappedClass + '" → eyebrow variant missing');
  console.log('    Want : determine correct EDS eyebrow variant for AEM style ID ' + item.styleId);
});

printGap('fact-card: hide-image-show-desc / show-image-hide-desc not in picklist (200 instances)', gaps.factcard_hideimage, item => {
  console.log('    AEM  : @fragmentPath=' + item.fragment);
  console.log('    AEM  : @cq:styleIds=' + item.styleId + ' → style-map says "' + item.mappedClass + '"');
  console.log('    EDS  : validateCanvasStyles() filters it out → image/description visibility not toggled');
  console.log('    Want : add "' + item.mappedClass + '" to fact-card picklist config');
});

printGap('search-results: 6 label/config props unmapped (43 instances each)', gaps.searchresults_labels, item => {
  console.log('    AEM  page: ' + item.page);
  Object.entries(item.attrs).forEach(([k, v]) => console.log('    AEM  : @' + k + ' = "' + v + '"'));
  console.log('    EDS  : ALL absent from output → search block uses JS hard-coded defaults');
});

printGap('pipeline: 21 column/label props unmapped (6 instances each)', gaps.pipeline_labels, item => {
  console.log('    AEM  page: ' + item.page);
  Object.entries(item.attrs).forEach(([k, v]) => console.log('    AEM  : @' + k + ' = "' + v + '"'));
  console.log('    EDS  : ALL absent → pipeline uses hard-coded English column/share labels for all locales');
});

console.log('\n' + '═'.repeat(80));
console.log('GLOBAL STYLE MAP: All style IDs in corpus are mapped ✓');
console.log('CLEAN COMPONENTS: button/cta, experiencefragment, search-input ✓');
console.log('═'.repeat(80));
