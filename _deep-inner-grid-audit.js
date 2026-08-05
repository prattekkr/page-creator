/**
 * Deep 1:1 AEM → EDS inner-grid audit for /us/en pages.
 *
 * For every us/en page that has BOTH an AEM XML source and an EDS XML twin:
 *   1. Run aemToCanvas() to get the GENERATED canvas
 *   2. Parse the EDS twin XML to get the HAND-CRAFTED canvas structure
 *   3. Compare: where does the generated output use inner-grid vs the twin
 *      and what does the twin actually use (grid-container, nothing, etc.)
 *   4. Flag potential over-exploitation: generated inner-grid where twin uses
 *      grid-container/grid-section (suggesting it should be a normal grid)
 *
 * Output: us-en-inner-grid-audit.json + us-en-inner-grid-audit.pdf
 */

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { aemToCanvas } = require('./aem-canvas');

const CONTENT_XML_ROOT = path.join(__dirname, 'content-xml');
const EDS_XML_ROOT = path.join(__dirname, 'eds-xml');
const WIDTH_STYLE_IDS = new Set([
  '1653545825684','1653545825685','1653545825686','1653545825687',
  '1653545825688','1653545825689','1653545825690','1653545825692',
]);

// ── XML parsing helpers ────────────────────────────────────────────────────────
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
});

function parseXml(filePath) {
  try {
    const txt = fs.readFileSync(filePath, 'utf8');
    return parser.parse(txt);
  } catch { return null; }
}

function findJcrContent(parsed) {
  if (!parsed) return null;
  const root = parsed['jcr:root'] || parsed;
  return root?.['jcr:content'] || null;
}

// ── Walk generated canvas and collect inner-grid usages ──────────────────────
function collectInnerGrids(sections) {
  const found = [];
  function walk(entity, sectionIdx, parentType) {
    if (!entity) return;
    if (entity.type === 'inner-grid') {
      found.push({
        classes: entity.props?.classes_customDynamicClass || '',
        parentType,
        sectionIdx,
      });
    }
    for (const child of (entity.children || entity.blocks || [])) {
      walk(child, sectionIdx, entity.type);
    }
  }
  sections.forEach((s, i) => walk(s, i, 'root'));
  return found;
}

// ── Walk generated canvas and collect grid-container usages ──────────────────
function collectGridContainers(sections) {
  const found = [];
  sections.forEach((s, i) => {
    if (s.type === 'grid-container') {
      found.push({
        sectionIdx: i,
        blockCount: (s.blocks || []).length,
        classes: s.props?.style_customDynamicClass || '',
      });
    }
  });
  return found;
}

// ── Parse EDS twin XML and extract block types ────────────────────────────────
// EDS twin is stored as AEM JCR XML with sling:resourceType = eds block names
function collectEdsBlockTypes(edsXmlPath) {
  const txt = fs.existsSync(edsXmlPath) ? fs.readFileSync(edsXmlPath, 'utf8') : null;
  if (!txt) return { innerGrids: 0, gridContainers: 0, gridSections: 0, blockTypes: [] };

  const innerGrids = (txt.match(/filter="inner-grid"|blockType="inner-grid"|<[^>]*inner.grid[^>]*>/gi) || []).length
    + (txt.match(/"inner-grid"/g) || []).length;
  const gridContainers = (txt.match(/filter="grid-container"|style_container="grid-container"/g) || []).length;
  const gridSections = (txt.match(/style_container="grid-section"|filter="grid-section"/g) || []).length;

  // Extract all unique filter= values (EDS block types)
  const blockTypes = [...new Set([...txt.matchAll(/filter="([^"]+)"/g)].map(m => m[1]))];

  return { innerGrids, gridContainers, gridSections, blockTypes };
}

// ── Get list of us/en page paths that have BOTH AEM and EDS XML ───────────────
const pairs = JSON.parse(fs.readFileSync(path.join(__dirname, 'page-pairs.json'), 'utf8'));
const usenPairs = pairs.filter(p => p.startsWith('us/en'));

console.log(`Found ${usenPairs.length} us/en page pairs to analyse...\n`);

const results = [];
let processed = 0;

for (const rel of usenPairs) {
  // Find AEM XML file
  const aemDir = path.join(CONTENT_XML_ROOT, ...rel.split('/'));
  const aemXmlCandidates = [
    path.join(aemDir, '.content.xml'),
    path.join(aemDir, 'jcr_content.xml'),
    path.join(CONTENT_XML_ROOT, rel + '.xml'),
  ];
  const aemXmlPath = aemXmlCandidates.find(p => fs.existsSync(p));

  // Find EDS XML file
  const edsDir = path.join(EDS_XML_ROOT, ...rel.split('/'));
  const edsXmlCandidates = [
    path.join(edsDir, '.content.xml'),
    path.join(edsDir, 'jcr_content.xml'),
    path.join(EDS_XML_ROOT, rel + '.xml'),
  ];
  const edsXmlPath = edsXmlCandidates.find(p => fs.existsSync(p));

  if (!aemXmlPath) continue;

  // Run aemToCanvas on AEM XML
  let generatedSections = [];
  let genError = null;
  try {
    const parsed = parseXml(aemXmlPath);
    const jcrContent = findJcrContent(parsed);
    if (jcrContent) {
      generatedSections = aemToCanvas(jcrContent, { rel });
    }
  } catch (e) {
    genError = e.message;
  }

  const genInnerGrids = collectInnerGrids(generatedSections);
  const genGridContainers = collectGridContainers(generatedSections);
  const totalBlocks = generatedSections.reduce((acc, s) => {
    return acc + (s.blocks || []).reduce((a2, b) => a2 + 1 + (b.children || []).length, 0);
  }, 0);

  // Parse EDS twin
  const twinData = edsXmlPath ? collectEdsBlockTypes(edsXmlPath) : null;

  // ── Discrepancy analysis ──────────────────────────────────────────────────
  // Check AEM source: does it have width-style containers with grids?
  const aemTxt = fs.existsSync(aemXmlPath) ? fs.readFileSync(aemXmlPath, 'utf8') : '';
  const hasWidthContainerWithGrid = (() => {
    const containerRe = /<(\w+)\s[^/]*?sling:resourceType="abbvie-com2\/components\/container\/v2\/container"[^>]*>/g;
    for (const m of [...aemTxt.matchAll(containerRe)]) {
      const tagEnd = aemTxt.indexOf('>', m.index);
      const tagText = aemTxt.slice(m.index, tagEnd + 1);
      const styleMatch = tagText.match(/cq:styleIds="\[([^\]]+)\]"/);
      if (!styleMatch) continue;
      const ids = styleMatch[1].split(',').map(s => s.trim().replace(/"/g, ''));
      if (!ids.some(id => WIDTH_STYLE_IDS.has(id))) continue;
      const after = aemTxt.slice(m.index, m.index + 6000);
      if (/sling:resourceType="abbvie-com2\/components\/grid\/v2\/grid"/.test(after)) return true;
    }
    return false;
  })();

  // Does AEM have plain grid (without width container wrapper)?
  const aemGridCount = (aemTxt.match(/sling:resourceType="abbvie-com2\/components\/grid\/v2\/grid"/g) || []).length;

  // Verdict
  let verdict = 'ok';
  let verdictDetail = '';

  if (genInnerGrids.length > 0 && twinData) {
    if (twinData.innerGrids === 0 && twinData.gridContainers > 0) {
      verdict = 'OVER_INNER_GRID';
      verdictDetail = `Generated ${genInnerGrids.length} inner-grid(s) but twin uses ${twinData.gridContainers} grid-container(s) and 0 inner-grids. Possible over-exploitation.`;
    } else if (twinData.innerGrids === 0 && twinData.gridContainers === 0) {
      verdict = 'INNER_GRID_NOT_IN_TWIN';
      verdictDetail = `Generated ${genInnerGrids.length} inner-grid(s) but twin has NO inner-grid and NO grid-container. Check if this layout even needs a grid.`;
    } else if (twinData.innerGrids > 0) {
      verdict = 'MATCH';
      verdictDetail = `Both generated and twin use inner-grid (gen: ${genInnerGrids.length}, twin: ${twinData.innerGrids}).`;
    }
  } else if (genInnerGrids.length === 0 && twinData && twinData.innerGrids > 0) {
    verdict = 'MISSING_INNER_GRID';
    verdictDetail = `Twin has ${twinData.innerGrids} inner-grid(s) but generated output has none.`;
  } else if (genInnerGrids.length === 0) {
    verdict = 'no-inner-grid';
    verdictDetail = 'Neither generated nor twin uses inner-grid.';
  }

  const entry = {
    page: `us/en/${rel.replace('us/en/', '')}`,
    aemPath: `/content/abbvie-com2/${rel}`,
    aemXmlFile: aemXmlPath ? aemXmlPath.replace(__dirname, '.') : null,
    edsXmlFile: edsXmlPath ? edsXmlPath.replace(__dirname, '.') : 'NOT FOUND',
    aemGridCount,
    hasWidthContainerWithGrid,
    generated: {
      innerGridCount: genInnerGrids.length,
      gridContainerCount: genGridContainers.length,
      totalSections: generatedSections.length,
      innerGridDetails: genInnerGrids,
      error: genError,
    },
    twin: twinData || { note: 'EDS twin XML not found' },
    verdict,
    verdictDetail,
  };

  results.push(entry);
  processed++;
  if (processed % 20 === 0) process.stdout.write(`  processed ${processed}/${usenPairs.length}\r`);
}

console.log(`\nProcessed ${processed} pages.\n`);

// ── Summary stats ──────────────────────────────────────────────────────────────
const stats = {
  total: results.length,
  withInnerGrid: results.filter(r => r.generated.innerGridCount > 0).length,
  overInnerGrid: results.filter(r => r.verdict === 'OVER_INNER_GRID').length,
  innerGridNotInTwin: results.filter(r => r.verdict === 'INNER_GRID_NOT_IN_TWIN').length,
  matchInnerGrid: results.filter(r => r.verdict === 'MATCH').length,
  missingInnerGrid: results.filter(r => r.verdict === 'MISSING_INNER_GRID').length,
  noInnerGrid: results.filter(r => r.verdict === 'no-inner-grid').length,
  noEdsXml: results.filter(r => r.edsXmlFile === 'NOT FOUND').length,
  pagesWithWidthContainerGrid: results.filter(r => r.hasWidthContainerWithGrid).length,
};

const output = {
  generated: new Date().toISOString(),
  locale: 'us/en',
  stats,
  // Over-exploitation cases first
  overExploitation: results.filter(r => r.verdict === 'OVER_INNER_GRID'),
  innerGridNotInTwin: results.filter(r => r.verdict === 'INNER_GRID_NOT_IN_TWIN'),
  matched: results.filter(r => r.verdict === 'MATCH'),
  missingInnerGrid: results.filter(r => r.verdict === 'MISSING_INNER_GRID'),
  // Pages where inner-grid IS generated - full detail
  allPagesWithInnerGrid: results.filter(r => r.generated.innerGridCount > 0),
  allResults: results,
};

fs.writeFileSync(
  path.join(__dirname, 'us-en-inner-grid-audit.json'),
  JSON.stringify(output, null, 2)
);

console.log('=== us/en inner-grid audit ===');
console.log(`Total us/en pages:              ${stats.total}`);
console.log(`Pages generating inner-grid:    ${stats.withInnerGrid}`);
console.log(`  → MATCH (twin also has it):   ${stats.matchInnerGrid}`);
console.log(`  → OVER_INNER_GRID (twin uses grid-container instead): ${stats.overInnerGrid}`);
console.log(`  → NOT_IN_TWIN (twin has neither): ${stats.innerGridNotInTwin}`);
console.log(`  → MISSING (twin has it, generated doesn't): ${stats.missingInnerGrid}`);
console.log(`Pages with no inner-grid:       ${stats.noInnerGrid}`);
console.log(`Pages without EDS twin:         ${stats.noEdsXml}`);
console.log(`Pages with width-container+grid: ${stats.pagesWithWidthContainerGrid}`);
console.log('\nReport written to us-en-inner-grid-audit.json');

// Print OVER_INNER_GRID cases for immediate review
if (output.overExploitation.length) {
  console.log('\n=== POTENTIAL OVER-EXPLOITATION (inner-grid where twin uses grid-container) ===');
  for (const r of output.overExploitation) {
    console.log(`  ${r.aemPath}`);
    console.log(`    Gen inner-grids: ${r.generated.innerGridCount}  |  Twin grid-containers: ${r.twin.gridContainers}  |  ${r.verdictDetail}`);
    r.generated.innerGridDetails.forEach(ig => console.log(`      inner-grid classes: ${ig.classes}  parent: ${ig.parentType}`));
  }
}
if (output.innerGridNotInTwin.length) {
  console.log('\n=== INNER-GRID NOT IN TWIN (twin has no grid at all) ===');
  for (const r of output.innerGridNotInTwin) {
    console.log(`  ${r.aemPath}  |  ${r.verdictDetail}`);
  }
}
