import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { percentile } from "./statistics.js";

function roundSummary(record) {
  const resources = record.resources ?? {};
  return {
    round: record.round,
    observationsAdded: record.observationsAdded,
    cumulativeObservations: record.cumulativeObservations,
    triplesAdded: record.triplesAdded,
    cumulativeTriples: record.cumulativeTriples,
    expectedAverage: record.expectedAverage,
    pushMs: record.pushMs,
    propagationMs: record.propagationMs,
    endToEndMs: record.endToEndMs,
    endToEndLowerBoundMs: record.endToEndLowerBoundMs,
    metricsPolls: record.metricsPolls,
    distributionRequestMs: record.distributionRequestMs,
    peakRssMiB: resources.peakRssBytes / 1024 / 1024,
    peakHeapMiB: resources.peakHeapUsedBytes / 1024 / 1024,
    cpuSeconds: ((resources.cpuUserMicros ?? 0) + (resources.cpuSystemMicros ?? 0)) / 1e6,
    eventLoopDelayMs: resources.peakEventLoopDelayMs,
  };
}

export async function readRun(runFile, options = {}) {
  const input = readline.createInterface({
    input: createReadStream(runFile),
    crlfDelay: Infinity,
  });
  let startup;
  let failure;
  let year;
  const rounds = [];
  let lineNumber = 0;
  for await (const line of input) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch (error) {
      throw new Error(`Invalid JSON on line ${lineNumber} of ${runFile}: ${error.message}`);
    }
    if (record.type === "startup") startup = record;
    else if (record.type === "round") rounds.push(roundSummary(record));
    else if (record.type === "failure") failure = record;
    else if (record.type === "year") year = record;
  }
  if (!startup && !options.allowPartial) throw new Error(`Run has no startup record: ${runFile}`);
  return { startup, rounds, failure, year };
}

function failureSummary(errorText) {
  if (!errorText?.trim()) return undefined;
  const oom = /heap out of memory|allocation failed/i.test(errorText);
  const heapMatches = [...errorText.matchAll(/\((\d+(?:\.\d+)?)\)\s*MB/g)].map((match) => Number(match[1]));
  return {
    kind: oom ? "JavaScript heap out of memory" : "Run error",
    heapLimitMiB: heapMatches.length ? Math.max(...heapMatches) : undefined,
    detail: errorText.trim().split(/\r?\n/).filter(Boolean).slice(-12).join("\n"),
  };
}

function median(values) {
  return percentile(values.filter(Number.isFinite).sort((a, b) => a - b), 0.5);
}

function reportModel(runFile, startup, rounds, failure) {
  const finalRound = rounds.at(-1);
  const propagation = rounds.map((round) => round.propagationMs);
  return {
    title: path.basename(runFile),
    generatedAt: new Date().toISOString(),
    startup: {
      podCount: startup.podCount,
      initialObservations: startup.initialObservations,
      initialTriples: startup.initialTriples,
      benchmarkWaitMs: startup.benchmarkWaitMs,
      observedServiceUptimeMs: startup.observedServiceUptimeMs,
      peakRssMiB: startup.resources?.peakRssBytes / 1024 / 1024,
      peakHeapMiB: startup.resources?.peakHeapUsedBytes / 1024 / 1024,
      cpuSeconds: ((startup.resources?.cpuUserMicros ?? 0) + (startup.resources?.cpuSystemMicros ?? 0)) / 1e6,
    },
    summary: {
      completedRounds: rounds.length,
      finalObservations: finalRound?.cumulativeObservations ?? startup.initialObservations,
      finalTriples: finalRound?.cumulativeTriples ?? startup.initialTriples,
      peakRssMiB: Math.max(startup.resources?.peakRssBytes / 1024 / 1024 || 0, ...rounds.map((round) => round.peakRssMiB)),
      peakHeapMiB: Math.max(startup.resources?.peakHeapUsedBytes / 1024 / 1024 || 0, ...rounds.map((round) => round.peakHeapMiB)),
      medianPropagationMs: median(propagation),
      worstPropagationMs: propagation.length ? Math.max(...propagation) : undefined,
    },
    failure,
    rounds,
  };
}

function htmlDocument(model) {
  const data = JSON.stringify(model).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${model.title} — PACSOI run report</title>
<style>
:root { color-scheme: dark; --bg:#0b1020; --panel:#141b2d; --grid:#2b3653; --text:#e7ecf5; --muted:#9facbf; --blue:#62a8ff; --green:#55d69e; --orange:#ffb454; --red:#ff6b7a; --purple:#b69cff; }
* { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 system-ui,sans-serif }
main { width:min(1700px,96vw); margin:28px auto 60px } h1 { margin:0 0 4px; font-size:26px } h2 { font-size:20px; margin:0 0 6px }
.muted { color:var(--muted) }.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; margin:20px 0 }
.card,.panel,.failure { background:var(--panel); border:1px solid var(--grid); border-radius:10px; padding:14px }.card .value { font-size:23px; font-weight:700; margin-top:5px }
.charts { display:grid; grid-template-columns:1fr; gap:18px }.chart { min-height:560px; padding:20px }.chart svg { width:100%; height:460px; overflow:visible }
.chart-description { color:var(--muted); font-size:14px; margin:0 0 12px; max-width:1100px }.chart-description strong { color:var(--text) }
.legend { display:flex; flex-wrap:wrap; gap:12px; margin-top:5px }.legend span::before { content:""; display:inline-block; width:9px; height:9px; margin-right:5px; border-radius:50%; background:var(--color) }
.failure { border-color:#7b3340; background:#2a151d; margin-bottom:12px }.failure strong { color:#ff9aa5 }.failure pre { overflow:auto; color:#ffd0d5; white-space:pre-wrap }
.table-panel { margin-top:12px; overflow:auto } table { width:100%; border-collapse:collapse; white-space:nowrap } th,td { padding:8px 10px; border-bottom:1px solid var(--grid); text-align:right }
th { cursor:pointer; color:#bed0eb; position:sticky; top:0; background:var(--panel) } th:first-child,td:first-child,td:last-child { text-align:left }
.axis { stroke:var(--grid); stroke-width:1 }.axis-text { fill:var(--muted); font-size:12px }.axis-label { fill:var(--muted); font-size:13px }.line { fill:none; stroke-width:2.5 }.dot { stroke:var(--panel); stroke-width:1.5 }
@media(max-width:600px){.chart{min-height:440px;padding:12px}.chart svg{height:350px}.axis-text{font-size:10px}}
</style>
</head>
<body><main>
<h1>PACSOI run report</h1><div class="muted" id="subtitle"></div>
<div id="failure"></div><section class="cards" id="cards"></section>
<section class="charts" id="charts"></section>
<section class="panel table-panel"><h2>Round details</h2><table id="rounds"></table></section>
</main>
<script>
const report=${data};
const colors=['var(--blue)','var(--green)','var(--orange)','var(--red)','var(--purple)'];
const fmt=(value,digits=1)=>Number.isFinite(value)?value.toLocaleString(undefined,{maximumFractionDigits:digits}):'—';
const duration=value=>value>=1000?fmt(value/1000,2)+' s':fmt(value,1)+' ms';
document.querySelector('#subtitle').textContent=report.title+' · generated '+new Date(report.generatedAt).toLocaleString();
const cards=[
 ['Pods',fmt(report.startup.podCount,0)],['Completed rounds',fmt(report.summary.completedRounds,0)],
 ['Initial observations',fmt(report.startup.initialObservations,0)],['Final observations',fmt(report.summary.finalObservations,0)],
 ['Initial triples',fmt(report.startup.initialTriples,0)],['Final triples',fmt(report.summary.finalTriples,0)],
 ['Peak RSS',fmt(report.summary.peakRssMiB/1024,2)+' GiB'],['Peak heap',fmt(report.summary.peakHeapMiB/1024,2)+' GiB'],
 ['Median propagation',duration(report.summary.medianPropagationMs)],['Worst propagation',duration(report.summary.worstPropagationMs)]
];
document.querySelector('#cards').innerHTML=cards.map(([label,value])=>'<div class="card"><div class="muted">'+label+'</div><div class="value">'+value+'</div></div>').join('');
if(report.failure){document.querySelector('#failure').innerHTML='<div class="failure"><strong>'+report.failure.kind+'</strong>'+(report.failure.heapLimitMiB?'<div>Detected heap limit: '+fmt(report.failure.heapLimitMiB/1024,2)+' GiB</div>':'')+'<pre>'+escapeHtml(report.failure.detail)+'</pre></div>'}
function escapeHtml(value){const node=document.createElement('div');node.textContent=value;return node.innerHTML}
function chart(title,description,series,yFormat=fmt,options={}){
 const rows=report.rounds,W=1200,H=455,m={l:90,r:28,t:18,b:55}; const values=series.flatMap(s=>rows.map(s.value)).filter(Number.isFinite); if(!values.length)values.push(0);
 let min=options.zeroBase===false?Math.min(...values):Math.min(0,...values),max=Math.max(1,...values);
 if(options.zeroBase===false&&Number.isFinite(min)){const padding=Math.max((max-min)*.08,Math.abs(max)*.01);min-=padding;max+=padding} if(max===min)max=min+1;
 const x=i=>m.l+(rows.length<2?(W-m.l-m.r)/2:(i/(rows.length-1))*(W-m.l-m.r)); const y=v=>H-m.b-((v-min)/(max-min))*(H-m.t-m.b);
 let svg='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+title+'">';
 for(let i=0;i<=6;i++){const yy=m.t+i*(H-m.t-m.b)/6,val=max-i*(max-min)/6;svg+='<line class="axis" x1="'+m.l+'" y1="'+yy+'" x2="'+(W-m.r)+'" y2="'+yy+'"/><text class="axis-text" x="'+(m.l-10)+'" y="'+(yy+4)+'" text-anchor="end">'+yFormat(val)+'</text>'}
 if(rows.length){const ticks=Math.min(10,rows.length);for(let i=0;i<ticks;i++){const index=Math.round(i*(rows.length-1)/Math.max(1,ticks-1)),xx=x(index);svg+='<line class="axis" x1="'+xx+'" y1="'+m.t+'" x2="'+xx+'" y2="'+(H-m.b)+'"/><text class="axis-text" x="'+xx+'" y="'+(H-m.b+22)+'" text-anchor="middle">'+rows[index].round+'</text>'}svg+='<text class="axis-label" x="'+((m.l+W-m.r)/2)+'" y="'+(H-7)+'" text-anchor="middle">Round</text>'}
 series.forEach((s,index)=>{const points=rows.map((row,i)=>({x:x(i),y:y(s.value(row)),value:s.value(row),round:row.round})).filter(p=>Number.isFinite(p.y));svg+='<polyline class="line" stroke="'+colors[index]+'" points="'+points.map(p=>p.x+','+p.y).join(' ')+'"/>';svg+=points.map(p=>'<circle class="dot" fill="'+colors[index]+'" cx="'+p.x+'" cy="'+p.y+'" r="3.5"><title>'+s.name+' — round '+p.round+': '+yFormat(p.value)+'</title></circle>').join('')});
 svg+='</svg>';return '<article class="panel chart"><h2>'+title+'</h2><p class="chart-description">'+description+'</p>'+svg+'<div class="legend">'+series.map((s,i)=>'<span style="--color:'+colors[i]+'">'+s.name+' (latest: '+(rows.length?yFormat(s.value(rows.at(-1))):'—')+')</span>').join('')+'</div></article>';
}
const heapSeries=[{name:'RSS MiB',value:r=>r.peakRssMiB},{name:'Heap MiB',value:r=>r.peakHeapMiB}];
if(report.failure?.heapLimitMiB)heapSeries.push({name:'Detected heap limit',value:()=>report.failure.heapLimitMiB});
document.querySelector('#charts').innerHTML=[
 chart('Daily latency','<strong>What it shows:</strong> for each day, the time for the mock to push one observation to every pod, the time from that push until the complete correct distribution appeared, the combined end-to-end duration, and its lower bound. <strong>How to read it:</strong> the true moment the service became correct lies between the lower bound and the end-to-end line; growth over the days shows the cost of accumulated state.',[{name:'Push',value:r=>r.pushMs},{name:'Propagation',value:r=>r.propagationMs},{name:'End to end',value:r=>r.endToEndMs},{name:'Lower bound',value:r=>r.endToEndLowerBoundMs}],duration),
 chart('Memory','<strong>What it shows:</strong> the service process resident memory (RSS), JavaScript heap, and the detected V8 heap ceiling when an OOM log is supplied. <strong>How to read it:</strong> sustained growth across rounds indicates retained state; heap approaching the limit predicts heavy garbage collection and eventual failure.',heapSeries,v=>fmt(v/1024,2)+' GiB',{zeroBase:false}),
 chart('CPU per round','<strong>What it shows:</strong> user plus system CPU consumed by the service during each measured round. <strong>How to read it:</strong> compare spikes with latency and event-loop delay; high CPU usually means query processing or garbage collection is delaying convergence.',[{name:'CPU seconds',value:r=>r.cpuSeconds}],v=>fmt(v,1)+' s'),
 chart('Event-loop pressure','<strong>What it shows:</strong> the longest delay of the service's Node.js event loop during the day. <strong>How to read it:</strong> low values mean the service remains responsive; large spikes mean CPU work or garbage collection prevented timely processing of network events.',[{name:'Max delay',value:r=>r.eventLoopDelayMs}],duration),
 chart('Cumulative workload','<strong>What it shows:</strong> the total number of observations the service must retain and aggregate after every round. <strong>How to read it:</strong> use this as the dataset-size axis when identifying the observation count where memory or latency begins to degrade.',[{name:'Cumulative observations',value:r=>r.cumulativeObservations}],v=>fmt(v,0)),
 chart('RDF triples','<strong>What it shows:</strong> the cumulative RDF triple workload represented by all procedures, observations, and result nodes. <strong>How to read it:</strong> use triples as the implementation-independent dataset-size axis when comparing experiments.',[{name:'Cumulative triples',value:r=>r.cumulativeTriples},{name:'Added this round',value:r=>r.triplesAdded}],v=>fmt(v,0)),
 chart('Distribution request cost','<strong>What it shows:</strong> how long the /w-dist request that confirmed each day took. <strong>How to read it:</strong> the service sorts every stored value per request, so this grows with the data and is load the benchmark itself adds.',[{name:'/w-dist duration',value:r=>r.distributionRequestMs}],duration)
].join('');
const columns=[['round','Round'],['observationsAdded','Added'],['cumulativeObservations','Cumulative'],['triplesAdded','Triples added'],['cumulativeTriples','Triples total'],['pushMs','Push ms'],['propagationMs','Propagation ms'],['endToEndMs','End-to-end ms'],['endToEndLowerBoundMs','Lower bound ms'],['distributionRequestMs','/w-dist ms'],['peakRssMiB','RSS MiB'],['peakHeapMiB','Heap MiB'],['cpuSeconds','CPU s'],['eventLoopDelayMs','Max event-loop delay ms']];
let direction=1;function renderTable(key='round'){const rows=[...report.rounds].sort((a,b)=>{const av=a[key],bv=b[key];return typeof av==='string'?direction*av.localeCompare(bv):direction*((av??-Infinity)-(bv??-Infinity))});document.querySelector('#rounds').innerHTML='<thead><tr>'+columns.map(([k,l])=>'<th data-key="'+k+'">'+l+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+columns.map(([key])=>'<td>'+fmtCell(key,row[key])+'</td>').join('')+'</tr>').join('')+'</tbody>';document.querySelectorAll('th').forEach(th=>th.onclick=()=>{direction=th.dataset.key===key?-direction:1;renderTable(th.dataset.key)})}
function fmtCell(key,value){if(['round','observationsAdded','cumulativeObservations','triplesAdded','cumulativeTriples'].includes(key))return fmt(value,0);return fmt(value,2)}renderTable();
</script></body></html>`;
}

export async function generateRunReport(runFile, options = {}) {
  const resolvedRun = path.resolve(runFile);
  const { startup, rounds } = await readRun(resolvedRun);
  let errorText;
  if (options.errorFile) errorText = await fs.readFile(path.resolve(options.errorFile), "utf8");
  const failure = failureSummary(errorText);
  const output = path.resolve(options.output ?? resolvedRun.replace(/\.ndjson$/i, "-report.html"));
  await fs.writeFile(output, htmlDocument(reportModel(resolvedRun, startup, rounds, failure)));
  return { output, rounds: rounds.length, failure: failure?.kind };
}
