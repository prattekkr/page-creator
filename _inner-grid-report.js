const fs = require('fs');
const path = require('path');

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
const WIDTH_ID_LABEL = {
  '1653545825684': 'container-xxx-large',
  '1653545825685': 'container-xx-large',
  '1653545825686': 'container-x-large',
  '1653545825687': 'container-large',
  '1653545825688': 'container-medium',
  '1653545825689': 'container-small',
  '1653545825690': 'container-x-small',
  '1653545825692': 'container-xxx-small',
};

function findFiles(dir, results = []) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) findFiles(full, results);
      else if (e.name.endsWith('.xml')) results.push(full);
    }
  } catch {}
  return results;
}

const xmlFiles = findFiles(path.join(__dirname, 'content-xml'));
console.log(`Scanning ${xmlFiles.length} XML files...\n`);

const s1 = [], s2 = [], s3 = [], s4 = [];
const MAX = 5;

function getAemPath(f) {
  const rel = f.replace(path.join(__dirname, 'content-xml'), '').replace(/\\/g, '/');
  // Remove the filename (e.g. /jcr_content.xml) to get the page path
  return '/content/abbvie-com2' + rel.replace(/\/[^/]+\.xml$/, '');
}

function extractNodeName(txt, index) {
  // get the element name that starts at index
  const match = txt.slice(index).match(/^<(\w+)/);
  return match ? match[1] : 'unknown';
}

function getContainerNodePath(txt, containerIndex) {
  // Walk backwards to build the JCR node path
  // Find all ancestor open tags
  const before = txt.slice(0, containerIndex);
  const nodeName = extractNodeName(txt, containerIndex);
  // Simple heuristic: find last few open tag names before this point
  const tagStack = [];
  const tagRe = /<(\w+)[\s>]/g;
  const closeRe = /<\/(\w+)>/g;
  // Use a simplified approach: just find nearest ancestor container/grid names
  const ancestors = [];
  let pos = 0;
  const allTags = [...before.matchAll(/<(\w+)[\s>]/g)];
  const allClose = [...before.matchAll(/<\/(\w+)>/g)];
  // Simple stack
  const stack = [];
  let bi = 0, ci = 0;
  for (let i = 0; i < allTags.length; i++) {
    const t = allTags[i];
    // Check if self-closing (ends with />)
    const snippet = txt.slice(t.index, t.index + 200);
    const selfClose = /^<[^>]+\/>/.test(snippet);
    if (!selfClose) stack.push(t[1]);
    // Remove closed tags
    while (ci < allClose.length && allClose[ci].index < (allTags[i + 1] ? allTags[i + 1].index : containerIndex)) {
      const closed = allClose[ci][1];
      const si = stack.lastIndexOf(closed);
      if (si >= 0) stack.splice(si, 1);
      ci++;
    }
  }
  return '/' + [...stack.slice(-5), nodeName].join('/');
}

for (const f of xmlFiles) {
  try {
    const txt = fs.readFileSync(f, 'utf8');
    const aemPath = getAemPath(f);

    // ── Find all container nodes with width styleIds ──────────────────────
    const containerRe = /<(\w+)\s[^/]*?sling:resourceType="abbvie-com2\/components\/container\/v2\/container"[^>]*>/g;
    const gridRe = /sling:resourceType="abbvie-com2\/components\/grid\/v2\/grid"/g;

    const containerMatches = [...txt.matchAll(containerRe)];
    const gridMatches = [...txt.matchAll(gridRe)];

    // ── Scenario 4: hero (backgroundImageReference) + width container + grid
    // overlap-predecessor is a styleId-mapped CSS class, NOT a literal string in XML.
    // So we detect S4 by: file has backgroundImageReference + has width-style container + has grid.
    // The hero container itself does NOT have a grid; the width container is a sibling/descendant.
    if (s4.length < MAX && txt.includes('backgroundImageReference')) {
      for (const m of containerMatches) {
        const tagEnd2 = txt.indexOf('>', m.index);
        const tagText2 = txt.slice(m.index, tagEnd2 + 1);
        const sm2 = tagText2.match(/cq:styleIds="\[([^\]]+)\]"/);
        if (!sm2) continue;
        const ids2 = sm2[1].split(',').map(s => s.trim().replace(/"/g, ''));
        const mid2 = ids2.find(id => WIDTH_STYLE_IDS.has(id));
        if (!mid2) continue;
        // The hero container itself has backgroundImageReference but no grid.
        // The width-style container must NOT have backgroundImageReference in its own tag.
        const tagHasBg = tagText2.includes('backgroundImageReference');
        if (tagHasBg) continue;
        const after2 = txt.slice(m.index, m.index + 8000);
        if (!/sling:resourceType="abbvie-com2\/components\/grid\/v2\/grid"/.test(after2)) continue;
        // Confirm there IS a hero container earlier in the file
        const heroContainerBefore = txt.slice(0, m.index).includes('backgroundImageReference');
        if (!heroContainerBefore) continue;
        s4.push({
          aemPage: aemPath,
          xmlFile: f.replace(__dirname, '.'),
          containerNode: m[1],
          widthClass: WIDTH_ID_LABEL[mid2],
          note: `Container '${m[1]}' (${WIDTH_ID_LABEL[mid2]}) appears after hero container (backgroundImageReference) and contains a grid → emits inner-grid in the hero continuation body section`,
        });
        break;
      }
    }

    // ── Scenario 2: multiple grids in the same file (nested grids) ────────
    if (gridMatches.length >= 2 && s2.length < MAX) {
      // Find a par_ node that contains another grid
      const parGridRe = /<(par_\d+\d+)[^>]*>([\s\S]{0,3000}?)sling:resourceType="abbvie-com2\/components\/grid\/v2\/grid"/g;
      const parGridMatch = parGridRe.exec(txt);
      if (parGridMatch) {
        s2.push({
          aemPage: aemPath,
          xmlFile: f.replace(__dirname, '.'),
          parNode: parGridMatch[1],
          gridCount: gridMatches.length,
          note: `Cell '${parGridMatch[1]}' contains an inner grid. Total grids in page: ${gridMatches.length}`,
        });
      }
    }

    for (const m of containerMatches) {
      // Extract styleIds from the tag itself (multi-line safe)
      const tagEnd = txt.indexOf('>', m.index);
      const tagText = txt.slice(m.index, tagEnd + 1);
      const styleMatch = tagText.match(/cq:styleIds="\[([^\]]+)\]"/);
      if (!styleMatch) continue;

      const ids = styleMatch[1].split(',').map(s => s.trim().replace(/"/g, ''));
      const matchedId = ids.find(id => WIDTH_STYLE_IDS.has(id));
      if (!matchedId) continue;

      const widthClass = WIDTH_ID_LABEL[matchedId];
      const nodeName = m[1];

      // Does this container contain a grid somewhere after it?
      const afterContainer = txt.slice(m.index, m.index + 8000);
      const hasGrid = /sling:resourceType="abbvie-com2\/components\/grid\/v2\/grid"/.test(afterContainer);
      if (!hasGrid) continue;

      // Is this container itself inside a par_ cell?
      const before = txt.slice(0, m.index);
      // Look for nearest par_ ancestor tag
      const parAncestorMatch = [...before.matchAll(/<(par_\d+\d+)/g)].pop();
      const insidePar = !!parAncestorMatch;

      // Is this inside a hero overlap context? (backgroundImageReference + overlap class)
      const hasHeroBg = txt.includes('backgroundImageReference');
      const hasOverlap = txt.includes('overlap-predecessor') || txt.includes('homepage-overlap');
      const heroContext = hasHeroBg && hasOverlap;

      if (heroContext && s4.length < MAX) {
        s4.push({
          aemPage: aemPath,
          xmlFile: f.replace(__dirname, '.'),
          containerNode: nodeName,
          widthClass,
          note: `Container '${nodeName}' (${widthClass}) inside hero-overlap context contains a grid → emits inner-grid in hero continuation body section`,
        });
      } else if (insidePar && s3.length < MAX) {
        s3.push({
          aemPage: aemPath,
          xmlFile: f.replace(__dirname, '.'),
          containerNode: nodeName,
          widthClass,
          parCell: parAncestorMatch ? parAncestorMatch[1] : 'unknown',
          note: `Container '${nodeName}' (${widthClass}) inside parsys cell '${parAncestorMatch ? parAncestorMatch[1] : '?'}' contains a grid → emits cols-12,${widthClass} inner-grid in that cell`,
        });
      } else if (!insidePar && !heroContext && s1.length < MAX) {
        s1.push({
          aemPage: aemPath,
          xmlFile: f.replace(__dirname, '.'),
          containerNode: nodeName,
          widthClass,
          note: `Top-level container '${nodeName}' (${widthClass}) contains a grid → page becomes a section with inner-grid blocks`,
        });
      }

      if (s1.length >= MAX && s3.length >= MAX && s4.length >= MAX) break;
    }

    if (s1.length >= MAX && s2.length >= MAX && s3.length >= MAX && s4.length >= MAX) break;

  } catch (e) {
    // skip unreadable files
  }
}

// ── Build report ──────────────────────────────────────────────────────────────
const report = {
  generated: new Date().toISOString(),
  summary: {
    scenario1_topLevelWidthContainerWithGrid: s1.length,
    scenario2_nestedGridInsideParsysCell: s2.length,
    scenario3_widthContainerInsideParsysCell: s3.length,
    scenario4_heroContinuationBodyWithWidthContainerAndGrid: s4.length,
  },
  scenarios: {
    scenario1: {
      title: 'Top-level container with width style + nested grid',
      description: 'An AEM container with a container-* width styleId that contains any grid anywhere in its subtree. Triggers collectCellLeaves() at emitNode() level. The whole container becomes a plain section; each grid inside becomes an inner-grid controller with col-N blocks.',
      edsBehaviour: 'section → [inner-grid {cols-X-Y,...widthClass}, block{col-1}, block{col-2}, ...]',
      examples: s1,
    },
    scenario2: {
      title: 'Grid inside a parsys cell (nested inner-grid)',
      description: 'A par_RC parsys node inside one grid that itself contains another AEM grid. collectCellLeaves() encounters isGrid() → calls emitInnerGrid(). Depth > 0 means column classes become ncol-N instead of col-N.',
      edsBehaviour: 'grid-section { children: [inner-grid {cols-X-Y}, block{ncol-1}, block{ncol-2}] }',
      examples: s2,
    },
    scenario3: {
      title: 'Width-style container inside a parsys cell',
      description: 'A container-* node found inside a par_RC parsys cell. collectCellLeaves() sees isContainer(rt) + containerHasWidthStyle() → emits a cols-12,widthClass inner-grid controller. All container content becomes col-1 blocks.',
      edsBehaviour: 'grid-section { children: [inner-grid {cols-12,widthClass,col-1}, block{col-1}, ...] }',
      examples: s3,
    },
    scenario4: {
      title: 'Hero continuation body: width-style container + grid',
      description: 'After a hero image container + overlap container merge, the body nodes may include a container-* with a grid. emitHeroContinuationSections() / hero body group logic emits a cols-12,widthClass inner-grid before calling collectCellLeaves() with col-1 assignment.',
      edsBehaviour: 'section (after hero) → [inner-grid {cols-12,widthClass}, block{col-1}, ...]',
      examples: s4,
    },
  },
};

fs.writeFileSync(path.join(__dirname, 'inner-grid-report.json'), JSON.stringify(report, null, 2));
console.log('Report written to inner-grid-report.json');
console.log('\nScenario counts:');
console.log('  S1 (top-level width+grid):', s1.length);
console.log('  S2 (nested grid in par_):', s2.length);
console.log('  S3 (width container in par_):', s3.length);
console.log('  S4 (hero continuation):', s4.length);
