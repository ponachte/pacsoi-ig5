import fs from "node:fs/promises";
import path from "node:path";

function document(summary) {
  const data = JSON.stringify(summary).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PACSOI experiment report</title>
<style>
:root{color-scheme:dark;--bg:#0b1020;--panel:#141b2d;--grid:#2b3653;--text:#e7ecf5;--muted:#9facbf;--blue:#62a8ff;--green:#55d69e;--orange:#ffb454;--red:#ff6b7a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}main{width:min(1600px,96vw);margin:28px auto 60px}h1{margin:0 0 4px}.muted{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin:20px 0}.card,.panel{background:var(--panel);border:1px solid var(--grid);border-radius:10px;padding:14px}.value{font-size:22px;font-weight:700;margin-top:5px}.chart{margin:14px 0}.chart svg{width:100%;height:430px}.axis{stroke:var(--grid)}.axis-text{fill:var(--muted);font-size:12px}.line{fill:none;stroke-width:2.5}.band{opacity:.16}.legend{display:flex;gap:18px;flex-wrap:wrap}.legend span:before{content:"";display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--color);margin-right:5px}.warnings{border-color:#795b24;background:#2a2214;margin:14px 0}.table-panel{overflow:auto}table{width:100%;border-collapse:collapse;white-space:nowrap}th,td{padding:8px 10px;border-bottom:1px solid var(--grid);text-align:right}th:first-child,td:first-child{text-align:left}code{color:#bed0eb}
</style></head><body><main>
<h1>PACSOI repeated-experiment report</h1><div class="muted" id="subtitle"></div>
<section class="cards" id="cards"></section><section id="warnings"></section><section id="failures"></section>
<section class="panel chart"><h2>Median round latency with bootstrap confidence intervals</h2><p class="muted">Lines show p50 across all attempts that completed each round. Shaded bands show the configured bootstrap confidence interval. Each round is analyzed independently; declining sample size indicates attempts that failed or ran out of memory.</p><div id="latency-chart"></div></section>
<section class="panel table-panel"><h2>Round latency and workload</h2><table id="rounds"></table></section>
</main><script>
const report=${data};
const fmt=(v,d=1)=>Number.isFinite(v)?v.toLocaleString(undefined,{maximumFractionDigits:d}):'—';
const duration=v=>Number.isFinite(v)?(v>=1000?fmt(v/1000,2)+' s':fmt(v,1)+' ms'):'—';
const pct=v=>Number.isFinite(v)?fmt(v*100,2)+'%':'—';
const escapeHtml=value=>{const node=document.createElement('div');node.textContent=String(value??'');return node.innerHTML};
document.querySelector('#subtitle').textContent=report.status+' · '+report.repetitions+' successful repetition(s) · generated '+new Date(report.completedAt).toLocaleString();
const last=report.rounds.at(-1);const cards=[
 ['Status',report.status],['Successful repetitions',fmt(report.repetitions,0)+' / '+fmt(report.requestedRepetitions??report.repetitions,0)],['Attempts',fmt(report.reliability.attempts,0)],['Failed attempts',fmt(report.reliability.failedAttempts,0)],['OOM failures',fmt(report.outOfMemoryFailures?.length??0,0)],
 ['Failure rate',pct(report.reliability.failureRate.estimate)+' ['+pct(report.reliability.failureRate.ci.lower)+'–'+pct(report.reliability.failureRate.ci.upper)+']'],['Bootstrap resamples',fmt(report.statistics.iterations,0)],['Confidence level',pct(report.statistics.confidenceLevel)],
 ['Final triples',fmt(last?.workload?.cumulativeTriples?.value,0)]
];
document.querySelector('#cards').innerHTML=cards.map(([l,v])=>'<div class="card"><div class="muted">'+l+'</div><div class="value">'+v+'</div></div>').join('');
const warnings=[];for(const round of report.rounds){for(const group of ['latency','writeLatency','throughput','resources'])for(const [metric,dist] of Object.entries(round[group]||{}))for(const [name,item] of Object.entries(dist.percentiles||{}))if(item.warning)warnings.push('Round '+round.round+' · '+metric+' '+name+': '+item.warning)}
if(warnings.length)document.querySelector('#warnings').innerHTML='<section class="panel warnings"><strong>Statistical warnings ('+warnings.length+')</strong><ul>'+warnings.slice(0,30).map(w=>'<li>'+w+'</li>').join('')+(warnings.length>30?'<li>…and '+(warnings.length-30)+' more in summary.json</li>':'')+'</ul></section>';
if(report.failures?.length){document.querySelector('#failures').innerHTML='<section class="panel"><h2>Failed attempts</h2><p class="muted">Last completed triples are the exact safe round boundary. Service triples are the latest processed-state sample before failure. Mock triples are accepted input at detection and can be ahead of service processing. For OOMs, request failure time, time the fatal OOM log was observed, and service exit time are shown separately; log-observation time is not the exact instant heap exhaustion began.</p><div class="table-panel"><table><thead><tr><th>Repetition</th><th>Attempt</th><th>Kind</th><th>Failure round</th><th>Last completed round</th><th>Last completed triples</th><th>Service triples (last sample)</th><th>Mock triples (detection)</th><th>Heap MiB</th><th>Request failed</th><th>OOM log observed</th><th>Service exited</th></tr></thead><tbody>'+report.failures.map(f=>'<tr><td>'+fmt(f.repetition,0)+'</td><td>'+fmt(f.attempt,0)+'</td><td>'+escapeHtml(f.kind)+'</td><td>'+fmt(f.round,0)+'</td><td>'+fmt(f.lastCompletedRound,0)+'</td><td>'+fmt(f.lastCompletedTriples,0)+'</td><td>'+fmt(f.serviceTriplesAtLastSample,0)+'</td><td>'+fmt(f.triplesAtFailure,0)+'</td><td>'+fmt(f.detectedHeapMiB,1)+'</td><td>'+escapeHtml(f.failedAt??f.observedAt)+'</td><td>'+escapeHtml(f.serviceOomLogObservedAt)+'</td><td>'+escapeHtml(f.serviceExitedAt)+'</td></tr>').join('')+'</tbody></table></div></section>'}
function median(metric,key='p50'){return metric?.percentiles?.[key]}
function interval(metric,key){const item=median(metric,key);return item?duration(item.estimate)+' ['+duration(item.ci.lower)+'–'+duration(item.ci.upper)+']':'—'}
function chart(){const rows=report.rounds,series=[['Propagation','propagationMs','var(--blue)'],['End to end','endToEndMs','var(--green)'],['Write phase','writePhaseMs','var(--orange)']];const W=1200,H=420,m={l:82,r:25,t:20,b:52};const all=series.flatMap(([,key])=>rows.flatMap(r=>{const p=median(r.latency[key]);return[p?.ci?.lower,p?.ci?.upper]})).filter(Number.isFinite);if(!all.length)return'<p>No completed round data.</p>';const max=Math.max(...all,1),x=i=>m.l+(rows.length<2?(W-m.l-m.r)/2:i*(W-m.l-m.r)/(rows.length-1)),y=v=>H-m.b-v/max*(H-m.t-m.b);let svg='<svg viewBox="0 0 '+W+' '+H+'">';for(let i=0;i<=5;i++){const value=max*(5-i)/5,yy=y(value);svg+='<line class="axis" x1="'+m.l+'" y1="'+yy+'" x2="'+(W-m.r)+'" y2="'+yy+'"/><text class="axis-text" x="'+(m.l-8)+'" y="'+(yy+4)+'" text-anchor="end">'+duration(value)+'</text>'}series.forEach(([name,key,color])=>{const points=rows.map((r,i)=>({x:x(i),p:median(r.latency[key])})).filter(v=>v.p);const upper=points.map(v=>v.x+','+y(v.p.ci.upper));const lower=[...points].reverse().map(v=>v.x+','+y(v.p.ci.lower));svg+='<polygon class="band" fill="'+color+'" points="'+upper.concat(lower).join(' ')+'"/><polyline class="line" stroke="'+color+'" points="'+points.map(v=>v.x+','+y(v.p.estimate)).join(' ')+'"/>'});if(rows.length)for(let i=0;i<Math.min(rows.length,10);i++){const index=Math.round(i*(rows.length-1)/Math.max(1,Math.min(rows.length,10)-1));svg+='<text class="axis-text" x="'+x(index)+'" y="'+(H-20)+'" text-anchor="middle">'+rows[index].round+'</text>'}svg+='</svg><div class="legend">'+series.map(([n,,c])=>'<span style="--color:'+c+'">'+n+'</span>').join('')+'</div>';return svg}
document.querySelector('#latency-chart').innerHTML=chart();
const columns=[['Round',r=>fmt(r.round,0)],['Samples',r=>fmt(r.latency.propagationMs.sampleSize,0)],['Cumulative triples',r=>fmt(r.workload.cumulativeTriples.value,0)],['Propagation p50 [CI]',r=>interval(r.latency.propagationMs,'p50')],['Propagation p95 [CI]',r=>interval(r.latency.propagationMs,'p95')],['Propagation p99 [CI]',r=>interval(r.latency.propagationMs,'p99')],['End-to-end p50 [CI]',r=>interval(r.latency.endToEndMs,'p50')],['End-to-end p95 [CI]',r=>interval(r.latency.endToEndMs,'p95')],['End-to-end p99 [CI]',r=>interval(r.latency.endToEndMs,'p99')],['Typical run write p95 [CI]',r=>interval(r.writeLatency.p95Ms,'p50')]];
document.querySelector('#rounds').innerHTML='<thead><tr>'+columns.map(c=>'<th>'+c[0]+'</th>').join('')+'</tr></thead><tbody>'+report.rounds.map(r=>'<tr>'+columns.map(([,get])=>'<td>'+get(r)+'</td>').join('')+'</tr>').join('')+'</tbody>';
</script></body></html>`;
}

export async function generateExperimentReport(summary, output) {
  const resolved = path.resolve(output);
  await fs.writeFile(resolved, document(summary));
  return resolved;
}
