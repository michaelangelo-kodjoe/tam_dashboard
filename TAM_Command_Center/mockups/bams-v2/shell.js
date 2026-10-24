/* mockup-only: wraps <main id="m"> content in the TAM CC shell */
(function(){
const rail=['Today','Accounts','Tasks','Operations','BAMS','ChatGPT Bridge','Settings'];
const m=document.getElementById('m');const inner=m.innerHTML;
const cur=document.body.dataset.rail||'BAMS';
document.body.innerHTML='<div class="nav-note">Mockup (fictional data, not built). <a href="index.html">All BAMS v2 mockups</a></div><div class="app" style="min-height:calc(100vh - 29px)"><header class="top"><div class="brand"><b></b><span>TAM CC</span></div><div class="jump"><span>Jump to account</span><kbd>Ctrl+K</kbd></div><div class="sp"></div><span class="envb">DEV</span><span class="clock num">14:05 Local</span><button class="btn pri sm">+ Capture</button></header><nav class="rail" aria-label="Primary">'+rail.map(r=>'<a class="ni'+(r===cur?' on':'')+'" href="#"><span>'+r+'</span></a>').join('')+'</nav><main class="main" id="m">'+inner+'</main></div>'+'<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><symbol id="chev" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></symbol><symbol id="chev-d" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol><symbol id="check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></symbol><symbol id="x" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></symbol></defs></svg>';
})();
