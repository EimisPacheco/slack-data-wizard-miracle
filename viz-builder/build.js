#!/usr/bin/env node
/**
 * Natural-language -> deployed Tableau workbook.
 *
 *   node build.js --tables world_perspectives_sample --ask "which countries agree most?"
 *   node build.js --tables hackathon_signups --ask "signups per country" --out ./
 *
 * Needs TSC_PYTHON pointing at a Python with tableauserverclient installed.
 */
import path from 'node:path';
import { loadEnv, buildAndDeploy } from './deploy.js';
import { questionToSpec } from './spec.js';

function args(argv) {
  const a = { tables: [], ask: null, out: null, chartType: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tables') a.tables = argv[++i].split(',').map(s => s.trim());
    else if (argv[i] === '--ask') a.ask = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--chart') a.chartType = argv[++i];
  }
  return a;
}

const a = args(process.argv.slice(2));
if (!a.tables.length || !a.ask) {
  console.error('usage: node build.js --tables t1,t2 --ask "your question" [--out dir] [--chart bar]');
  process.exit(1);
}

const env = loadEnv();

console.log(`🧠 interpreting: "${a.ask}"  over [${a.tables.join(', ')}]`);
const res = await questionToSpec(env, a.tables, a.ask);
if (!res.ok) { console.error(`✋ ${res.reason}`); process.exit(1); }

const spec = res.spec;
if (a.chartType) spec.chartType = a.chartType;   // let the user override the model's choice
spec.sheetName = spec.title || 'Viz';

console.log(`📐 spec: ${spec.chartType} — ${spec.aggregation || ''} ${spec.measure || ''} by ${spec.dimension || spec.geoField || ''}`);

const wbName = `Ask: ${a.ask}`.slice(0, 60);
const r = await buildAndDeploy(spec, { workbookName: wbName, outDir: a.out || process.cwd() });

console.log(`\n✅ deployed`);
console.log(`   workbook : ${r.workbookId}`);
console.log(`   view     : ${r.viewId}`);
console.log(`   image    : ${r.png} (${r.bytes} bytes)`);
console.log(`   open     : ${env.SERVER}/#/site/${env.SITE_NAME}/views/${r.viewId}`.replace(/views\//, 'workbooks/'));
