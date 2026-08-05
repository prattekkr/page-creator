// Audit: find all EDS classes in style-map.json that are missing from their
// corresponding picklist config. Works by matching known AEM groupLabel keywords
// to the picklist component name. Reports every block type with gaps.
'use strict';
const fs = require('fs');
const path = require('path');

const styleMap = JSON.parse(fs.readFileSync('./style-map.json', 'utf8'));
const configRoot = path.join(__dirname, 'config');

// Load all picklist configs
const picklists = {};
for (const entry of fs.readdirSync(configRoot, { withFileTypes: true })) {
  const match = entry.isDirectory() && entry.name.match(/^(.*)-picklist-config$/);
  if (!match) continue;
  const file = path.join(configRoot, entry.name, '.content.xml');
  try {
    const xml = fs.readFileSync(file, 'utf8');
    picklists[match[1]] = new Set(
      [...xml.matchAll(/Style_x0020_Class="([^"]+)"/g)].map(m => m[1])
    );
  } catch (e) {
    picklists[match[1]] = new Set();
  }
}

console.log('=== Current picklist contents ===');
for (const [name, classes] of Object.entries(picklists).sort((a,b)=>a[0].localeCompare(b[0]))) {
  console.log(`  ${name}: [${[...classes].join(', ')}]`);
}
console.log('');

// Style-map groupLabel → which EDS picklist(s) it belongs to
// Derived from the EDS component policies
const GROUP_TO_PICKLISTS = {
  'Display':                    ['image'],
  'Width':                      ['image'],
  'Alignment':                  ['image'],
  'Image Width':                ['image'],
  'Image Alignment':            ['image'],
  'Desktop Width':              ['section', 'grid-container'],
  'Desktop Height':             ['section', 'grid-container'],
  'Margin and Padding':         ['section', 'grid-container'],
  'Radius':                     ['section', 'grid-container'],
  'Theme':                      ['section', 'accordion', 'teaser', 'quote', 'linklist'],
  'Accordion Width':            ['accordion'],
  'Accordion':                  ['accordion'],
  'Quote':                      ['quote'],
  'Linklist':                   ['linklist'],
  'Teaser':                     ['teaser'],
  'Dashboard Layout':           ['teaser', 'story-card'],
  'Dashboard - Layout':         ['teaser', 'story-card'],
  'Eyebrow':                    ['eyebrow-text'],
  'Separator':                  ['separator'],
  'Title':                      ['title'],
  'Text':                       ['text'],
  'CTA':                        ['cta'],
  'Carousel':                   ['carousel'],
  'Fact Card':                   ['fact-card'],
  'News Feed':                  ['news-feed'],
  'Story Card':                 ['story-card'],
  'Video':                      ['video'],
};

// Collect missing entries per picklist
const gaps = {}; // picklist → [ { id, aemLabel, aemClass, edsClass, groupLabel } ]

for (const [id, entry] of Object.entries(styleMap)) {
  const cls = entry.edsClass;
  if (!cls) continue;
  const group = entry.groupLabel || '';

  // Find candidate picklists for this group
  const candidates = GROUP_TO_PICKLISTS[group] || [];

  for (const picklist of candidates) {
    if (!picklists[picklist]) continue;
    if (!picklists[picklist].has(cls)) {
      if (!gaps[picklist]) gaps[picklist] = [];
      gaps[picklist].push({
        id,
        aemLabel: entry.aemLabel,
        aemClass: entry.aemClass,
        edsClass: cls,
        groupLabel: group,
        confidence: entry.confidence,
      });
    }
  }
}

// Also: check all picklist types from style-map by inferring from aemClass prefix
// e.g. cmp-image--* → image, cmp-title--* → title, etc.
const AEM_PREFIX_TO_PICKLIST = {
  'cmp-image--':      ['image'],
  'cmp-title--':      ['title'],
  'cmp-text--':       ['text'],
  'cmp-carousel-':    ['carousel'],
  'cmp-accordion-':   ['accordion'],
  'cmp-teaser-':      ['teaser'],
  'cmp-separator-':   ['separator'],
  'cmp-quote-':       ['quote'],
  'cmp-video-':       ['video'],
};

for (const [id, entry] of Object.entries(styleMap)) {
  const cls = entry.edsClass;
  if (!cls) continue;
  const aemClass = entry.aemClass || '';
  for (const [prefix, picklists_] of Object.entries(AEM_PREFIX_TO_PICKLIST)) {
    if (!aemClass.startsWith(prefix)) continue;
    for (const picklist of picklists_) {
      if (!picklists[picklist]) continue;
      if (!picklists[picklist].has(cls)) {
        if (!gaps[picklist]) gaps[picklist] = [];
        // Avoid duplicates
        if (!gaps[picklist].some(g => g.id === id)) {
          gaps[picklist].push({
            id,
            aemLabel: entry.aemLabel,
            aemClass: entry.aemClass,
            edsClass: cls,
            groupLabel: entry.groupLabel || '',
            confidence: entry.confidence,
          });
        }
      }
    }
  }
}

console.log('=== GAPS: style-map EDS classes missing from picklist configs ===');
if (!Object.keys(gaps).length) {
  console.log('No gaps found.');
} else {
  for (const [picklist, items] of Object.entries(gaps).sort((a,b)=>a[0].localeCompare(b[0]))) {
    console.log(`\n--- ${picklist} (${items.length} missing) ---`);
    for (const g of items) {
      console.log(`  [${g.id}] "${g.aemLabel}" | ${g.aemClass} → "${g.edsClass}" (group: ${g.groupLabel}, confidence: ${g.confidence})`);
    }
  }
}

console.log('\n=== SUMMARY ===');
let total = 0;
for (const [picklist, items] of Object.entries(gaps).sort((a,b)=>a[0].localeCompare(b[0]))) {
  console.log(`  ${picklist}: ${items.length} missing`);
  total += items.length;
}
console.log(`  TOTAL: ${total} missing EDS classes across all picklists`);
