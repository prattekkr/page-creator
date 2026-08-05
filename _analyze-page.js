'use strict';
// Analyze the inner-grid triggering structure for:
// ch/de/who-we-are/our-stories/abbvie-offered-first-aid-refresher-training
//
// From the XML we can see the structure directly:
//
// TOP LEVEL (after XF chrome stripped):
//   container1  → hero (backgroundImageReference) → hero section
//   container2  → plain container (backgroundColor=#FFFFFF, no grid) → overlapsHero? Yes (styleIds include overlap)
//   grid        → outer grid cols-2-8-2 (3 columns)
//
// The outer GRID (cols-2-8-2) is a top-level grid. It generates a grid-container.
// par_12 (column 2, width=8) contains:
//   container4  (cq:styleIds includes 1653545825687 = container-large → WIDTH STYLE)
//     → inside container4:
//         text2, separator_1894724708,
//         grid (nested grid cols-7-4 inside container4 inside par_12)
//         title2_copy, text, separator, title2_copy_copy, text_copy
//   image (collage)
//   separator_copy
//
// So the inner-grid is triggered by:
//   Scenario: "container with width style (container-large = 1653545825687) inside a grid cell parsys"
//   → collectCellLeaves() is called for par_12
//   → inside par_12 we find container4 which has WIDTH styleId 1653545825687 (container-large)
//   → container4 has a nested grid (cols-7-4)
//   → cols-7-4 has 2 columns → NOT cols-12 → hasMultiColGrid = TRUE
//   → Therefore: emits inner-grid{cols-12,width-large} controller + col-1 blocks
//
// This IS the correct behaviour:
//   container4 (container-large) wraps a 2-column grid (7+4 = 11 col grid)
//   EDS represents this as an inner-grid section with cols-12,width-large
//   where the col-1 blocks are the content blocks inside container4

console.log('=== Inner-grid trigger analysis ===');
console.log('');
console.log('AEM structure causing inner-grid:');
console.log('');
console.log('grid (cols-2-8-2) [top-level grid → grid-container]');
console.log('  par_11 [col width=2] → empty');
console.log('  par_12 [col width=8] → collectCellLeaves() called here');
console.log('    container4 [cq:styleIds: 1653545825687 = container-large ← WIDTH STYLE]');
console.log('      text2');
console.log('      separator (24px)');
console.log('      grid [cols-7-4] ← nested grid with 2 columns (NOT cols-12)');
console.log('        par_11 [col=7]: image, text');
console.log('        par_12 [col=4]: empty');
console.log('      title2_copy, text, separator, title2_copy_copy, text_copy');
console.log('    image (collage)');
console.log('    separator_copy (64px)');
console.log('');
console.log('Trigger rule hit:');
console.log('  containerHasWidthStyle(container4) = TRUE  [styleId 1653545825687 = container-large]');
console.log('  hasMultiColGrid scan → finds grid cols-7-4 (2 columns, neither is 12)');
console.log('  → cols.length=2 > 1 → hasMultiColGrid = TRUE');
console.log('  → emits inner-grid controller: cols-12,width-large');
console.log('  → all container4 content gets col-1 class');
console.log('');
console.log('Scenario: Scenario 3 — "width-style container INSIDE a parsys cell"');
console.log('  (container4 is inside par_12 of the outer cols-2-8-2 grid)');
console.log('  The nested grid inside container4 is genuinely multi-column (cols-7-4)');
console.log('  → inner-grid IS correct here');
console.log('');
console.log('If the EDS twin does NOT have an inner-grid here, this is a false positive.');
console.log('The nested grid (7+4=11) suggests it IS a multi-column layout in AEM.');
