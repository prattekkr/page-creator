const fs = require('fs');
const path = require('path');
const sm = JSON.parse(fs.readFileSync('style-map.json', 'utf8'));

function readPL(name) {
  const f = path.join('config', name + '-picklist-config', '.content.xml');
  try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; }
}
function classes(xml) {
  if (!xml) return [];
  return Array.from(xml.matchAll(/Style_x0020_Class="([^"]+)"/g)).map(m => m[1]);
}

console.log('IMAGE picklist:', classes(readPL('image')));
console.log('ACCORDION picklist:', classes(readPL('accordion')));
console.log('EYEBROW-TEXT picklist:', classes(readPL('eyebrow-text')));
console.log('FACT-CARD picklist:', classes(readPL('fact-card')));
console.log('');
// Style map entries for problem IDs
const CHECK = {
  '3': 'global ID 3 (accordion/eyebrow)',
  '4': 'global ID 4 (accordion)',
  '5': 'global ID 5 (eyebrow)',
  '6': 'global ID 6 (eyebrow)',
  '1402843082812': 'image empty-class 1',
  '1402843082835': 'image empty-class 2',
  '1402843082833': 'image empty-class 3',
  '1402843082837': 'image empty-class 4',
  '1402843082822': 'image align-center',
  '1402843082823': 'image align-left',
  '1402843082824': 'image align-right',
  '1402843082836': 'image small',
  '1772756234': 'fact-card hide-image-show-desc',
  '1772756279366': 'fact-card show-image-hide-desc',
};
console.log('STYLE-MAP ENTRIES:');
for (const [id, label] of Object.entries(CHECK)) {
  const entry = sm[id];
  console.log(' ', id.padEnd(18), label.padEnd(35), '->', JSON.stringify(entry));
}

// Check migration-map for search-results and pipeline propRenames
const mm = JSON.parse(fs.readFileSync('migration-map.json', 'utf8'));
const sr = mm.componentMap['abbvie-com2/components/search/searchresults/v2/searchresults'];
console.log('\nSEARCH-RESULTS current propRenames:', JSON.stringify(sr.propRenames));
console.log('SEARCH-RESULTS current skipProps:', JSON.stringify(sr.skipProps));
const pp = mm.componentMap['abbvie-com2/components/pipeline/v2/pipeline'];
console.log('\nPIPELINE current propRenames:', JSON.stringify(pp.propRenames));
const acc = mm.componentMap['abbvie-com2/components/accordion/v2/accordion'];
console.log('\nACCORDION current propRenames:', JSON.stringify(acc.propRenames));
console.log('ACCORDION current skipProps:', JSON.stringify(acc.skipProps));
