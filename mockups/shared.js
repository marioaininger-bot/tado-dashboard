// Dummy-Daten nur für Mockups
const ROOMS=[
 {n:'Wohnzimmer',i:'🛋️',t:21.4,s:22,h:48,p:70,st:'heat'},
 {n:'Schlafzimmer',i:'🛏️',t:18.9,s:19,h:55,p:0,st:'idle'},
 {n:'Küche',i:'🍳',t:20.2,s:21,h:51,p:40,st:'heat'},
 {n:'Bad',i:'🛁',t:23.1,s:23,h:67,p:0,st:'idle'},
 {n:'Büro',i:'💻',t:19.4,s:21,h:44,p:90,st:'warn'},
 {n:'Kinderzimmer',i:'🧸',t:20.0,s:20,h:49,p:0,st:'off',win:true},
];
const AC=[{n:'Klima Wohnzimmer',on:true,sub:'Kühlen · 24° · Auto'},{n:'Klima Schlafzimmer',on:false,sub:'Aus'}];
function spark(w,h,seed,color){let v=[],x=seed;for(let i=0;i<24;i++){x=(x*9301+49297)%233280;v.push(.5+Math.sin(i/3+seed)*.25+(x/233280-.5)*.2)}
 const pts=v.map((y,i)=>`${(i/23*w).toFixed(1)},${(h-y*h).toFixed(1)}`).join(' ');
 return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`}
