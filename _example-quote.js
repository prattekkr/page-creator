const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { aemToCanvas } = require('./aem-canvas.js');
const JCR_XML_PARSER = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseAttributeValue: false, trimValues: true, isArray: () => false });

const RT = n => (n && n['@sling:resourceType'] || '').trim();
const ce = n => Object.entries(n).filter(([k, v]) => !k.startsWith('@') && k !== '#text' && v && typeof v === 'object');

// Find a page with a rich quote (with styleIds, attributionImage, backgroundImage if possible)
function findXmls(dir, out) {
  out = out || [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) findXmls(full, out);
      else if (e.name === '.content.xml') out.push(full);
    }
  } catch (e) {}
  return out;
}

const QUOTE_RT = 'abbvie-com2/components/quote';
let examples = [];

for (const x of findXmls('content-xml')) {
  if (examples.length >= 3) break;
  try {
    const parsed = JCR_XML_PARSER.parse(fs.readFileSync(x, 'utf8'));
    const jcr = parsed['jcr:root'] && parsed['jcr:root']['jcr:content'];
    if (!jcr) continue;
    const page = x.replace(/\\/g, '/').replace('content-xml/', '').replace('/.content.xml', '');
    (function scan(n) {
      for (const [k, child] of ce(n)) {
        if (RT(child) === QUOTE_RT) {
          const ids = String(child['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '');
          // prefer quote with styleIds and attribution image
          if (ids && child['@fileReference']) {
            examples.push({ page, key: k, aem: child, jcr });
          } else if (ids && examples.length < 2) {
            examples.push({ page, key: k, aem: child, jcr });
          }
        }
        scan(child);
      }
    })(jcr);
  } catch (e) {}
}

// For each example: show AEM raw → EDS output side by side
examples.forEach(({ page, key, aem, jcr }, idx) => {
  console.log('═'.repeat(80));
  console.log('EXAMPLE ' + (idx + 1) + '  page: ' + page + '  aem-key: ' + key);
  console.log('═'.repeat(80));

  console.log('\n── AEM JCR XML (relevant attrs) ─────────────────────────────────────────────');
  const attrs = Object.entries(aem).filter(([k]) => k.startsWith('@'));
  attrs.forEach(([k, v]) => {
    const name = k.slice(1);
    console.log('  @' + name + ' = ' + String(v));
  });

  console.log('\n── EDS canvas output (quote block props) ─────────────────────────────────────');
  const sections = aemToCanvas(jcr, { rel: page });
  let found = false;
  (function walkSections(secs) {
    for (const s of secs || []) {
      for (const b of s.blocks || []) {
        if (visitBlock(b)) return;
      }
    }
  })(sections);

  function visitBlock(b) {
    if (!b) return false;
    if (b.type === 'quote') {
      Object.entries(b.props || {}).forEach(([k, v]) => {
        const truncated = String(v).length > 120 ? String(v).slice(0, 120) + '…' : String(v);
        console.log('  ' + k + ': ' + truncated);
      });
      found = true;
      return true;
    }
    for (const c of b.children || []) if (visitBlock(c)) return true;
    return false;
  }

  console.log('\n── Field mapping table ───────────────────────────────────────────────────────');
  console.log('  AEM attribute              →  EDS prop                    value');
  console.log('  ─────────────────────────────────────────────────────────────────────────');
  const MAP = {
    '@quote': 'quotation',
    '@attributionName': 'attributionName',
    '@author': 'attributionName',
    '@attributionTitle': 'attributionRole',
    '@authorTitle': 'attributionRole',
    '@fileReference': 'attributionImage',
    '@backgroundImageFileReference': 'backgroundImage',
    '@topLeftText': 'toplefttext',
    '@bottomRightText': 'toprighttext',
    '@cq:styleIds': 'classes_customDynamicClass',
    '@quoteType': '(SKIPPED)',
    '@textSize': '(SKIPPED)',
    '@bgImageModifiers': '(SKIPPED)',
    '@imageModifiers': '(SKIPPED)',
    '@fragmentPath': '(SKIPPED)',
    '@dmPresetType': '(SKIPPED)',
  };
  for (const [aemKey, edsKey] of Object.entries(MAP)) {
    if (aem[aemKey] !== undefined) {
      const val = String(aem[aemKey]).slice(0, 60);
      console.log('  ' + aemKey.padEnd(26) + ' →  ' + edsKey.padEnd(28) + ' ' + val);
    }
  }
  console.log();
});
