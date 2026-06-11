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
  // 화면에 실제로 보이는 요소만 점검 (숨겨진 모바일용 중복 마크업 등 제외)
  function visible(el){
    if(!el || !el.getClientRects().length) return false;
    const cs=getComputedStyle(el);
    if(cs.visibility==='hidden'||cs.display==='none'||cs.opacity==='0') return false;
    const r=el.getBoundingClientRect();
    return r.width>1 && r.height>1;
  }
  // 조상 중에 가로 스크롤/클리핑 컨테이너가 있으면 캐러셀 등 의도된 배치로 본다
  function clippedByAncestor(el){
    let p=el.parentElement,n=0;
    while(p&&p!==document.body&&n++<8){
      const o=getComputedStyle(p).overflowX;
      if(o==='hidden'||o==='auto'||o==='scroll') return true;
      p=p.parentElement;
    }
    return false;
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
      if(!visible(el)) continue;
      for(const [bad,good] of SPELL)   if(t.includes(bad)) out.push(mk('spell','error',el,"'"+bad+"' → '"+good+"'",bad,good,t));
      for(const [bad,good] of SPACING) if(t.includes(bad)) out.push(mk('spacing','warn',el,"'"+bad+"' → '"+good+"'",bad,good,t));
      for(const [re,label] of SPACING_RE){re.lastIndex=0; if(re.test(t)) out.push(mk('spacing','warn',el,label,null,null,t));}
    }
  }
  function checkUI(root,out){
    const vw=document.documentElement.clientWidth;
    root.querySelectorAll('img').forEach(img=>{
      if(img.complete && img.naturalWidth===0 && visible(img))
        out.push(mk('ui','error',img,'이미지 로드 실패(깨짐)',null,null,img.getAttribute('src')||img.alt||''));
    });
    root.querySelectorAll('*').forEach(el=>{
      if(!visible(el)) return;
      const cs=getComputedStyle(el);
      // 말줄임(...)은 의도된 디자인이므로 제외하고, 말줄임 처리 없이 잘리는 경우만 검출
      const clip=(cs.overflow==='hidden'||cs.overflowX==='hidden')&&cs.textOverflow!=='ellipsis';
      const hasOwnText=[...el.childNodes].some(c=>c.nodeType===3&&c.nodeValue.trim());
      if(clip && hasOwnText && el.scrollWidth>el.clientWidth+2)
        out.push(mk('ui','warn',el,'텍스트 가로 잘림',null,null,el.textContent));
      const r=el.getBoundingClientRect();
      // 화면 안에서 시작해 밖으로 삐져나가는 요소만. 캐러셀 등 클리핑 컨테이너 내부는 제외
      if(r.width>0 && r.left<vw && r.right>vw+2 && !clippedByAncestor(el)){
        const pr=el.parentElement&&el.parentElement.getBoundingClientRect();
        if(!pr||pr.right<=vw+2) out.push(mk('ui','warn',el,'요소가 화면 가로폭 초과',null,null,el.tagName.toLowerCase()));
      }
    });
  }
  function run(root){
    root=root||document.body;
    const out=[];
    try{checkText(root,out);}catch(e){console.warn('[QASS] text',e);}
    try{checkUI(root,out);}catch(e){console.warn('[QASS] ui',e);}
    const seen=new Set();
    // 텍스트 이슈는 같은 문구가 여러 요소에 반복돼도 1건으로 합산
    const deduped=out.filter(i=>{
      const k=(i.type==='ui')
        ? i.type+'|'+i.message+'|'+i.selector+'|'+i.text
        : i.type+'|'+i.message+'|'+i.text;
      if(seen.has(k))return false; seen.add(k); return true;});
    return deduped.slice(0,60);
  }
  global.QassCheck={run,SPELL,SPACING};
})(typeof window!=='undefined'?window:this);
