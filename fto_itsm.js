// ==UserScript==
// @name         Assyst Auto-Return ITSM
// @namespace    https://github.com/kodxuk/tampermonkey
// @version      1.8
// @updateURL    https://raw.githubusercontent.com/kodxuk/tampermonkey/refs/heads/main/fto_itsm.js
// @downloadURL  https://raw.githubusercontent.com/kodxuk/tampermonkey/refs/heads/main/fto_itsm.js
// @description  Надёжный автоворзват: активная вкладка, межвкладочный lock, офлайн-гейтинг, холодный старт-деградация, fallback из хэша, автоклик, watchdog, постоянные бейдж/баннер (session)
// @author       kodx
// @match        https://itsm.cherkizovsky.net/*
// @match        https://itsm/assystweb/*
// @exclude      https://itsm/assystweb/scripts_release/dojo/resources/blank.html*
// @exclude      https://itsm.cherkizovsky.net/assystweb/scripts_release/dojo/resources/blank.html*
// @run-at       document-start
// @noframes
// @grant        none
// @license      MIT
// ==UserScript==

(function () {
  'use strict';

  // ===== Config =====
  const DEBUG = false;
  const ACTIVE_ONLY  = true;
  const SUPPRESS_MS  = 25000;                 // окно подавления других вкладок
  const WATCHDOG_MS  = 7000;                  // проверка «белого экрана»
  const LAST_TTL_MS  = 24*60*60*1000;         // валидность last URL
  const COLD_START_DOWNGRADE_MS = 5*60*1000;  // первые 5 минут — предпочесть список
  const AUTOREFRESH_GRACE_MS = 12000;         // грейс на экранах списка
  const NET_ACTIVITY_WINDOW_MS = 5000;        // «недавняя» сеть

  // ===== Keys / channel =====
  const KEY_LAST_OBJ = 'assyst_last_obj';
  const TRACE_KEY    = 'assyst_return_trace';
  const TAB_ID_KEY   = 'assyst_tab_id';
  const LOCK_KEY     = 'assyst_return_lock';
  const BUS_NAME     = 'assyst_ar_bus';

  // ===== Utils/trace =====
  const TAG='[AssystAR]';
  const info=(...a)=>DEBUG&&console.info(TAG,...a);
  const warn=(...a)=>DEBUG&&console.warn(TAG,...a);
  const dbg=(...a)=>DEBUG&&console.debug&&console.debug(TAG,...a);
  const now=()=>Date.now();
  const fmtMs=v=>{v=Math.max(0,v|0);const s=Math.floor(v/1000),m=Math.floor(s/60),h=Math.floor(m/60);
    const ss=(s%60).toString().padStart(2,'0'),mm=(m%60).toString().padStart(2,'0');return h?`${h}:${mm}:${ss}`:`${m}:${ss}`;};

  const TRACE_MAX=20; const trace=[];
  const pushTrace=(type,data={})=>{trace.push({ts:now(),type,data}); if(trace.length>TRACE_MAX)trace.shift(); DEBUG&&console.log(TAG,'trace',type,data);};

  // ===== Stable tab id =====
  let TAB_ID=sessionStorage.getItem(TAB_ID_KEY);
  if(!TAB_ID){ TAB_ID=Math.random().toString(36).slice(2); sessionStorage.setItem(TAB_ID_KEY,TAB_ID); }

  // ===== UI: debug badge + banner =====
  if(DEBUG){
    const mountBadge=()=>{ if(document.getElementById('assystar-debug-badge'))return;
      const el=document.createElement('div'); el.id='assystar-debug-badge'; el.textContent='Debug: ON';
      Object.assign(el.style,{position:'fixed',right:'8px',bottom:'8px',zIndex:2147483647,background:'rgba(255,215,0,.9)',color:'#000',padding:'2px 6px',font:'12px/16px monospace',borderRadius:'4px',boxShadow:'0 0 0 1px #0003',pointerEvents:'none'});
      document.body.appendChild(el);
    };
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountBadge,{once:true}); else mountBadge();
  }
  const mountReturnBanner=(txt)=>{
    const id='assystar-return-banner';
    const el=document.getElementById(id)||(()=>{ const n=document.createElement('div'); n.id=id;
      Object.assign(n.style,{position:'fixed',right:'8px',bottom:'36px',zIndex:2147483647,background:'rgba(46,204,113,.95)',color:'#000',padding:'4px 8px',font:'12px/16px sans-serif',borderRadius:'4px',boxShadow:'0 0 0 1px #0003',pointerEvents:'none'});
      const m=()=>document.body.appendChild(n); if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',m,{once:true}); else m(); return n; })();
    el.textContent=`Возврат выполнен: ${txt}`;
  };
  (function showTraceOnce(){ try{ const raw=sessionStorage.getItem(TRACE_KEY); if(!raw)return; sessionStorage.removeItem(TRACE_KEY);
    const t=JSON.parse(raw); pushTrace('banner_show',t); if(t&&t.ts) mountReturnBanner(new Date(t.ts).toLocaleString('ru-RU',{hour12:false})); }catch{} })();

  // ===== Routing helpers =====
  const S='(?:\\\/|%2F)';
  const ROUTE={EVENT:new RegExp(`#event${S}DisplayEvent\\.do\\b`,'i'),
               SEARCH:new RegExp(`#eventsearch${S}EventSearchDelegatingDispatchAction\\.do\\b`,'i'),
               WELCOME:new RegExp(`#welcome${S}WelcomeDispatchAction\\.do\\b`,'i')};
  const canonicalize=(href)=>{ try{
      const [base,rawHash='']=href.split('#'); const u=new URL(base); let h=rawHash; try{h=decodeURIComponent(h);}catch{}
      h=h.replace(/([?&])(checkJukeBoxSettings|resultSet)=[^&#]*/gi,'$1').replace(/[?&]+$/,'').replace(/[?&]{2,}/g,'&').replace('?&','?');
      return `${u.origin}${u.pathname}#${h}`;
    }catch{return href;} };
  const isWorkingPage=()=>/\/assystweb\/application\.do$/i.test(location.pathname)&&location.hash.length>1;
  const routeRank=(href)=>{ const h=canonicalize(href); if(ROUTE.EVENT.test(h))return 3; if(ROUTE.SEARCH.test(h))return 2; if(ROUTE.WELCOME.test(h))return 0; return 1; };
  const isAcceptable=(u)=>u&&u.startsWith(location.origin)&&/\/assystweb\/application\.do#/i.test(u);

  // auto-refresh hints
  const isEventSearchPage=()=>/#eventsearch\/EventSearchDelegatingDispatchAction\.do\b/i.test(location.href);
  const hasAutoRefreshUI=()=>!!document.querySelector('[title*="Обновление"][role="menu"], [data-refresh], .auto-refresh');
  const hadRecentNetwork=()=>{ try{
      const n=performance.now(); const es=performance.getEntriesByType('resource');
      for(let i=es.length-1;i>=0;i--){ if(n-es[i].responseEnd<=NET_ACTIVITY_WINDOW_MS)return true; if(n-es[i].startTime>NET_ACTIVITY_WINDOW_MS)break; }
    }catch{} return false; };
  const hasListContent=()=>!!document.querySelector('table, .slickgrid, .dataTable, [role="grid"]');

  // ===== Save last =====
  let lastRankSeen=-1,lastHref=null,saveTimer=null;
  const saveLast=(why='event')=>{
    if(/\/logout\/|sessionInvalid=true/i.test(location.href)){dbg('Skip save: logout',why);return;}
    if(!isWorkingPage()){dbg('Skip save: not app.do',location.href);return;}
    if(document.visibilityState!=='visible'){dbg('Skip save: hidden');return;}
    if(isEventSearchPage()&&(why==='hashchange'||hadRecentNetwork())){dbg('Skip save: auto-refresh',why);return;}
    const href=canonicalize(location.href); const r=routeRank(href);
    if(r<=0||href===lastHref||r<lastRankSeen) return;
    lastRankSeen=r; lastHref=href;
    clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>{ const obj={href,ts:now(),rank:r};
      localStorage.setItem(KEY_LAST_OBJ,JSON.stringify(obj));
      sessionStorage.setItem(KEY_LAST_OBJ,JSON.stringify(obj));
      pushTrace('save_last',{why,href,rank:r}); info('Saved last:',{href:obj.href,rank:obj.rank,at:new Date(obj.ts).toLocaleString('ru-RU')},'why=',why);
    },200);
  };
  ['load','popstate','hashchange','click','keydown','visibilitychange'].forEach(ev=>addEventListener(ev,()=>saveLast(ev),{passive:true}));
  saveLast('bootstrap');

  const readLast=()=>{ const raw=sessionStorage.getItem(KEY_LAST_OBJ)||localStorage.getItem(KEY_LAST_OBJ); if(!raw)return null; try{return JSON.parse(raw);}catch{return null;} };

  // ===== Fallback from logout hash =====
  const routeFromHash=()=>{ if(!location.hash||location.hash.length<=1)return null;
    try{ const dec=decodeURIComponent(location.hash.slice(1)); if(!/^[-_a-zA-Z0-9/%?=&.]+$/.test(dec)) return null;
      return location.origin+'/assystweb/application.do#'+dec; }catch{return null;} };

  // ===== Auto-click return button =====
  const clickReturnButton=()=>{ const attempt=()=>{ const btn=[...document.querySelectorAll('a,button')].find(n=>/вернуться в сервисдеск|войти|login/i.test(n.textContent||'')); if(btn){pushTrace('click_return_btn'); info('Click fallback button'); btn.click(); return true;} return false; };
    if(attempt())return; const mo=new MutationObserver(()=>{ if(attempt()) mo.disconnect(); }); mo.observe(document.documentElement,{childList:true,subtree:true}); };

  // ===== Active tab =====
  const isActive=()=>document.visibilityState==='visible' && document.hasFocus && document.hasFocus();

  // ===== Inter-tab suppression/lock with time-safety =====
  const bus=('BroadcastChannel' in window)? new BroadcastChannel(BUS_NAME):null;
  let suppressUntil=0, lastSuppressTs=0, busMsgCount=0;

  const clampSupp=(ts)=>{ // кэп: не дальше SUPPRESS_MS от «сейчас»
    const maxTs=now()+SUPPRESS_MS; return Math.min(ts, maxTs);
  };

  bus && (bus.onmessage=(e)=>{ if(e?.data?.type==='returned'||e?.data?.type==='suppress'){
      suppressUntil = clampSupp(now()+SUPPRESS_MS);
      lastSuppressTs = now(); busMsgCount++; pushTrace('bus_msg',e.data);
    }} );

  const announceSuppress=()=>{ bus && bus.postMessage({type:'suppress',ts:now()}); pushTrace('suppress_broadcast'); };

  const lockAcquire=()=>{
    const t=now(); let lock=null; try{lock=JSON.parse(localStorage.getItem(LOCK_KEY)||'null');}catch{}
    // авто-ремонт: если лок застарел > 4 окон подавления — убрать
    if(lock && (t - lock.ts) > SUPPRESS_MS*4){ localStorage.removeItem(LOCK_KEY); pushTrace('lock_autofix',{stale_ms:t-lock.ts}); lock=null; }
    if(lock && t - lock.ts < SUPPRESS_MS){ if(lock.tabId===TAB_ID) return true; return false; }
    localStorage.setItem(LOCK_KEY,JSON.stringify({tabId:TAB_ID,ts:t})); pushTrace('lock_acquire',{tabId:TAB_ID}); return true;
  };
  const lockRelease=()=>{ try{ const lock=JSON.parse(localStorage.getItem(LOCK_KEY)||'null'); if(!lock||lock.tabId===TAB_ID) localStorage.removeItem(LOCK_KEY); pushTrace('lock_release',{own:!lock||lock.tabId===TAB_ID}); }catch{} };

  addEventListener('storage',(e)=>{ if(e.key===LOCK_KEY){
      // любое обновление лока трактуем как подавление, но с кэпом времени
      suppressUntil = clampSupp(now()+SUPPRESS_MS);
      lastSuppressTs = now(); pushTrace('storage_lock',{value:e.newValue});
    }});

  // ===== Watchdog (one-step) =====
  const pageLooksBlank=()=>{ const b=document.body; if(!b) return true; const child=b.children.length; const txt=(b.textContent||'').trim().length; return child<3 && txt<40; };
  const addCacheBusterToHash=(href)=>{ try{ const [base,hash='']=href.split('#'); if(!hash) return href; const qi=hash.indexOf('?'); return qi===-1? `${base}#${hash}?_r=${now()}`: `${base}#${hash}&_r=${now()}`; }catch{return href;} };
  const toSearchBase=()=>location.origin+'/assystweb/application.do#eventsearch/EventSearchDelegatingDispatchAction.do?dispatch=loadQuery';

  let nextWatchdogAt=0,lastWatchdogAction=null;
  const scheduleWatchdog=()=>{ if(!isWorkingPage()) return;
    const delay = isEventSearchPage()? (WATCHDOG_MS+AUTOREFRESH_GRACE_MS): WATCHDOG_MS;
    nextWatchdogAt=now()+delay; pushTrace('watchdog_scheduled',{at:nextWatchdogAt,delay});
    setTimeout(()=>{ if(isEventSearchPage() && (hadRecentNetwork()||hasAutoRefreshUI()||hasListContent())){ pushTrace('watchdog_skip','auto-refresh'); return; }
      if(!pageLooksBlank()){ pushTrace('watchdog_ok',{}); return; }
      const target = addCacheBusterToHash(location.href) || toSearchBase();
      lastWatchdogAction={ts:now(),target}; pushTrace('watchdog_reload',lastWatchdogAction); info('Watchdog reload ->',target);
      location.replace(target);
    }, delay);
  };

  // ===== Try return =====
  const tryReturn=(why='auto')=>{
    if(ACTIVE_ONLY && !isActive()){ dbg('Skip return: not active'); return false; }
    if(now() < suppressUntil){ dbg('Skip return: suppressed'); return false; }
    if(!lockAcquire()){ dbg('Skip return: lock held'); return false; }

    const last  = readLast();
    const fromH = routeFromHash();
    let target  = last && last.href;
    const ageOk = last && (now()-last.ts) <= LAST_TTL_MS;

    if((!target || !ageOk) && fromH) target = fromH;

    const bootKey='assyst_session_boot';
    if(!sessionStorage.getItem(bootKey)) sessionStorage.setItem(bootKey,String(now()));
    const cold = (now() - Number(sessionStorage.getItem(bootKey))) < COLD_START_DOWNGRADE_MS;
    if(cold && target && /#event\/DisplayEvent\.do\b/i.test(target)){
      target = target.replace(/#event\/DisplayEvent\.do/i,'#eventsearch/EventSearchDelegatingDispatchAction.do');
      dbg('Cold-start: downgrade to SEARCH');
    }

    if(!isAcceptable(target)){ dbg('No acceptable/stale target',{last,fromH}); lockRelease(); return false; }

    const payload={ts:now(),why,target};
    try{ sessionStorage.setItem(TRACE_KEY,JSON.stringify(payload)); }catch{}
    bus && bus.postMessage({type:'returned',ts:payload.ts});
    announceSuppress();
    pushTrace('redirect',payload); info('Redirect ->',target);
    location.replace(target);
    return true;
  };

  // ===== Wiring =====
  const logoutLike=/\/logout\/|sessionInvalid=true/i.test(location.href);
  const loginLike =/login|signin|authenticate/i.test(location.pathname);

  if(logoutLike){
    if(!tryReturn('logout')){
      clickReturnButton();
      document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') tryReturn('visible'); });
      addEventListener('focus',()=>tryReturn('focus'));
    }
  }
  if(!logoutLike && loginLike){ addEventListener('load',()=>setTimeout(()=>tryReturn('after-login'),500)); }
  addEventListener('load',scheduleWatchdog,{once:true});
  document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') scheduleWatchdog(); });

  // ===== Compact HUD =====
  if(DEBUG){
    const elId=id=>document.getElementById(id);
    const panel=()=>{ if(elId('assystar-debug-panel'))return;
      const el=document.createElement('div'); el.id='assystar-debug-panel'; el.setAttribute('role','status'); el.setAttribute('aria-live','polite');
      Object.assign(el.style,{position:'fixed',right:'8px',bottom:'64px',zIndex:2147483647,background:'rgba(0,0,0,.8)',color:'#fff',padding:'6px 8px',font:'12px/16px ui-monospace,Consolas,monospace',borderRadius:'6px',boxShadow:'0 2px 8px #0008',minWidth:'320px',maxWidth:'560px',pointerEvents:'auto',whiteSpace:'normal'});
      const expanded=sessionStorage.getItem('assystar_debug_expanded')==='1';
      el.innerHTML=[
        '<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">',
        '<strong style="font-weight:600">AssystAR • Debug</strong>',
        `<button id="ar_toggle" style="margin-left:auto;background:#444;color:#fff;border:1px solid #666;border-radius:3px;padding:1px 6px;cursor:pointer">${expanded?'Свернуть':'Подробнее'}</button>`,
        '<button id="ar_close" style="background:transparent;color:#fff;border:none;cursor:pointer;font-size:14px">×</button>',
        '</div>',
        '<div id="ar_compact" style="display:block;line-height:1.3"></div>',
        `<div id="ar_extra" style="display:${expanded?'block':'none'};margin-top:6px;border-top:1px solid #ffffff33;padding-top:6px">`,
        '<div id="ar_lines" style="max-height:150px;overflow:auto"></div>',
        `<div style="margin-top:4px"><div style="font-weight:600;margin-bottom:2px">trace (last ${TRACE_MAX}):</div><div id="ar_trace" style="max-height:140px;overflow:auto;border:1px solid #ffffff22;padding:4px"></div></div>`,
        '</div>'
      ].join('');
      document.body.appendChild(el);
      // drag
      let sx=0,sy=0,ox=0,oy=0,drag=false;
      el.addEventListener('mousedown',(e)=>{ if((e.target.id||'').startsWith('ar_')) return; drag=true; sx=e.clientX; sy=e.clientY; ox=parseInt(el.style.right)||8; oy=parseInt(el.style.bottom)||64; el.style.cursor='grabbing'; });
      window.addEventListener('mouseup',()=>{ drag=false; el.style.cursor='default'; });
      window.addEventListener('mousemove',(e)=>{ if(!drag)return; const dx=e.clientX-sx,dy=e.clientY-sy; el.style.right=Math.max(0,ox-dx)+'px'; el.style.bottom=Math.max(0,oy-dy)+'px'; });
      elId('ar_close').onclick=()=>el.remove();
      elId('ar_toggle').onclick=()=>{ const ex=elId('ar_extra'); const btn=elId('ar_toggle'); const show=ex.style.display==='none'; ex.style.display=show?'block':'none'; btn.textContent=show?'Свернуть':'Подробнее'; sessionStorage.setItem('assystar_debug_expanded',show?'1':'0'); };
    };
    const upd=()=>{
      const set=(id,html)=>{ const n=elId(id); if(n) n.innerHTML=html; };
      const lock=(()=>{try{return JSON.parse(localStorage.getItem(LOCK_KEY)||'null');}catch{return null;}})();
      const t=now();
      const vis=document.visibilityState; const foc=(document.hasFocus&&document.hasFocus())?'yes':'no';
      const sup=lock? Math.max(0, SUPPRESS_MS - (t - lock.ts)) : 0; const supS=fmtMs(sup);
      const lockStr=lock? `${String(lock.tabId||'').slice(0,6)} ${fmtMs(t-lock.ts)}` : '—';
      const boot=Number(sessionStorage.getItem('assyst_session_boot')||t); const cold=(t-boot)<COLD_START_DOWNGRADE_MS?'yes':'no';
      const page=isEventSearchPage()? 'eventsearch' : (/#event\/DisplayEvent\.do\b/i.test(location.href)? 'event':'other');
      const last=(()=>{try{return JSON.parse(sessionStorage.getItem(KEY_LAST_OBJ)||localStorage.getItem(KEY_LAST_OBJ)||'null');}catch{return null;}})();
      const lastRank=last? last.rank:'-';
      const targetPreview=(last&&last.href)? (/#event\/DisplayEvent\.do\b/i.test(last.href)? 'event':'list') : '—';
      const compact=[
        `vis: ${vis} focus: ${foc} | sup: ${supS} | lock: ${lockStr}`,
        `cold: ${cold} | page: ${page} | last: rank=${lastRank} | target: ${targetPreview}`,
        `bus: ${busMsgCount} | wd next: ${nextWatchdogAt? new Date(nextWatchdogAt).toLocaleTimeString('ru-RU',{hour12:false}):'—'} | blank: ${pageLooksBlank()?'yes':'no'}`
      ].join('<br/>');
      set('ar_compact',compact);

      const ex=elId('ar_extra'); if(!ex||ex.style.display==='none')return;
      const lines=[]; lines.push(`tabId: ${TAB_ID}`); lines.push(`network: ${navigator.onLine?'online':'offline'}`);
      const lastObj = last ? `rank=${last.rank} age=${fmtMs(t-(last.ts||t))} ${last.href}` : '—';
      lines.push(`lastURL: ${lastObj}`);
      lines.push(`lock owner: ${lock? lock.tabId:'—'} age: ${lock? fmtMs(t-lock.ts):'—'}`);
      lines.push(`boot age: ${fmtMs(t-boot)}`);
      lines.push(`from hash: ${location.hash&&location.hash.length>1? 'maybe':'no'}`);
      set('ar_lines',lines.join('<br/>'));

      const box=elId('ar_trace'); if(box) box.textContent = trace.map(x=>`${new Date(x.ts).toLocaleTimeString('ru-RU',{hour12:false})} • ${x.type} ${JSON.stringify(x.data)}`).join('\n');
    };
    const ensure=()=>{ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',panel,{once:true}); else panel(); };
    ensure(); upd(); setInterval(upd,1000);
  }

  // ===== Session boot mark =====
  if(!sessionStorage.getItem('assyst_session_boot')) sessionStorage.setItem('assyst_session_boot', String(now()));
})();
