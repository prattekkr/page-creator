'use strict';
const fs = require('fs');
const has = (xml, cls) => xml.includes('Style_x0020_Class="' + cls + '"');
const check = (name, file, classes) => {
  const xml = fs.readFileSync(file, 'utf8');
  classes.forEach(c => console.log(name + ' has ' + c + ': ' + has(xml, c)));
};
check('section',        './config/section-picklist-config/.content.xml',        ['light-theme', 'dark-theme']);
check('grid-container', './config/grid-container-picklist-config/.content.xml', ['light-theme', 'dark-theme']);
check('story-card',     './config/story-card-picklist-config/.content.xml',     ['hide-image', 'show-image']);
check('teaser',         './config/teaser-picklist-config/.content.xml',         ['hide-image', 'show-image', 'hide-image-show-desc', 'show-image-hide-desc', 'hide-image-hide-desc', 'light-theme-stroke', 'medium-theme', 'medium-theme-stroke']);
check('linklist',       './config/linklist-picklist-config/.content.xml',       ['light-theme', 'dark-theme', 'medium-theme', 'medium-theme-stroke', 'light-theme-stroke']);
check('accordion',      './config/accordion-picklist-config/.content.xml',      ['medium-theme', 'medium-theme-stroke', 'light-theme-stroke']);
