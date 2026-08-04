const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

const parser = new xml2js.Parser();

async function parseXML(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return await parser.parseStringPromise(content);
  } catch (err) {
    return null;
  }
}

function analyzeAEMStructure(aemData) {
  const analysis = {
    hasColorHero: false,
    hasImageHero: false,
    hasVideoHero: false,
    hasGrids: false,
    hasNestedGrids: false,
    containerWithWidthStyle: false,
    containerWithNestedGrid: false,
    topLevelGrids: [],
    nestedGrids: [],
    containers: [],
    sections: 0
  };

  function traverse(node, depth = 0, parentType = 'root') {
    if (!node || typeof node !== 'object') return;

    // Check for containers
    if (node.$?.['sling:resourceType']?.includes('container')) {
      const styleIds = node.$?.['cq:styleIds'] || '';
      const bgColor = node.$?.backgroundColor;
      const bgImage = node.$?.backgroundImageReference;
      
      const containerInfo = {
        depth,
        styleIds,
        hasWidthStyle: /1653545825688|1653545825687|1653545825686/.test(styleIds),
        bgColor,
        bgImage,
        hasGrid: false
      };

      // Check if hero container (depth 1 with background)
      if (depth <= 2 && (bgColor || bgImage)) {
        if (bgColor && bgColor.startsWith('#')) {
          analysis.hasColorHero = true;
        }
        if (bgImage) {
          analysis.hasImageHero = true;
        }
      }

      // Check for grids inside container
      for (const key in node) {
        if (key !== '$' && typeof node[key] === 'object') {
          if (node[key].$?.['sling:resourceType']?.includes('grid')) {
            containerInfo.hasGrid = true;
            analysis.hasGrids = true;
            
            if (containerInfo.hasWidthStyle) {
              analysis.containerWithWidthStyle = true;
              analysis.containerWithNestedGrid = true;
              analysis.nestedGrids.push({
                containerDepth: depth,
                gridType: 'nested',
                hasWidthStyle: true
              });
            }
          }
        }
      }

      analysis.containers.push(containerInfo);
    }

    // Check for grids
    if (node.$?.['sling:resourceType']?.includes('grid')) {
      const gridInfo = {
        depth,
        parentType,
        rowCount: node.$?.rowCount || '1'
      };

      if (depth <= 2) {
        analysis.topLevelGrids.push(gridInfo);
      } else {
        analysis.nestedGrids.push(gridInfo);
        analysis.hasNestedGrids = true;
      }
      analysis.hasGrids = true;
    }

    // Traverse children
    for (const key in node) {
      if (key !== '$' && typeof node[key] === 'object') {
        const childArray = Array.isArray(node[key]) ? node[key] : [node[key]];
        childArray.forEach(child => {
          const childType = child.$?.['sling:resourceType'] || key;
          traverse(child, depth + 1, childType);
        });
      }
    }
  }

  try {
    const root = aemData['jcr:root']?.['jcr:content'];
    if (root) traverse(root);
  } catch (err) {
    console.error('Error analyzing AEM:', err.message);
  }

  return analysis;
}

function analyzeEDSStructure(edsData) {
  const analysis = {
    sections: 0,
    gridContainers: 0,
    gridSections: 0,
    innerGrids: 0,
    innerGridWithCols: [],
    heroType: 'none',
    heroColor: null,
    hasColClasses: false,
    hasNcolClasses: false
  };

  function traverse(node) {
    if (!node || typeof node !== 'object') return;

    const resourceType = node.$?.['sling:resourceType'];
    
    // Count sections
    if (resourceType?.includes('section')) {
      const styleContainer = node.$?.style_container;
      if (styleContainer === 'grid-container') {
        analysis.gridContainers++;
      } else if (styleContainer === 'grid-section') {
        analysis.gridSections++;
      } else {
        analysis.sections++;
      }
    }

    // Check for inner-grids
    if (node.$?.aueComponentId === 'inner-grid' || node.$?.model === 'inner-grid') {
      analysis.innerGrids++;
      const classes = node.$?.classes_customDynamicClass || '';
      if (classes.includes('cols-')) {
        const colMatch = classes.match(/cols-[\d-]+/);
        if (colMatch) {
          analysis.innerGridWithCols.push(colMatch[0]);
        }
      }
    }

    // Check for hero
    if (node.$?.aueComponentId === 'hero-container-item') {
      const bgVariant = node.$?.backgroundVariant;
      if (bgVariant === 'color') {
        analysis.heroType = 'color';
        analysis.heroColor = node.$?.classes_customDynamicClass || '';
      } else if (bgVariant === 'image') {
        analysis.heroType = 'image';
      }
    }

    // Check for col/ncol classes
    const commonClass = node.$?.classes_commonCustomClass || '';
    if (commonClass.includes('col-')) analysis.hasColClasses = true;
    if (commonClass.includes('ncol-')) analysis.hasNcolClasses = true;

    // Traverse children
    for (const key in node) {
      if (key !== '$' && typeof node[key] === 'object') {
        const childArray = Array.isArray(node[key]) ? node[key] : [node[key]];
        childArray.forEach(child => traverse(child));
      }
    }
  }

  try {
    const root = edsData['jcr:root']?.['jcr:content'];
    if (root) traverse(root);
  } catch (err) {
    console.error('Error analyzing EDS:', err.message);
  }

  return analysis;
}

async function comparePair(pagePath) {
  const aemPath = path.join('content-xml', pagePath, '.content.xml');
  const edsPath = path.join('eds-xml', pagePath, '.content.xml');

  if (!fs.existsSync(aemPath) || !fs.existsSync(edsPath)) {
    return null;
  }

  const aemData = await parseXML(aemPath);
  const edsData = await parseXML(edsPath);

  if (!aemData || !edsData) return null;

  const aemAnalysis = analyzeAEMStructure(aemData);
  const edsAnalysis = analyzeEDSStructure(edsData);

  return {
    path: pagePath,
    aem: aemAnalysis,
    eds: edsAnalysis,
    match: {
      heroTypeMatches: (
        (aemAnalysis.hasColorHero && edsAnalysis.heroType === 'color') ||
        (aemAnalysis.hasImageHero && edsAnalysis.heroType === 'image') ||
        (!aemAnalysis.hasColorHero && !aemAnalysis.hasImageHero)
      ),
      expectedInnerGrid: aemAnalysis.containerWithNestedGrid,
      hasInnerGrid: edsAnalysis.innerGrids > 0,
      innerGridMatches: aemAnalysis.containerWithNestedGrid === (edsAnalysis.innerGrids > 0),
      expectedGridContainer: aemAnalysis.topLevelGrids.length > 0,
      hasGridContainer: edsAnalysis.gridContainers > 0,
      gridContainerMatches: (aemAnalysis.topLevelGrids.length > 0) === (edsAnalysis.gridContainers > 0)
    }
  };
}

async function main() {
  const pairs = JSON.parse(fs.readFileSync('page-pairs.json', 'utf8'));
  const results = [];
  
  console.log(`Analyzing ${pairs.length} page pairs...\n`);
  
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (i % 10 === 0) {
      console.log(`Progress: ${i}/${pairs.length}...`);
    }
    
    const result = await comparePair(pair);
    if (result) {
      results.push(result);
    }
  }

  // Summary statistics
  const summary = {
    total: results.length,
    innerGridMismatches: results.filter(r => !r.match.innerGridMatches).length,
    gridContainerMismatches: results.filter(r => !r.match.gridContainerMatches).length,
    heroMismatches: results.filter(r => !r.match.heroTypeMatches).length,
    pagesNeedingInnerGrid: results.filter(r => r.match.expectedInnerGrid && !r.match.hasInnerGrid).length,
    pagesWithInnerGrid: results.filter(r => r.eds.innerGrids > 0).length
  };

  fs.writeFileSync('comparison-results.json', JSON.stringify(results, null, 2));
  fs.writeFileSync('comparison-summary.json', JSON.stringify(summary, null, 2));

  console.log('\n=== SUMMARY ===');
  console.log(`Total pages analyzed: ${summary.total}`);
  console.log(`Inner-grid mismatches: ${summary.innerGridMismatches}`);
  console.log(`Grid-container mismatches: ${summary.gridContainerMismatches}`);
  console.log(`Hero type mismatches: ${summary.heroMismatches}`);
  console.log(`Pages needing inner-grid: ${summary.pagesNeedingInnerGrid}`);
  console.log(`Pages with inner-grid: ${summary.pagesWithInnerGrid}`);
  console.log('\nDetailed results saved to comparison-results.json');
}

main().catch(console.error);
