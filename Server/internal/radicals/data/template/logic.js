
/* ===================== LOGIC ===================== */
const $ = s=>document.querySelector(s);
const esc = s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const letter = i=>String.fromCharCode(65+i);
const state = {lesson:(+Object.keys(LESSON_TITLES)[0]||1), group:0, instant:true, info:null, sheet:false, size:1, gs:{}};
const SIZES=[64,78,96];
const ICON_LOCK='<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.6" fill="currentColor"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

function gsOf(){
  const L=LESSONS[state.lesson]; if(!L) return null;
  const key=state.lesson+'-'+state.group;
  if(!state.gs[key]){
    const gd=L.groups[state.group];
    state.gs[key]={order:gd.opts.slice(),place:gd.items.map(()=>null),status:gd.items.map(()=>null),selChip:null,selBox:null,revealed:false,fresh:-1,doneShown:false};
  }
  return state.gs[key];
}
const okCount = gs=>gs.status.filter(s=>s==='ok').length;
const tags = s=>String(s||'').split(' · ').filter(Boolean).map(t=>`<span class="tg">${esc(t)}</span>`).join('');

/* --- draw a character from its component-split stroke outlines (SVG): the missing component is omitted and shown again in green once answered correctly --- */
function glyph(ch,miss,mode,fresh){
  const G=GLYPHS[ch];
  if(!G) return `<div class="gl zh">${esc(ch)}</div>`;
  let s=`<svg class="gsvg" viewBox="-125 -125 1250 1250" aria-hidden="true">`;
  for(const comp of Object.keys(G)){
    if(miss && comp===miss){ if(mode==='solved') s+=`<path class="fillp${fresh?' anim':''}" d="${G[comp]}"/>`; }
    else s+=`<path d="${G[comp]}"/>`;
  }
  return s+`</svg>`;
}
function wordHTML(word,missCi,miss,mode,q,fresh,pickCi){
  const _lv=LESSONS[state.lesson], _v=_lv&&_lv.vocab.find(x=>x.h===word); const syl=(_v&&_v.syl)||WORDS[word]||[]; const chars=[...word];
  return `<div class="word">`+chars.map((c,i)=>{
    const isMiss=(i===missCi);
    return `<div class="cell${pickCi===i?' pick':''}" role="button" tabindex="0" data-act="cell" data-q="${q}" data-ci="${i}" aria-label="Chữ ${i+1} của từ ${esc(word)}: xem từ ghép trong bài"><div class="py">${esc(syl[i]||'')}</div><div class="cb">${glyph(c,isMiss?miss:null,mode,fresh)}</div></div>`;
  }).join('')+`</div>`;
}
const arrowSVG=`<svg class="arrow" viewBox="0 0 130 20" preserveAspectRatio="none" aria-hidden="true"><line x1="2" y1="10" x2="116" y2="10" stroke="currentColor" stroke-width="2" stroke-dasharray="6 4"/><polygon points="115,3 128,10 115,17" fill="currentColor"/></svg>`;

/* --- unlock info (avoid giving away the answer before the exercise is done) --- */
const allOk=(gs,gd)=>okCount(gs)===gd.items.length;
const partUnlocked=(gs,gd,comp)=>gs.revealed||allOk(gs,gd)||gd.example.miss===comp||gd.items.some((it,i)=>it.miss===comp&&gs.status[i]==='ok');

/* ===================== RENDER ===================== */
function renderLessons(){
  const el=$('#lessonTabs');
  el.innerHTML=`<span class="llabel">Bài ${state.lesson}<span class="zh">${esc(LESSON_TITLES[state.lesson]||'')}</span></span><div class="lbtns">`+
    Object.keys(LESSON_TITLES).map(n=>{
      const on=(+n===state.lesson);
      return `<button class="lbtn${on?' on':''}${LESSONS[n]?'':' empty'}" data-act="lesson" data-n="${n}" title="Bài ${n}${LESSON_TITLES[n]?': '+esc(LESSON_TITLES[n]):''}"${on?' aria-current="true"':''}>${n}</button>`;
    }).join('')+`</div>`;
  const sc=el.querySelector('.lbtns'), on=el.querySelector('.lbtn.on');
  if(sc&&on) sc.scrollLeft=Math.max(0,on.offsetLeft-sc.clientWidth/2+on.offsetWidth/2);
}
function renderStage(){
  const L=LESSONS[state.lesson];
  const gt=$('#groupTabs'), tb=$('#toolbar'), paper=$('#paper'), how=$('#howto'), tw=$('#trayWrap');
  if(!L){
    gt.innerHTML=''; tb.innerHTML=''; how.textContent=''; tw.innerHTML='';
    paper.className='paper';
    paper.innerHTML=`<div class="empty-state"><span class="zh">${esc(LESSON_TITLES[state.lesson]||'')}</span><b>Bài ${state.lesson} chưa có bài tập.</b><p>Giáo viên: thêm dữ liệu vào LESSONS[${state.lesson}] (xem hướng dẫn ở đầu phần script).</p></div>`;
    return;
  }
  const gd=L.groups[state.group], gs=gsOf(), n=gd.items.length, ok=okCount(gs);
  gt.innerHTML=L.groups.map((g,i)=>{
    const s=state.gs[state.lesson+'-'+i]; const done=s&&okCount(s)===g.items.length;
    return `<button class="${i===state.group?'on':''}" data-act="group" data-g="${i}" aria-pressed="${i===state.group}">Nhóm ${i+1}${done?'<span class="ck" aria-label="đã xong">✓</span>':''}</button>`;
  }).join('');
  tb.innerHTML=`
    <div class="acts"><button class="btn ghost" data-act="reset">Làm lại</button><button class="btn ghost" data-act="shuffle">Xáo bộ</button><button class="btn" data-act="reveal">Hiện đáp án</button></div>
    <label class="switch"><input type="checkbox" data-act="instant" ${state.instant?'checked':''}><span class="trk"></span>Chấm ngay</label>
    <span class="size" role="group" aria-label="Cỡ chữ">${['A−','A','A+'].map((t,i)=>`<button data-act="size" data-s="${i}" class="${state.size===i?'on':''}" aria-pressed="${state.size===i}">${t}</button>`).join('')}</span>`;
  how.textContent=`Bấm một bộ trên khay, rồi bấm ô vuông bên phải câu cần điền. Bấm vào chữ để xem từ ghép trong Bài ${state.lesson}.`;

  /* component tray (pinned) */
  const ex=gd.example;
  const usedBy=comp=>gs.place.indexOf(comp);
  const pct=Math.round(100*ok/n);
  const tiles=gs.order.map((c,i)=>{
    const u=usedBy(c); const solved=(u>=0&&gs.status[u]==='ok');
    const isEx=(c===ex.miss);
    const cls='tile'+(gs.selChip===c?' sel':'')+(solved?' okc':(u>=0?' used':''))+((u>=0&&gs.status[u]==='bad')?' bad':'')+(isEx&&u<0?' ex':'');
    const mk=solved?'✓':(u>=0?String(u+1):(isEx?'例':''));
    return `<button class="${cls}" data-act="chip" data-c="${esc(c)}" aria-pressed="${gs.selChip===c}" aria-label="Bộ ${letter(i)}"><span class="L">${letter(i)}</span><span class="g">${tileGlyph(c)}</span><span class="mk">${mk}</span></button>`;
  }).join('');
  tw.innerHTML=`<div class="tray" role="group" aria-label="Khay bộ">
    <div class="tiles">${tiles}</div>
    <div class="trail${state.instant?'':' hasbtn'}">
      <div class="ring" style="--p:${pct}" role="img" aria-label="Đúng ${ok} trên ${n} câu"><span class="rt"><b>${ok}</b>/${n}</span></div>
      ${state.instant?'':'<button class="btn primary" data-act="check">Kiểm tra</button>'}
    </div>
    <div class="bar" style="--p:${pct}"><i></i></div>
    <div class="note">${trayNote(gs)}</div>
  </div>`;

  /* worksheet */
  const pk=(state.info&&state.info.t==='word')?state.info:null;
  const exLetter=letter(gs.order.indexOf(ex.miss));
  let h=`<div class="exlabel">例如：</div>`;
  h+=`<div class="row ex n${[...ex.word].length}"><div></div><div class="exrow">${wordHTML(ex.word,ex.ci,ex.miss,'hide','ex',false,pk&&pk.q==='ex'?pk.ci:-1)}${arrowSVG}${wordHTML(ex.word,ex.ci,ex.miss,'solved','ex',false,-1)}</div><div class="gap"></div><div class="box fixed" aria-label="Đáp án ví dụ: ${exLetter}">${exLetter}</div></div>`;
  gd.items.forEach((it,qi)=>{
    const st=gs.status[qi], val=gs.place[qi];
    const mode=(st==='ok')?'solved':'hide';
    const label=val?letter(gs.order.indexOf(val)):'';
    const bcls='box'+(gs.selBox===qi?' active':'')+(st==='ok'?' ok':(st==='bad'?' bad':''));
    h+=`<div class="row${gs.selBox===qi?' sel':''}"><div class="num">${qi+1}.</div>${wordHTML(it.word,it.ci,it.miss,mode,qi,gs.fresh===qi,pk&&pk.q===qi?pk.ci:-1)}<div class="gap"></div><div class="${bcls}" role="button" tabindex="0" data-act="box" data-q="${qi}" aria-label="Ô trả lời câu ${qi+1}${label?': '+label:''}">${label}</div></div>`;
  });
  let stamped=false;
  if(allOk(gs,gd)){
    const next=state.group+1<L.groups.length;
    stamped=!gs.doneShown; gs.doneShown=true;
    h+=`<div class="done" role="status" id="doneCard"><div class="seal zh${stamped?' anim':''}" aria-hidden="true">全对</div><div class="dt"><b>Hoàn thành Nhóm ${state.group+1}</b><p>Bấm vào từng chữ hoặc từng bộ để ôn lại cấu tạo.</p></div>${next?`<button class="btn primary" data-act="next">Sang Nhóm ${state.group+2}</button>`:''}</div>`;
  }
  paper.className='paper'+(gs.selChip?' armed':'');
  paper.innerHTML=h;
  gs.fresh=-1;
  if(stamped){ const d=$('#doneCard'); if(d&&d.scrollIntoView) d.scrollIntoView({block:'nearest',behavior:'smooth'}); }
}

/* note line in the tray (narrow screens): component name + meaning, without covering the exercise */
function trayNote(gs){
  const i=state.info;
  const comp=gs.selChip||((i&&i.t==='part')?i.comp:null);
  if(comp){
    const P=PARTS[comp]||{};
    return `${P.noGlyph?'':`<span class="nz zh">${esc(comp)}</span>`}<span class="nt"><b>${esc(P.name||comp)}</b>${esc(P.vi||'')}</span><button class="more" data-act="more">Chi tiết</button>`;
  }
  return `<span class="nt hintline">Chọn một bộ, rồi bấm ô trả lời của câu.</span>`;
}

/* --- lookup panel --- */
function tileGlyph(c){
  const P=PARTS[c];
  return (P&&P.noGlyph)?onlySVG(P.from,c):esc(c);
}
/* find a word's meaning: current lesson first, then other lessons (words reviewed from earlier lessons) */
function findVocab(word){
  const L=LESSONS[state.lesson];
  let v=L&&L.vocab.find(x=>x.h===word);
  if(v) return v;
  for(const n of Object.keys(LESSONS)){ v=LESSONS[n].vocab.find(x=>x.h===word); if(v) return Object.assign({},v,{lesson:+n}); }
  return null;
}
function onlySVG(ch,comp){
  const G=GLYPHS[ch]; if(!G||!G[comp]) return '';
  return `<svg class="gsvg" viewBox="-125 -125 1250 1250" aria-hidden="true"><path d="${G[comp]}"/></svg>`;
}
function miniGlyphPart(p){
  const P=PARTS[p];
  if(P&&P.noGlyph) return `<span class="mini">${onlySVG(P.from,p)}</span>`;
  return `<span class="zh">${esc(p)}</span>`;
}
function bigGlyphPart(p){
  const P=PARTS[p]||{};
  const inner=P.noGlyph?onlySVG(P.from,p):`<div class="gl zh">${esc(p)}</div>`;
  return `<div class="big"><div class="cb">${inner}</div></div>`;
}
function partChip(p){
  const P=PARTS[p]||{};
  return `<button class="pchip" data-act="part" data-comp="${esc(p)}" title="Bấm để xem thông tin bộ">${miniGlyphPart(p)}<small>${esc(P.name||'')}</small></button>`;
}
function lessonChars(L){const s=new Set();L.vocab.forEach(v=>[...v.h].forEach(c=>s.add(c)));return [...s];}
const closeBtn='<button class="x" data-act="close" aria-label="Đóng thông tin">×</button>';
const vocabHTML=L=>L.vocab.map(v=>`<div class="vi"><span class="zh">${esc(v.h)}</span><span><span class="pin">${esc(v.p)}${v.star?`<span class="star" title="${esc(CFG.starTitle)}">★</span>`:''}</span><span class="m">${esc(v.vi)}${v.proper?' (tên riêng)':''}</span></span></div>`).join('');
/* word count as in the 词语表 word list: vocabulary and proper nouns counted separately */
function vcount(L){const p=L.vocab.filter(v=>v.proper).length,w=L.vocab.length-p;return `${w} từ`+(p?` + ${p} tên riêng`:'');}
function vnote(L){return L.vocab.some(v=>v.star)?`<p class="hint vnote"><span class="star">★</span> = ${esc(CFG.starNote)}</p>`:'';}

let lastPanelKey='';
function renderPanel(){
  const el=$('#panel'); const L=LESSONS[state.lesson];
  const info=state.info;
  const key=JSON.stringify([state.lesson,state.group,info]);
  const open=!!(L&&info&&state.sheet);
  el.classList.toggle('open',open);
  document.body.classList.toggle('sheet-open',open);
  const keep=el.scrollTop;
  if(!L){
    el.innerHTML=`<div class="ph"><h3>Tra cứu</h3></div><p class="hint">Bài này chưa có nội dung.</p>`;
  } else if(!info){
    el.innerHTML=`<div class="ph"><h3>Tra cứu</h3></div><p class="hint">Bấm một bộ trên khay hoặc một chữ trong câu để xem thông tin tại đây.</p><div class="sec"><h4>Từ vựng Bài ${state.lesson} (${vcount(L)})</h4><div class="vlist">${vocabHTML(L)}</div>${vnote(L)}</div>`;
  } else {
    el.innerHTML=panelBody(L,info);
  }
  el.scrollTop=(key===lastPanelKey)?keep:0;
  lastPanelKey=key;
}
function panelBody(L,info){
  const gd=L.groups[state.group], gs=gsOf();
  if(info.t==='part'){
    const p=info.comp, P=PARTS[p]||{};
    const unlocked=info.from==='panel'||partUnlocked(gs,gd,p);
    let h=`<div class="ph"><h3>Thông tin bộ</h3>${closeBtn}</div>`;
    h+=`<div class="pv-head">${bigGlyphPart(p)}<div class="pv-title">${esc(P.name||p)}<small>${esc((P.zh&&P.zh!==p?P.zh+'  ':'')+(P.py&&P.py!=='—'?P.py:''))}</small></div></div>`;
    h+=`<dl class="kv"><dt>Nghĩa</dt><dd>${esc(P.vi||'—')}</dd>`;
    if(P.st) h+=`<dt>Số nét</dt><dd>${P.st}</dd>`;
    h+=`<dt>Vai trò</dt><dd>${esc(P.role||'—')}</dd>`;
    if(P.hsk) h+=`<dt>Cấp HSK</dt><dd class="tagrow">${tags(P.hsk)}</dd>`;
    h+=`</dl>`;
    if(P.tip) h+=`<div class="tip"><b>Mẹo nhớ</b>${esc(P.tip)}</div>`;
    const inChars=lessonChars(L).filter(c=>CHARS[c]&&CHARS[c].parts&&CHARS[c].parts.includes(p));
    h+=`<div class="sec"><h4>Chữ chứa bộ này trong Bài ${state.lesson}</h4>`;
    if(!unlocked) h+=`<div class="lock">${ICON_LOCK}<span>Sẽ hiện khi bạn đặt đúng bộ này (hoặc bấm “Hiện đáp án”).</span></div>`;
    else if(!inChars.length) h+=`<p class="hint">Không có chữ nào khác trong bài.</p>`;
    else h+=`<div class="clist">`+inChars.map(c=>`<div class="citem"><span class="zh">${esc(c)}</span><span class="pin">${esc(CHARS[c].py)}</span><span>${esc(CHARS[c].vi)}</span></div>`).join('')+`</div>`;
    return h+`</div>`;
  }
  /* t==='word' */
  const row=info.q==='ex'?gd.example:gd.items[info.q];
  const chars=[...row.word]; const ch=chars[info.ci]; const C=CHARS[ch]||{};
  const isMiss=(info.ci===row.ci);
  const unlockedChar=info.q==='ex'||gs.revealed||allOk(gs,gd)||(isMiss&&gs.status[info.q]==='ok');
  const wv=findVocab(row.word);
  let h=`<div class="ph"><h3>Từ trong Bài ${state.lesson}</h3>${closeBtn}</div>`;
  h+=`<div class="wv"><span class="wz zh">${esc(row.word)}</span><div><span class="pin" style="font-size:17px">${esc(wv?wv.p:'')}</span><span class="m">${esc(wv?wv.vi:'')}${wv&&wv.lesson?` <em class="from">(từ Bài ${wv.lesson})</em>`:''}</span></div></div>`;
  h+=`<div class="sec"><h4>Chữ đang chọn: <span class="zh">${esc(ch)}</span></h4>`;
  h+=`<dl class="kv"><dt>Phiên âm</dt><dd class="pin">${esc(C.py||'')}</dd><dt>Nghĩa</dt><dd>${esc(C.vi||'—')}</dd>`;
  if(C.st) h+=`<dt>Số nét</dt><dd>${C.st}</dd>`;
  if(C.hsk) h+=`<dt>Cấp HSK</dt><dd class="tagrow">${tags(C.hsk)}</dd>`;
  h+=`</dl></div>`;
  const comps=L.vocab.filter(v=>v.h.includes(ch));
  h+=`<div class="sec"><h4>Từ ghép trong Bài ${state.lesson} có chữ <span class="zh">${esc(ch)}</span></h4><div class="clist">`+comps.map(v=>`<div class="citem"><span class="zh">${esc(v.h)}</span><span class="pin">${esc(v.p)}</span><span>${esc(v.vi)}</span>${v.proper?'<span class="tag">tên riêng</span>':''}</div>`).join('')+`</div></div>`;
  if(C.parts){
    h+=`<div class="sec"><h4>Cấu tạo chữ <span class="zh">${esc(ch)}</span></h4>${C.struct?`<div class="tagrow" style="margin-bottom:8px"><span class="tg">${esc(C.struct)}</span></div>`:''}`;
    if(unlockedChar){
      h+=`<div class="pcs">`+C.parts.map((p,i)=>(i?`<span class="plus">+</span>`:'')+partChip(p)).join('')+`</div><p class="hint" style="margin-top:8px">Bấm vào từng bộ để xem nghĩa.</p>`;
    } else if(isMiss){
      const missing=row.miss;
      h+=`<div class="pcs">`+C.parts.map((p,i)=>(i?`<span class="plus">+</span>`:'')+(p===missing?`<span class="pchip q"><span class="zh">?</span><small>bộ còn thiếu</small></span>`:partChip(p))).join('')+`</div>`;
      h+=`<div class="lock" style="margin-top:8px">${ICON_LOCK}<span>Bộ còn thiếu sẽ hiện khi bạn đặt đúng (hoặc bấm “Hiện đáp án”). Bấm vào bộ đã cho để xem nghĩa.</span></div>`;
    } else {
      h+=`<div class="lock">${ICON_LOCK}<span>Cấu tạo của chữ này hiện sau khi hoàn thành nhóm (hoặc bấm “Hiện đáp án”).</span></div>`;
    }
    h+=`</div>`;
  }
  return h;
}
function renderVocab(){
  const L=LESSONS[state.lesson], box=$('#vocabBox');
  if(!L||!L.vocab){box.style.display='none';return;}
  box.style.display='';
  $('#vocabSummary').textContent=`Từ vựng Bài ${state.lesson} (${vcount(L)})`;
  $('#vocabGrid').innerHTML=vocabHTML(L);
  $('#vocabNote').innerHTML=vnote(L);
}
function render(){
  document.documentElement.style.setProperty('--cwd',SIZES[state.size]+'px');
  renderLessons(); renderStage(); renderPanel(); renderVocab(); fitExample();
}
/* The example's two words side by side can be wider than the column beside the panel: then it is stacked. */
function fitExample(){
  const row=$('.row.ex'); if(!row) return;
  row.classList.remove('stack');
  if(row.scrollWidth>row.clientWidth) row.classList.add('stack');
}
let paperWidth=0;
new ResizeObserver(([e])=>{ if(e.contentRect.width!==paperWidth){ paperWidth=e.contentRect.width; fitExample(); } }).observe($('#paper'));

/* ===================== ACTIONS ===================== */
function place(qi,comp){
  const gs=gsOf();
  if(gs.status[qi]==='ok') return;
  gs.place.forEach((c,i)=>{if(c===comp&&gs.status[i]!=='ok'){gs.place[i]=null;gs.status[i]=null;}});
  gs.place[qi]=comp; gs.status[qi]=null;
  if(state.instant) checkOne(qi);
}
function checkOne(qi){
  const gd=LESSONS[state.lesson].groups[state.group], gs=gsOf();
  if(!gs.place[qi]){gs.status[qi]=null;return;}
  const ok=gs.place[qi]===gd.items[qi].miss;
  gs.status[qi]=ok?'ok':'bad';
  if(ok) gs.fresh=qi;
}
function focusSel(t){
  if(!t||!t.matches||!t.matches(':focus-visible')) return null;
  let s=`[data-act="${t.dataset.act}"]`;
  ['c','q','ci','g','n','s','comp'].forEach(k=>{ if(t.dataset[k]!==undefined) s+=`[data-${k==='comp'?'comp':k}="${t.dataset[k]}"]`; });
  return s;
}
function handle(t){
  const act=t.dataset.act; const L=LESSONS[state.lesson]; const gs=L?gsOf():null;
  const fs=focusSel(t);
  switch(act){
    case 'lesson': state.lesson=+t.dataset.n; state.group=0; state.info=null; state.sheet=false; break;
    case 'group': state.group=+t.dataset.g; state.info=null; state.sheet=false; break;
    case 'next': state.group=Math.min(state.group+1,L.groups.length-1); state.info=null; state.sheet=false; window.scrollTo({top:0,behavior:'smooth'}); $('.stage').scrollTo({top:0,behavior:'smooth'}); break;
    case 'size': state.size=+t.dataset.s; break;
    case 'close': state.info=null; state.sheet=false; break;
    case 'more': { const c=gs&&gs.selChip; if(c&&!(state.info&&state.info.t==='part'&&state.info.comp===c)) state.info={t:'part',comp:c,from:'chip'}; state.sheet=true; break;}
    case 'chip': {
      const c=t.dataset.c;
      state.info={t:'part',comp:c,from:'chip'};
      if(gs.selBox!==null){place(gs.selBox,c);gs.selBox=null;gs.selChip=null;state.sheet=false;}
      else{gs.selChip=(gs.selChip===c?null:c);state.sheet=false;if(!gs.selChip)state.info=null;}
      break;}
    case 'box': {
      const q=+t.dataset.q; state.sheet=false;
      if(gs.status[q]==='ok') break;
      if(gs.selChip){place(q,gs.selChip);gs.selChip=null;gs.selBox=null;}
      else{
        if(gs.place[q]){gs.place[q]=null;gs.status[q]=null;}
        gs.selBox=(gs.selBox===q?null:q);
      }
      break;}
    case 'cell': state.info={t:'word',q:(t.dataset.q==='ex'?'ex':+t.dataset.q),ci:+t.dataset.ci}; state.sheet=true; break;
    case 'part': state.info={t:'part',comp:t.dataset.comp,from:'panel'}; state.sheet=true; break;
    case 'check': gs.place.forEach((c,i)=>{if(gs.status[i]!=='ok') checkOne(i);}); break;
    case 'reveal': { const gd=L.groups[state.group]; gd.items.forEach((it,i)=>{gs.place[i]=it.miss;gs.status[i]='ok';}); gs.revealed=true; gs.selChip=null;gs.selBox=null; break;}
    case 'reset': { const gd=L.groups[state.group]; gs.place=gd.items.map(()=>null);gs.status=gd.items.map(()=>null);gs.revealed=false;gs.doneShown=false;gs.selChip=null;gs.selBox=null; if(state.info&&state.info.t==='part'&&state.info.from==='chip'){state.info=null;state.sheet=false;} break;}
    case 'shuffle': { const a=gs.order; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} break;}
  }
  render();
  if(fs){ const n=document.querySelector(fs); if(n) n.focus({preventScroll:true}); }
}
document.addEventListener('click',e=>{
  const t=e.target.closest('[data-act]'); if(!t) return;
  if(t.dataset.act==='instant') return; // handled in the change event
  handle(t);
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&state.info){state.info=null;state.sheet=false;render();return;}
  if(e.key!=='Enter'&&e.key!==' ') return;
  const t=e.target.closest&&e.target.closest('[role="button"][data-act]'); if(!t) return;
  e.preventDefault(); handle(t);
});
document.addEventListener('change',e=>{
  if(e.target.dataset&&e.target.dataset.act==='instant'){
    state.instant=e.target.checked; render();
    const n=document.querySelector('[data-act="instant"]'); if(n) n.focus({preventScroll:true});
  }
});
render();
</script>
</body>
</html>
