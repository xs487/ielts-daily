const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
  .map(match=>match[1]).filter(script=>/window\.IELTSAIPractice\s*=\s*\{/.test(script));
assert.equal(scripts.length,1,'The public build must contain exactly one AI practice module');
module.exports=scripts[0];
