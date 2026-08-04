#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Recursively find all .content.xml files in a directory
function findContentXml(dir, base = dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        results.push(...findContentXml(fullPath, base));
      } else if (entry.name === '.content.xml') {
        // Get relative path from base
        const relativePath = path.relative(base, dir);
        results.push(relativePath);
      }
    }
  } catch (err) {
    // Skip directories we can't read
  }
  return results;
}

console.log('🔍 Scanning AEM source pages (content-xml/)...');
const aemPages = findContentXml('content-xml');
console.log(`✓ Found ${aemPages.length} AEM pages\n`);

console.log('🔍 Scanning EDS migrated pages (eds-xml/)...');
const edsPages = findContentXml('eds-xml');
console.log(`✓ Found ${edsPages.length} EDS pages\n`);

// Create sets for fast lookup
const aemSet = new Set(aemPages.map(p => p.replace(/\\/g, '/')));
const edsSet = new Set(edsPages.map(p => p.replace(/\\/g, '/')));

// Find exact 1:1 matches
const matches = [];
const aemOnly = [];
const edsOnly = [];

for (const aemPath of aemSet) {
  if (edsSet.has(aemPath)) {
    matches.push(aemPath);
  } else {
    aemOnly.push(aemPath);
  }
}

for (const edsPath of edsSet) {
  if (!aemSet.has(edsPath)) {
    edsOnly.push(edsPath);
  }
}

// Analyze by locale
const byLocale = {};
for (const match of matches) {
  const parts = match.split('/');
  const locale = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
  if (!byLocale[locale]) byLocale[locale] = [];
  byLocale[locale].push(match);
}

console.log('═══════════════════════════════════════════════════════════');
console.log('📊 PAIRED PAGE ANALYSIS RESULTS');
console.log('═══════════════════════════════════════════════════════════\n');

console.log(`✅ EXACT 1:1 PAIRED PAGES: ${matches.length}`);
console.log(`   (Pages that exist in BOTH content-xml/ AND eds-xml/)\n`);

console.log(`📍 AEM-ONLY PAGES: ${aemOnly.length}`);
console.log(`   (Pages in content-xml/ but NOT migrated to eds-xml/)\n`);

console.log(`📍 EDS-ONLY PAGES: ${edsOnly.length}`);
console.log(`   (Pages in eds-xml/ but no source in content-xml/)\n`);

console.log('───────────────────────────────────────────────────────────');
console.log('PAIRED PAGES BY LOCALE:');
console.log('───────────────────────────────────────────────────────────');

const sortedLocales = Object.keys(byLocale).sort();
for (const locale of sortedLocales) {
  console.log(`  ${locale.padEnd(10)} : ${byLocale[locale].length.toString().padStart(4)} paired pages`);
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log('🎯 TRAINING DATASET SUMMARY');
console.log('═══════════════════════════════════════════════════════════\n');

console.log(`Total Paired Pages Available for Analysis: ${matches.length}`);
console.log(`Total Locales with Pairs: ${sortedLocales.length}`);
console.log(`Average Pages per Locale: ${(matches.length / sortedLocales.length).toFixed(1)}\n`);

// Sample some pairs for display
console.log('📋 SAMPLE PAIRED PAGES (first 20):');
console.log('───────────────────────────────────────────────────────────');
matches.slice(0, 20).forEach((p, i) => {
  console.log(`${(i + 1).toString().padStart(2)}. ${p}`);
});
if (matches.length > 20) {
  console.log(`... and ${matches.length - 20} more pairs\n`);
}

// Write full list to file
const report = {
  timestamp: new Date().toISOString(),
  summary: {
    totalPairs: matches.length,
    aemOnly: aemOnly.length,
    edsOnly: edsOnly.length,
    totalAem: aemPages.length,
    totalEds: edsPages.length,
    localesWithPairs: sortedLocales.length
  },
  byLocale,
  allPairs: matches,
  aemOnlyPages: aemOnly,
  edsOnlyPages: edsOnly
};

fs.writeFileSync('pair-analysis-report.json', JSON.stringify(report, null, 2));
console.log('✓ Full report saved to: pair-analysis-report.json\n');
