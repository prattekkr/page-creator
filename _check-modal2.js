const fs = require('fs');
const s = fs.readFileSync('public/app.js', 'utf8');
const lines = s.split('\n');
function showRange(start, end) { lines.slice(start - 1, end).forEach((l, i) => console.log((start + i) + ': ' + l)); }

// find render() function body
const renderIdx = lines.findIndex(l => l.trim() === 'function render() {');
console.log('render() at line:', renderIdx + 1);
showRange(renderIdx + 1, renderIdx + 80);

// find doCreate
const dcIdx = lines.findIndex(l => l.includes('async function doCreate'));
console.log('\ndoCreate at line:', dcIdx + 1);
showRange(dcIdx + 1, dcIdx + 50);

// find modal HTML rendering (overlay/modal div)
const ovIdx = lines.findIndex(l => l.includes('modal-overlay') || l.includes('class="modal'));
console.log('\nmodal overlay near:', ovIdx + 1);
showRange(Math.max(1, ovIdx - 2), ovIdx + 40);
