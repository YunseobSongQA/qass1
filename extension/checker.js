/* QASS checker.js — 룰 기반 자동 점검 (LLM/네트워크 불필요) */
(function (global) {
  'use strict';

  const SPELL = [
    ['됬','됐'],['갯수','개수'],['몇일','며칠'],['역활','역할'],
    ['설레임','설렘'],['희안','희한'],['일일히','일일이'],['어의없','어이없'],
    ['왠만','웬만'],['금새','금세'],['어떻해','어떡해'],['구지','굳이'],
    ['읍니다','습니다'],['거에요','거예요'],
    ['할께','할게'],['갈께','갈게'],['볼께','볼게'],['줄께','줄게'],['올께','올게'],
  ];
  const SPACING = [
    ['할수있','할 수 있'],['할수없','할 수 없'],['갈수있','갈 수 있'],
    ['볼수있','볼 수 있'],['될수있','될 수 있'],['할수밖에','할 수밖에'],
    ['할때','할 때'],['갈때','갈 때'],['볼때','볼 때'],['올때','올 때'],['될때','될 때'],
  ];
  const SPACING_RE = [
    [/[가-힣]기때문/g, "'기 때문' 띄어쓰기"],
    [/[가-힣](는|은|을)것[이은을도만과와로]/g, "'것'(의존명사) 띄어쓰기"],
  ];

  function rectOf(el){
    const r = el.getBoundingClientRect();
    return { x:Math.round(r.left+scrollX), y:Math.round(r.top+scrollY),
             w:Math.round(r.width), h:Math.round(r.height) };
  }
  function cssPath(el){
    if(!el||!el.tagName) return '';
    if(el.id) return '#'+el.id;
    const p=[]; let c=el;
    while(c&&c.tagName&&p.length<4){
      let s=c.tagName.toLowerCase();
      if(typeof c.className==='string'){const k=c.className.trim().split(/\s+/)[0]; if(k)s+='.'+k;}
      p.unshift(s); c=c.parentElement;
    }
    return p.join(' > ');
  }
  function mk(type,severity,el,message,wrong,right,text){
    return {type,severity,message,wrong:wrong||null,right:right||null,
            text:(text||'').trim().slice(0,80),selector:cssPath(el),rect:el?rectOf(el):null};
  }
  function checkText(root,out){
    const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode(n){
      if(!n.nodeValue||!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p=n.parentElement; if(!p) return NodeFilter.FILTER_REJECT;
      const tag=p.tagName;
      if(tag==='SCRIPT'||tag==='STYLE'||tag==='NOSCRIPT'||p.isContentEditable) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }});
    let n;
    while((n=w.nextNode())){
      const t=n.nodeValue, el=n.parentElement;
      for(const [bad,good] of SPELL)   if(t.includes(bad)) out.push(mk('spell','error',el,"'"+bad+"' → '"+good+"'",bad,good,t));
      for(const [bad,good] of SPACING) if(t.includes(bad)) out.push(mk('spacing','warn',el,"'"+bad+"' → '"+good+"'",bad,good,t));
      for(const [re,label] of SPACING_RE){re.lastIndex=0; if(re.test(t)) out.push(mk('spacing','warn',el,label,null,null,t));}
    }
  }
  function checkUI(root,out){
    const vw=document.documentElement.clientWidth;
    root.querySelectorAll('img').forEach(img=>{
      if(img.complete && img.naturalWidth===0)
        out.push(mk('ui','error',img,'이미지 로드 실패(깨짐)',null,null,img.getAttribute('src')||img.alt||''));
    });
    root.querySelectorAll('*').forEach(el=>{
      const cs=getComputedStyle(el);
      const clip=cs.overflow==='hidden'||cs.overflowX==='hidden'||cs.textOverflow==='ellipsis';
      if(clip && el.scrollWidth>el.clientWidth+1 && el.textContent.trim())
        out.push(mk('ui','warn',el,'텍스트 가로 잘림',null,null,el.textContent));
      const r=el.getBoundingClientRect();
      if(r.width>0 && r.right>vw+2){
        const pr=el.parentElement&&el.parentElement.getBoundingClientRect();
        if(!pr||pr.right<=vw+2) out.push(mk('ui','warn',el,'요소가 화면 가로폭 초과',null,null,el.tagName.toLowerCase()));
      }
    });
    root.querySelectorAll('button, a').forEach(el=>{
      const img=el.querySelector('img');
      const label=(el.textContent||'').trim()||el.getAttribute('aria-label')||el.title||(img&&img.alt);
      if(!label) out.push(mk('ui','warn',el,'레이블 없는 버튼/링크',null,null,el.tagName.toLowerCase()));
    });
  }
  function run(root){
    root=root||document.body;
    const out=[];
    try{checkText(root,out);}catch(e){console.warn('[QASS] text',e);}
    try{checkUI(root,out);}catch(e){console.warn('[QASS] ui',e);}
    const seen=new Set();
    return out.filter(i=>{const k=i.type+'|'+i.message+'|'+i.selector+'|'+i.text;
      if(seen.has(k))return false; seen.add(k); return true;});
  }
  global.QassCheck={run,SPELL,SPACING};
})(typeof window!=='undefined'?window:this);
