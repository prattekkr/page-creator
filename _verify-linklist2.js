const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { aemToCanvas } = require('./aem-canvas.js');
const JCR_XML_PARSER = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseAttributeValue: false, trimValues: true, isArray: () => false });

// Check what the EDS hand-crafted pages have for linklist styles
// by scanning eds-xml directory
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

// Check EDS-xml hand-crafted linklist styles
if (fs.existsSync('eds-xml')) {
  const edsXmls = findXmls('eds-xml');
  console.log('EDS-xml files:', edsXmls.length);
  const edsLLStyles = {};
  const LL_RT = 'abbvie-com2/components/linklist/v2/linklist';
  function RT(n) { return (n && n['@sling:resourceType'] || '').trim(); }
  const childEntries = n => Object.entries(n).filter(([k, v]) => !k.startsWith('@') && k !== '#text' && v && typeof v === 'object');
  function findLL(n) {
    for (const entry of childEntries(n)) {
      const child = entry[1];
      if (RT(child) === LL_RT) {
        const cls = String(child['@classes_customDynamicClass'] || '');
        edsLLStyles[cls || '(none)'] = (edsLLStyles[cls || '(none)'] || 0) + 1;
      }
      findLL(child);
    }
  }
  for (const x of edsXmls) {
    try {
      const parsed = JCR_XML_PARSER.parse(fs.readFileSync(x, 'utf8'));
      const root = parsed['jcr:root'];
      if (root) findLL(root);
    } catch (e) {}
  }
  console.log('EDS hand-crafted linklist classes_customDynamicClass:');
  Object.entries(edsLLStyles).sort((a, b) => b[1] - a[1]).forEach(pair => {
    console.log('  ' + pair[1] + 'x  [' + pair[0] + ']');
  });
}

// Show AEM source attrs of linklists with NO styleIds
const aemXmls = findXmls('content-xml');
const LL_RT2 = 'abbvie-com2/components/linklist/v2/linklist';
function RT2(n) { return (n && n['@sling:resourceType'] || '').trim(); }
const childEntries2 = n => Object.entries(n).filter(([k, v]) => !k.startsWith('@') && k !== '#text' && v && typeof v === 'object');
let noStyleSamples = [];
let noStyleCount = 0;

for (const x of aemXmls) {
  if (noStyleSamples.length >= 5) break;
  try {
    const parsed = JCR_XML_PARSER.parse(fs.readFileSync(x, 'utf8'));
    const jcr = parsed['jcr:root'] && parsed['jcr:root']['jcr:content'];
    if (!jcr) continue;
    (function scan(n) {
      for (const entry of childEntries2(n)) {
        const child = entry[1];
        if (RT2(child) === LL_RT2) {
          const ids = String(child['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '');
          if (!ids) {
            noStyleCount++;
            if (noStyleSamples.length < 5) {
              noStyleSamples.push({
                page: x.replace(/\\/g, '/').replace('content-xml/', '').replace('/.content.xml', ''),
                listType: child['@listFrom'] || '',
                linkItems: child['@linkItems'] || '',
                childDepth: child['@childDepth'] || '',
              });
            }
          }
        }
        scan(child);
      }
    })(jcr);
  } catch (e) {}
}
console.log('\nAEM linklists with NO styleIds (total ~435 in corpus):');
noStyleSamples.forEach(s => {
  console.log('  page=' + s.page + ' listFrom=' + s.listType + ' linkItems=' + s.linkItems + ' depth=' + s.childDepth);
});

// Look at ch/de/science/areas-of-focus/immunology/acne-inversa (the original task page)
const targetPage = 'ch/de/science/areas-of-focus/immunology/acne-inversa';
const targetPath = 'content-xml/' + targetPage + '/.content.xml';
if (fs.existsSync(targetPath)) {
  console.log('\n--- Target page:', targetPage);
  const sections = aemToCanvas(JCR_XML_PARSER.parse(fs.readFileSync(targetPath, 'utf8'))['jcr:root']['jcr:content'], { rel: targetPage });
  sections.forEach(function(s, i) {
    s.blocks && s.blocks.forEach(function(b) {
      if (b.type === 'linklist') {
        console.log('  linklist dc=[' + (b.props.classes_customDynamicClass || '') + '] cc=[' + (b.props.classes_commonCustomClass || '') + ']');
      }
    });
  });
} else {
  console.log('\nTarget page not found:', targetPath);
}
