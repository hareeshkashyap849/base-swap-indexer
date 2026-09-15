const cs=['priceCanvas','volCanvas'].map(i=>document.getElementById(i));
const snap=()=>cs.map(c=>({id:c.id,backing:c.width,layout:c.clientWidth,cssWidth:c.style.width||'(none)'}));
const h=document.documentElement.outerHTML;
console.log('build has fixes:',h.includes('function timeLabel')&&h.includes('cv.style.width'));
const a=snap();console.table(a);
await new Promise(r=>setTimeout(r,20000));
const b=snap();console.table(b);
cs.forEach((c,i)=>console.log(c.id,b[i].layout>a[i].layout?'GREW '+a[i].layout+' -> '+b[i].layout:'stable '+b[i].layout));
