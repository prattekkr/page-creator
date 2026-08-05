const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { aemToCanvas } = require('./aem-canvas.js');
const JCR_XML_PARSER = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseAttributeValue: false, trimValues: true, isArray: () => false });

const RT = n => (n && n['@sling:resourceType'] || '').trim();
const ce = n => Object.entries(n).filter(([k, v]) => !k.startsWith('@') && k !== '#text' && v && typeof v === 'object');

// Scan AEM source for the acne-inversa page
const pg = 'ch/de/science/areas-of-focus/immunology/acne-inversa';
const f = 'content-xml/' + pg + '/.content.xml';
if (!fs.existsSync(f)) {
  console.log('NOT FOUND:', f);
  process.exit();
}

const jcr = JCR_XML_PARSER.parse(fs.readFileSync(f, 'utf8'))['jcr:root']['jcr:content'];

// Find all linklists in AEM source
let found = 0;
(function scan(n, depth) {
  for (const [k, child] of ce(n)) {
    const rt = RT(child);
    if (rt.includes('linklist')) {
      found++;
      console.log('AEM LINKLIST at depth ' + depth + ' key=' + k);
      Object.entries(child).filter(([k2]) => k2.startsWith('@')).forEach(([k2, v]) => {
        console.log('  ' + k2 + ' = ' + String(v).slice(0, 100));
      });
      console.log('  children:');
      for (const [ck, cc] of ce(child)) {
        console.log('    ' + ck + ' rt=' + RT(cc));
        Object.entries(cc).filter(([k3]) => k3.startsWith('@')).forEach(([k3, v]) => {
          console.log('      ' + k3 + ' = ' + String(v).slice(0, 80));
        });
      }
    }
    scan(child, depth + 1);
  }
})(jcr, 0);

if (!found) console.log('No linklist found on acne-inversa');

// Now show EDS canvas output for this page
console.log('\n--- EDS canvas output:');
const sections = aemToCanvas(jcr, { rel: pg });
sections.forEach(function(s, i) {
  const dc = s.props && s.props.style_customDynamicClass || '';
  console.log('S' + i + ' [' + s.type + ']: ' + dc.slice(0, 60));
  (s.blocks || []).forEach(function(b) {
    const bdc = b.props && b.props.classes_customDynamicClass || '';
    const bcc = b.props && b.props.classes_commonCustomClass || '';
    console.log('  ' + b.type + (bcc ? ' [' + bcc + ']' : '') + (bdc ? ' {' + bdc + '}' : ''));
    (b.children || []).forEach(function(c) {
      const cdc = c.props && c.props.classes_customDynamicClass || '';
      console.log('    ' + c.type + (cdc ? ' {' + cdc + '}' : ''));
    });
  });
});

// Also check a page with no-style linklists for context
console.log('\n--- AEM pages with unstyled linklists (sample):');
const pages = ['ar/es/science/areas-of-innovation', 'at/de/forschung/forschungsbereiche/aesthetik'];
for (const page of pages) {
  const pf = 'content-xml/' + page + '/.content.xml';
  if (!fs.existsSync(pf)) continue;
  console.log('Page:', page);
  const jcr2 = JCR_XML_PARSER.parse(fs.readFileSync(pf, 'utf8'))['jcr:root']['jcr:content'];
  (function scan2(n) {
    for (const [k, child] of ce(n)) {
      const rt = RT(child);
      if (rt.includes('linklist')) {
        const ids = String(child['@cq:styleIds'] || '').replace(/[\[\]\s]/g, '');
        if (!ids) {
          console.log('  key=' + k + ' listFrom=' + (child['@listFrom'] || '') + ' childDepth=' + (child['@childDepth'] || ''));
        }
      }
      scan2(child);
    }
  })(jcr2);
}
