// report.html: one self-contained file (inline CSS + JS + embedded JSON). Works from file://, no network, no fetch, no CDN, no fonts.
// The data is the SAME object that becomes findings.json; this file only presents it. All text is inserted with textContent
// (never innerHTML), and the embedded JSON is escaped so nothing in it can close the script element.

function embed(data) {
    // < > & are escaped so no text can close the script element; U+2028/2029 are escaped so the JSON stays valid JavaScript everywhere
    return JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

const fs = require('fs');
const path = require('path');
const AUTO_JS = () => fs.readFileSync(path.join(__dirname, 'report-html-auto.js'), 'utf8');

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2330;--muted:#5d6676;--line:#d5d9e0;--accent:#1d4f91;--crit:#a12020;--high:#b4400c;--med:#7a5200;--low:#1d4f91;--info:#4b5563;--ok:#1e6b3a;--focus:#0b57d0}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1b2029;--ink:#e6e9ef;--muted:#a3adbd;--line:#333b49;--accent:#8ab4f8;--crit:#ff8a80;--high:#ffb27a;--med:#f2cc60;--low:#8ab4f8;--info:#b8c0cc;--ok:#7bd88f;--focus:#8ab4f8}}
*{box-sizing:border-box}html{font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}body{margin:0;background:var(--bg);color:var(--ink)}
main{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:1.5rem;margin:.2em 0}h2{font-size:1.15rem;margin:1.4em 0 .5em}
.meta{color:var(--muted);overflow-wrap:anywhere}.banner{border:2px solid var(--med);background:var(--card);border-radius:8px;padding:10px 14px;margin:12px 0}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin:12px 0}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
.card b{display:block;font-size:1.5rem}.card span{color:var(--muted);font-size:.8rem}
.tools{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;display:grid;gap:10px}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}label{display:flex;flex-direction:column;font-size:.8rem;color:var(--muted);gap:2px;min-width:0}.row>label{flex:1 1 150px;max-width:100%}select{width:100%;max-width:100%;text-overflow:ellipsis}
input,select,button{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 8px;min-height:36px}
input[type=search]{width:100%}.row>label:first-child{flex-basis:260px}button{cursor:pointer}button[aria-pressed=true]{background:var(--accent);color:var(--bg);border-color:var(--accent)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
fieldset{min-width:0;border:1px solid var(--line);border-radius:6px;padding:6px 8px;margin:0}legend{font-size:.8rem;color:var(--muted);padding:0 4px}fieldset label{flex-direction:row;align-items:center;display:inline-flex;margin-right:10px;color:var(--ink);font-size:.9rem}
#count{font-weight:600}.list{display:grid;gap:8px;margin-top:10px}
details.f{background:var(--card);border:1px solid var(--line);border-left:6px solid var(--info);border-radius:8px}
details.f[data-sev=CRITICAL]{border-left-color:var(--crit)}details.f[data-sev=HIGH]{border-left-color:var(--high)}details.f[data-sev=MEDIUM]{border-left-color:var(--med)}details.f[data-sev=LOW]{border-left-color:var(--low)}
details.f[data-kind=blocked]{border-left-style:dashed}details.f[data-kind=review]{border-left-style:dotted}
summary{cursor:pointer;padding:8px 10px;display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}summary .t{flex:1 1 300px;overflow-wrap:anywhere}
.badge{font-size:.72rem;font-weight:700;border:1px solid currentColor;border-radius:99px;padding:1px 8px;white-space:nowrap}
.sCRITICAL{color:var(--crit)}.sHIGH{color:var(--high)}.sMEDIUM{color:var(--med)}.sLOW{color:var(--low)}.sINFO{color:var(--info)}
.st-CONFIRMED,.st-REPRODUCIBLE,.st-FIXED_VERIFIED{color:var(--ok)}.st-BLOCKED,.st-NEEDS_AUTHORIZATION{color:var(--med);border-style:dashed}.st-REJECTED_FALSE_POSITIVE{color:var(--muted);text-decoration:line-through}.st-UNVERIFIED,.st-PROBABLE_NEEDS_REVIEW{color:var(--high);border-style:dotted}
.body{padding:0 12px 12px}dl{display:grid;grid-template-columns:150px 1fr;gap:4px 10px;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}ul.ev{margin:0;padding-left:18px}code{font:.85em ui-monospace,Menlo,Consolas,monospace}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);font-size:.9rem}th,td{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
.empty{padding:24px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:8px;background:var(--card)}
@media (max-width:600px){dl{grid-template-columns:1fr}dt{margin-top:6px}}
#auto-summary dl,#auto-issues dl{margin:8px 0}section>.meta{margin:.2em 0}
`;

const JS = `
(function(){
'use strict';
var D=JSON.parse(document.getElementById('pg-data').textContent);
var SEV=['CRITICAL','HIGH','MEDIUM','LOW','INFO'],SYM={CRITICAL:'\\u25B2\\u25B2',HIGH:'\\u25B2',MEDIUM:'\\u25C6',LOW:'\\u25CF',INFO:'\\u25CB'};
function el(t,a,k){var e=document.createElement(t);if(a)for(var n in a){if(n==='text')e.textContent=a[n];else e.setAttribute(n,a[n]);}(k||[]).forEach(function(c){if(c!=null)e.appendChild(typeof c==='string'?document.createTextNode(c):c);});return e;}
function uniq(a){return a.filter(function(v,i){return v&&a.indexOf(v)===i;}).sort();}
var F=D.findings;
function isBlocked(f){return f.status==='BLOCKED'||f.status==='NEEDS_AUTHORIZATION';}
function isReview(f){return f.status==='PROBABLE_NEEDS_REVIEW'||f.status==='UNVERIFIED';}
function isSecurity(f){return (f.finding_type==='security'||f.finding_type==='conflict')&&f.status!=='REJECTED_FALSE_POSITIVE'&&f.status!=='FIXED_VERIFIED';}
var VIEWS={all:function(){return true;},actionable:function(f){return f.fix_eligible===true;},security:isSecurity,blocked:isBlocked,review:isReview,rejected:function(f){return f.status==='REJECTED_FALSE_POSITIVE';}};
var st={q:'',severity:'',status:'',category:'',source_agent:'',component:'',finding_type:'',view:'all'};
function hay(f){return [f.id,f.title,f.description,f.file_path,f.component,f.category,f.status,f.root_cause,(f.evidence||[]).join(' ')].join('\\n').toLowerCase();}
var H=F.map(hay);
function match(f,i){
 if(st.q){var words=st.q.toLowerCase().split(/\\s+/).filter(Boolean);for(var w=0;w<words.length;w++)if(H[i].indexOf(words[w])<0)return false;}
 for(var k in {severity:1,status:1,category:1,source_agent:1,component:1,finding_type:1})if(st[k]&&f[k]!==st[k])return false;
 return VIEWS[st.view](f);
}
function field(dl,k,v){if(v==null||v===''||(Array.isArray(v)&&!v.length))return;dl.appendChild(el('dt',{text:k}));var dd=el('dd');if(Array.isArray(v)){var ul=el('ul',{class:'ev'});v.slice(0,25).forEach(function(x){ul.appendChild(el('li',null,[el('code',{text:String(x)})]));});if(v.length>25)ul.appendChild(el('li',{text:'\\u2026and '+(v.length-25)+' more'}));dd.appendChild(ul);}else dd.textContent=String(v);dl.appendChild(dd);}
function card(f){
 var kind=isBlocked(f)?'blocked':isReview(f)?'review':'defect';
 var d=el('details',{class:'f','data-sev':f.severity,'data-kind':kind,'data-id':f.id});
 d.appendChild(el('summary',null,[el('span',{class:'badge s'+f.severity,text:SYM[f.severity]+' '+f.severity}),el('span',{class:'badge st-'+f.status,text:f.status.replace(/_/g,' ')}),el('span',{class:'t',text:f.title}),el('code',{text:f.id})]));
 var b=el('div',{class:'body'}),dl=el('dl');
 field(dl,'Type',f.finding_type+' / '+f.category);field(dl,'Source agent',f.source_agent);field(dl,'Confidence',f.confidence);
 field(dl,'Component',f.component);field(dl,'Location',f.file_path?f.file_path+(f.line_start?':'+f.line_start:''):null);field(dl,'Ownership',f.ownership?f.ownership.owner+' \\u2014 '+f.ownership.reason:null);field(dl,'Page',f.url);
 field(dl,'Description',f.description);field(dl,'Expected',f.expected_behavior);field(dl,'Actual',f.actual_behavior!==f.description?f.actual_behavior:null);field(dl,'Impact',f.impact);field(dl,'Root cause',f.root_cause);
 field(dl,'Evidence',f.evidence);field(dl,'Reproduce',f.reproduction_steps);field(dl,'Recommended fix',f.recommended_fix);field(dl,'Verify with',f.validation_steps);
 field(dl,'Fix task allowed',f.fix_eligible?'Yes \\u2014 only: '+f.allowed_fix_paths.join(', '):'No');field(dl,'Why not a task',f.blocked_reason);
 field(dl,'Related findings',f.related_finding_ids);field(dl,'Validation notes',f.validation_notes);
 b.appendChild(dl);d.appendChild(b);return d;
}
var listEl=document.getElementById('list'),countEl=document.getElementById('count');
function render(){
 var out=[];F.forEach(function(f,i){if(match(f,i))out.push(f);});
 listEl.textContent='';
 if(!out.length)listEl.appendChild(el('div',{class:'empty',role:'status',text:F.length?'No findings match the current search and filters.':'No findings were recorded for this run.'}));
 else out.forEach(function(f){listEl.appendChild(card(f));});
 countEl.textContent='Showing '+out.length+' of '+F.length+' finding'+(F.length===1?'':'s');
}
function opts(id,key){var s=document.getElementById(id);uniq(F.map(function(f){return f[key];})).forEach(function(v){s.appendChild(el('option',{value:v,text:v}));});s.addEventListener('change',function(){st[key]=s.value;render();});}
opts('f-severity','severity');opts('f-status','status');opts('f-category','category');opts('f-agent','source_agent');opts('f-component','component');opts('f-type','finding_type');
var q=document.getElementById('q');q.addEventListener('input',function(){st.q=q.value;render();});
document.querySelectorAll('input[name=view]').forEach(function(r){r.addEventListener('change',function(){if(r.checked){st.view=r.value;render();}});});
document.getElementById('clear').addEventListener('click',function(){st={q:'',severity:'',status:'',category:'',source_agent:'',component:'',finding_type:'',view:'all'};q.value='';document.querySelectorAll('select.flt').forEach(function(s){s.value='';});document.querySelector('input[name=view][value=all]').checked=true;render();});
// summary + facts (from the validated data, not recomputed)
var S=D.summary,cards=document.getElementById('cards');
[['Total',S.total],['Critical',S.by_severity.CRITICAL],['High',S.by_severity.HIGH],['Medium',S.by_severity.MEDIUM],['Low',S.by_severity.LOW],['Info',S.by_severity.INFO],['Confirmed / reproducible',S.confirmed_or_reproducible],['Need review',S.needs_review],['Blocked / need authorization',S.blocked_or_authorization],['Rejected false positives',S.rejected_false_positives],['Fixes verified',S.fixed_verified],['Fix tasks (custom code)',S.actionable]].forEach(function(c){cards.appendChild(el('div',{class:'card'},[el('b',{text:String(c[1])}),el('span',{text:c[0]})]));});
var meta=document.getElementById('meta');meta.textContent='Run '+D.run_id+' \\u00B7 generated '+D.generated_at+' \\u00B7 target '+(D.target.url||'no URL')+' \\u00B7 source '+(D.target.root||'none');
if(!D.complete){var bn=document.getElementById('banner');bn.hidden=false;bn.appendChild(el('b',{text:'Partial report. '}));bn.appendChild(document.createTextNode(D.stages.filter(function(s){return s.state!=='completed';}).map(function(s){return s.name+' ('+s.state+')';}).join('; ')+' \\u2014 whatever those stages would check is NOT covered.'));}
var ct=document.getElementById('checks');D.checks.forEach(function(c){ct.appendChild(el('tr',null,[el('td',{text:c.status}),el('td',{text:c.label}),el('td',{text:c.reason||''})]));});
var ip=document.getElementById('problems');if(D.input_problems.length){document.getElementById('problems-h').hidden=false;D.input_problems.forEach(function(p){ip.appendChild(el('li',{text:p}));});}
var lm=document.getElementById('limits');D.limits.forEach(function(p){lm.appendChild(el('li',{text:p}));});
render();
})();
`;

function build(data) {
    const viewRadio = (v, label, on) => `<label><input type="radio" name="view" value="${v}"${on ? ' checked' : ''}> ${label}</label>`;
    const sel = (id, label) => `<label>${label}<select id="${id}" class="flt"><option value="">All</option></select></label>`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>Plugin Guard report</title><style>${CSS}</style></head>
<body><main>
<h1>Plugin Guard: validated findings</h1>
<p class="meta" id="meta"></p>
<div class="banner" id="banner" role="note" hidden></div>
<section aria-labelledby="sum-h"><h2 id="sum-h">Summary</h2><div class="cards" id="cards"></div></section>
<section aria-labelledby="find-h"><h2 id="find-h">Findings</h2>
<form class="tools" role="search" aria-label="Search and filter findings" onsubmit="return false">
 <div class="row"><label for="q">Search<input id="q" type="search" placeholder="title, file, component, evidence…" autocomplete="off"></label>
 ${sel('f-severity', 'Severity')}${sel('f-status', 'Status')}${sel('f-category', 'Category')}${sel('f-agent', 'Source agent')}${sel('f-component', 'Component')}${sel('f-type', 'Finding type')}
 <button type="button" id="clear">Clear all filters</button></div>
 <fieldset><legend>View</legend>${viewRadio('all', 'All', true)}${viewRadio('actionable', 'Actionable (custom code)')}${viewRadio('security', 'Unresolved security')}${viewRadio('blocked', 'Blocked checks')}${viewRadio('review', 'Needs review')}${viewRadio('rejected', 'Rejected false positives')}</fieldset>
 <div id="count" role="status" aria-live="polite"></div>
</form>
<div class="list" id="list"></div></section>
<section><h2>Checks that ran (or did not)</h2><table><thead><tr><th>Status</th><th>Check</th><th>Detail</th></tr></thead><tbody id="checks"></tbody></table></section>
<h2 id="problems-h" hidden>Input problems</h2><ul id="problems"></ul>
<h2>Limits of this report</h2><ul id="limits"></ul>
</main>
<script type="application/json" id="pg-data">${embed(data)}</script>
<script>${JS}
${AUTO_JS()}</script>
</body></html>`;
}

module.exports = { build, embed };
