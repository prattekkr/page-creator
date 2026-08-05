const fs = require('fs');
const s = fs.readFileSync('public/app.js', 'utf8');
const lines = s.split('\n');
function showRange(start, end) { lines.slice(start - 1, end).forEach((l, i) => console.log((start + i) + ': ' + l)); }

// Find existing modal handling
const mIdx = lines.findIndex(l => l.includes('block-picker') && l.includes('modal'));
console.log('block-picker modal near:', mIdx + 1);
showRange(Math.max(1, mIdx - 5), mIdx + 30);

// Find btn-create click handler
const cIdx = lines.findIndex(l => l.includes('btn-create') && (l.includes('click') || l.includes('id ===') || l.includes("=== 'btn-create")));
console.log('\nbtn-create click near:', cIdx + 1);
showRange(Math.max(1, cIdx - 3), cIdx + 25);

// Find modal rendering in render()
const rIdx = lines.findIndex(l => l.includes('S.modal') && l.includes('innerHTML'));
console.log('\nmodal render near:', rIdx + 1);
showRange(Math.max(1, rIdx - 10), rIdx + 30);
