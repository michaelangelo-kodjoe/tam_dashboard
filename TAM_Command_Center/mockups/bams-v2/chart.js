/* mockup-only chart engine: fictional CPU % series, 24h at 1-min resolution */
window.Chart=(function(){
const N=1440,T0=new Date('2026-10-14T00:00:00').getTime(),MIN=60000;
const data=[];let s=1;function rnd(){s=(s*16807)%2147483647;return s/2147483647}
for(let i=0;i<N;i++){const h=i/60;let v=52+14*Math.sin((h-6)/24*6.283)+(rnd()-.5)*9;
 if(i>=540&&i<575)v+=36*Math.sin((i-540)/35*3.14159); if(i>=915&&i<930)v+=48*Math.sin((i-915)/15*3.14159);
 data.push(Math.max(5,Math.min(99,v)))}
const WARN=75,CRIT=90;
const pad={l:44,r:14,t:10,b:26};
function pad2(n){return String(n).padStart(2,'0')}
function fmt(ms,sec){const d=new Date(ms);return pad2(d.getHours())+':'+pad2(d.getMinutes())+(sec?':'+pad2(d.getSeconds()):'')}
function fmtDT(ms){const d=new Date(ms);return d.getDate()+' Oct '+fmt(ms)}
function ticks(a,b){const span=b-a;const steps=[MIN,2*MIN,5*MIN,10*MIN,15*MIN,30*MIN,60*MIN,120*MIN,180*MIN,360*MIN];
 let st=steps.find(x=>span/x<=9)||steps[steps.length-1];const out=[];for(let t=Math.ceil(a/st)*st;t<=b;t+=st)out.push(t);return {out,st}}
function make(el,opt){
 const o=Object.assign({sev:false,thr:false,ref:false,zoom:true,onrange:null},opt);
 let view=[T0,T0+(N-1)*MIN];const full=view.slice();let drag=null;
 const W=900,H=300;el.innerHTML='<svg class="ch" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" aria-label="CPU utilisation trend"></svg>';
 const svg=el.firstChild;
 const X=t=>pad.l+(t-view[0])/(view[1]-view[0])*(W-pad.l-pad.r);
 const Y=v=>pad.t+(100-v)/100*(H-pad.t-pad.b);
 const inv=px=>view[0]+(px-pad.l)/(W-pad.l-pad.r)*(view[1]-view[0]);
 function draw(){
  let h='';for(const v of [0,25,50,75,100])h+='<line class="grid" x1="'+pad.l+'" x2="'+(W-pad.r)+'" y1="'+Y(v)+'" y2="'+Y(v)+'"/><text x="'+(pad.l-6)+'" y="'+(Y(v)+3)+'" text-anchor="end">'+v+'%</text>';
  const tk=ticks(view[0],view[1]);for(const t of tk.out){h+='<line class="grid" x1="'+X(t)+'" x2="'+X(t)+'" y1="'+pad.t+'" y2="'+(H-pad.b)+'" opacity=".45"/><text x="'+X(t)+'" y="'+(H-8)+'" text-anchor="middle">'+fmt(t)+'</text>'}
  if(o.ref){for(const [l,v,c] of [['30d high',93,'var(--subtle)'],['60d high',96,'var(--subtle)'],['90d high',98,'var(--subtle)']])h+='<line class="ref" stroke="'+c+'" x1="'+pad.l+'" x2="'+(W-pad.r)+'" y1="'+Y(v)+'" y2="'+Y(v)+'"/><text x="'+(W-pad.r-2)+'" y="'+(Y(v)-3)+'" text-anchor="end">'+l+'</text>'}
  if(o.thr){h+='<line class="ref" stroke="var(--warning)" x1="'+pad.l+'" x2="'+(W-pad.r)+'" y1="'+Y(WARN)+'" y2="'+Y(WARN)+'"/><line class="ref" stroke="var(--danger)" x1="'+pad.l+'" x2="'+(W-pad.r)+'" y1="'+Y(CRIT)+'" y2="'+Y(CRIT)+'"/>'}
  const i0=Math.max(0,Math.floor((view[0]-T0)/MIN)-1),i1=Math.min(N-1,Math.ceil((view[1]-T0)/MIN)+1);
  const cls=v=>!o.sev?'n':v>=CRIT?'c':v>=WARN?'w':'n';
  let runs=[],cur=null;
  for(let i=i0;i<=i1;i++){const v=data[i],c=cls(v);const pt=X(T0+i*MIN).toFixed(1)+','+Y(v).toFixed(1);
   if(!cur){cur={c,p:[pt]}}else if(cur.c===c){cur.p.push(pt)}else{ // bridge to previous point so segments join
     cur.p.push(pt);runs.push(cur);cur={c,p:[pt]}}}
  if(cur)runs.push(cur);
  for(const r of runs)h+='<polyline class="ln-'+r.c+'" points="'+r.p.join(' ')+'" clip-path="url(#cp)"/>';
  h='<defs><clipPath id="cp"><rect x="'+pad.l+'" y="0" width="'+(W-pad.l-pad.r)+'" height="'+H+'"/></clipPath></defs>'+h;
  if(drag){const a=Math.min(drag.x0,drag.x1),b=Math.max(drag.x0,drag.x1);
   h+='<rect class="sel" x="'+a+'" y="'+pad.t+'" width="'+(b-a)+'" height="'+(H-pad.t-pad.b)+'"/><text x="'+((a+b)/2)+'" y="'+(pad.t+12)+'" text-anchor="middle" style="fill:var(--accent)">'+fmt(inv(a),1)+' to '+fmt(inv(b),1)+'</text>'}
  svg.innerHTML=h;
  if(o.onrange)o.onrange(view,full,tk.st);
 }
 function px(e){const r=svg.getBoundingClientRect();return Math.max(pad.l,Math.min(W-pad.r,(e.clientX-r.left)/r.width*W))}
 if(o.zoom){svg.addEventListener('mousedown',e=>{drag={x0:px(e),x1:px(e)};draw()});
  window.addEventListener('mousemove',e=>{if(!drag)return;drag.x1=px(e);draw()});
  window.addEventListener('mouseup',()=>{if(!drag)return;const a=Math.min(drag.x0,drag.x1),b=Math.max(drag.x0,drag.x1);
   const t0=inv(a),t1=inv(b);drag=null;if(b-a>8&&t1-t0>=3*MIN)view=[Math.round(t0/MIN)*MIN,Math.round(t1/MIN)*MIN];draw()})}
 draw();
 return {reset(){view=full.slice();draw()},zoomTo(a,b){view=[a,b];draw()},fmt,fmtDT,full,T0,MIN,isZoomed:()=>view[0]!==full[0]||view[1]!==full[1]};
}
return {make,WARN,CRIT,T0,MIN,fmt};
})();
