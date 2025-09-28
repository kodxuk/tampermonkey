// ==UserScript==
// @name         Assyst Auto-Return ITSM
// @namespace    https://github.com/kodxuk/tampermonkey
// @version      1.7
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
  const SUPPRESS_MS  = 25000;
  const WATCHDOG_MS  = 7000;
  const LAST_TTL_MS  = 24*60*60*1000;
  const COLD_START_DOWNGRADE_MS = 5*60*1000;

  const AUTOREFRESH_GRACE_MS = 12000;
  const NET_ACTIVITY_WINDOW_MS = 5000;

  // ===== Keys / channel =====
  const KEY_LAST_OBJ = 'assyst_last_obj';
  const TRACE_KEY    = 'assyst_return_trace';
  const TAB_ID_KEY   = 'assyst_tab_id';
  const LOCK_KEY     = 'assyst_return_lock';
  const BUS_NAME     = 'assyst_ar_bus';

  // ===== Utils =====
  const TAG='[AssystAR]';
  const info=(...a)=>DEBUG&&console.info(TAG,...a);
  const warn=(...a)=>DEBUG&&console.warn(TAG,...a);
  const dbg=(...a)=>DEBUG&&console.debug&&console.debug(TAG,...a);
  const nowMs=()=>Date.now();
  const ms=(n)=>Math.max(0,n|0);
  const fmtTime=(t)=>new Date(t).toLocaleTimeString('ru-RU',{hour12:false});
  const fmtMs=(v)=>{let x=ms(v);const s=Math.floor(x/1000);const m=Math.floor(s/60);const h=Math.floor(m/60);const ss=(s%60).toString().padStart(2,'0');const mm=(m%60).toString().padStart(2,'0');return h?`${h}:${mm}:${ss}`:`${m}:${ss}`;};

  // ===== Stable tab id =====
  let TAB_ID = sessionStorage.getItem(TAB_ID_KEY);
  if (!TAB_ID){ TAB_ID = Math.random().toString(36).slice(2); sessionStorage.setItem(TAB_ID_KEY, TAB_ID); }

  // ===== Trace buffer (ring) =====
  const TRACE_MAX=20;
  const trace=[];
  const pushTrace=(type, data={})=>{
    trace.push({ts:nowMs(), type, data});
    if(trace.length>TRACE_MAX) trace.shift();
    DEBUG&&console.log(TAG,'trace',type,data);
  };

  // ===== UI: debug badge + banner =====
  if (DEBUG){
    const mountBadge=()=>{
      if(document.getElementById('assystar-debug-badge'))return;
      const el=document.createElement('div');
      el.id='assystar-debug-badge';
      el.textContent='Debug: ON';
      Object.assign(el.style,{position:'fixed',right:'8px',bottom:'8px',zIndex:2147483647,background:'rgba(255,215,0,.9)',color:'#000',padding:'2px 6px',font:'12px/16px monospace',borderRadius:'4px',boxShadow:'0 0 0 1px #0003',pointerEvents:'none'});
      document.body.appendChild(el);
    };
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountBadge,{once:true}); else mountBadge();
  }
  const mountReturnBanner=(txt)=>{
    const id='assystar-return-banner';
    const el=document.getElementById(id)||(()=>{
      const n=document.createElement('div'); n.id=id;
      Object.assign(n.style,{position:'fixed',right:'8px',bottom:'36px',zIndex:2147483647,background:'rgba(46,204,113,.95)',color:'#000',padding:'4px 8px',font:'12px/16px sans-serif',borderRadius:'4px',boxShadow:'0 0 0 1px #0003',pointerEvents:'none'});
      const mount=()=>document.body.appendChild(n);
      if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true}); else mount();
      return n;
    })();
    el.textContent=`Возврат выполнен: ${txt}`;
  };
  (function showTraceOnce(){
    try{
      const raw=sessionStorage.getItem(TRACE_KEY); if(!raw)return;
      sessionStorage.removeItem(TRACE_KEY);
      const t=JSON.parse(raw); pushTrace('banner_show',t);
      if(t&&t.ts) mountReturnBanner(new Date(t.ts).toLocaleString('ru-RU',{hour12:false}));
    }catch{}
  })();

  // ===== Routing helpers =====
  const S='(?:\\\/|%2F)';
  const ROUTE={EVENT:new RegExp(`#event${S}DisplayEvent\\.do\\b`,'i'),
               SEARCH:new RegExp(`#eventsearch${S}EventSearchDelegatingDispatchAction\\.do\\b`,'i'),
               WELCOME:new RegExp(`#welcome${S}WelcomeDispatchAction\\.do\\b`,'i')};
  const canonicalize=(href)=>{
    try{
      const [base,rawHash='']=href.split('#');
      const u=new URL(base); let h=rawHash; try{h=decodeURIComponent(h);}catch{}
      h=h.replace(/([?&])(checkJukeBoxSettings|resultSet)=[^&#]*/gi,'$1')
         .replace(/[?&]+$/,'').replace(/[?&]{2,}/g,'&').replace('?&','?');
      return `${u.origin}${u.pathname}#${h}`;
    }catch{return href;}
  };
  const isWorkingPage=()=>/\/assystweb\/application\.do$/i.test(location.pathname)&&location.hash.length>1;
  const routeRank=(href)=>{
    const h=canonicalize(href);
    if(ROUTE.EVENT.test(h))return 3;
    if(ROUTE.SEARCH.test(h))return 2;
    if(ROUTE.WELCOME.test(h))return 0;
    return 1;
  };
  const isAcceptable=(u)=>u&&u.startsWith(location.origin)&&/\/assystweb\/application\.do#/i.test(u);

  // Auto-refresh heuristics
  const isEventSearchPage=()=>/#eventsearch\/EventSearchDelegatingDispatchAction\.do\b/i.test(location.href);
  const hasAutoRefreshUI=()=>!!document.querySelector('[title*="Обновление"][role="menu"], [data-refresh], .auto-refresh');
  const hadRecentNetwork=()=>{
    try{
      const n=performance.now(); const es=performance.getEntriesByType('resource');
      for(let i=es.length-1;i>=0;i--){ if(n-es[i].responseEnd<=NET_ACTIVITY_WINDOW_MS)return true; if(n-es[i].startTime>NET_ACTIVITY_WINDOW_MS)break; }
    }catch{} return false;
  };
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
    saveTimer=setTimeout(()=>{
      const obj={href,ts:nowMs(),rank:r};
      localStorage.setItem(KEY_LAST_OBJ,JSON.stringify(obj));
      sessionStorage.setItem(KEY_LAST_OBJ,JSON.stringify(obj));
      pushTrace('save_last',{why,href,rank:r}); info('Saved last:',{href:obj.href,rank:obj.rank,at:new Date(obj.ts).toLocaleString('ru-RU')},'why=',why);
    },200);
  };
  ['load','popstate','hashchange','click','keydown','visibilitychange']
    .forEach(ev=>addEventListener(ev,()=>saveLast(ev),{passive:true}));
  saveLast('bootstrap');

  const readLast=()=>{const raw=sessionStorage.getItem(KEY_LAST_OBJ)||localStorage.getItem(KEY_LAST_OBJ); if(!raw)return null; try{return JSON.parse(raw);}catch{return null;}};

  // Fallback from logout hash
  const routeFromHash=()=>{
    if(!location.hash||location.hash.length<=1)return null;
    try{
      const dec=decodeURIComponent(location.hash.slice(1));
      if(!/^[-_a-zA-Z0-9/%?=&.]+$/.test(dec)) return null;
      return location.origin+'/assystweb/application.do#'+dec;
    }catch{return null;}
  };

  // Auto-click
  const clickReturnButton=()=>{
    const attempt=()=>{
      const btn=[...document.querySelectorAll('a,button')].find(n=>/вернуться в сервисдеск|войти|login/i.test(n.textContent||''));
      if(btn){ pushTrace('click_return_btn'); info('Click fallback button'); btn.click(); return true; }
      return false;
    };
    if(attempt())return;
    const mo=new MutationObserver(()=>{ if(attempt()) mo.disconnect(); });
    mo.observe(document.documentElement,{childList:true,subtree:true});
  };

  // Active tab
  const isActive=()=>document.visibilityState==='visible' && document.hasFocus && document.hasFocus();

  // Inter-tab suppression / lock
  const bus=('BroadcastChannel' in window)? new BroadcastChannel(BUS_NAME):null;
  let suppressUntil=0; let lastSuppressTs=0; let busMsgCount=0;
  bus && (bus.onmessage=(e)=>{ if(e?.data?.type==='returned'||e?.data?.type==='suppress'){ suppressUntil=nowMs()+SUPPRESS_MS; lastSuppressTs=nowMs(); busMsgCount++; pushTrace('bus_msg',e.data);} });

  const announceSuppress=()=>{ bus && bus.postMessage({type:'suppress',ts:nowMs()}); pushTrace('suppress_broadcast'); };

  const lockAcquire=()=>{
    const t=nowMs(); let lock=null; try{ lock=JSON.parse(localStorage.getItem(LOCK_KEY)||'null'); }catch{}
    if(lock && t-lock.ts < SUPPRESS_MS){ if(lock.tabId===TAB_ID) return true; return false; }
    localStorage.setItem(LOCK_KEY,JSON.stringify({tabId:TAB_ID,ts:t}));
    pushTrace('lock_acquire',{tabId:TAB_ID}); return true;
  };
  const lockRelease=()=>{
    try{
      const lock=JSON.parse(localStorage.getItem(LOCK_KEY)||'null');
      if(!lock || lock.tabId===TAB_ID) localStorage.removeItem(LOCK_KEY);
      pushTrace('lock_release',{own:!lock||lock.tabId===TAB_ID});
    }catch{}
  };
  addEventListener('storage',(e)=>{ if(e.key===LOCK_KEY && e.newValue){ suppressUntil=nowMs()+SUPPRESS_MS; lastSuppressTs=nowMs(); pushTrace('storage_lock',{value:e.newValue}); } });

  // Watchdog
  const pageLooksBlank=()=>{
    const b=document.body; if(!b) return true;
    const child=b.children.length; const txt=(b.textContent||'').trim().length;
    return child<3 && txt<40;
  };
  const addCacheBusterToHash=(href)=>{
    try{
      const [base,hash='']=href.split('#'); if(!hash) return href;
      const qi=hash.indexOf('?'); return qi===-1? `${base}#${hash}?_r=${nowMs()}` : `${base}#${hash}&_r=${nowMs()}`;
    }catch{return href;}
  };
  const toSearchBase=()=>location.origin+'/assystweb/application.do#eventsearch/EventSearchDelegatingDispatchAction.do?dispatch=loadQuery';

  let nextWatchdogAt=0; let lastWatchdogAction=null;
  const scheduleWatchdog=()=>{
    if(!isWorkingPage()) return;
    const delay = isEventSearchPage()? (WATCHDOG_MS+AUTOREFRESH_GRACE_MS): WATCHDOG_MS;
    nextWatchdogAt = nowMs()+delay; pushTrace('watchdog_scheduled',{at:nextWatchdogAt,delay});
    setTimeout(()=>{
      if(isEventSearchPage() && (hadRecentNetwork()||hasAutoRefreshUI()||hasListContent())){ pushTrace('watchdog_skip','auto-refresh'); return; }
      if(!pageLooksBlank()){ pushTrace('watchdog_ok'); return; }
      const target = addCacheBusterToHash(location.href) || toSearchBase();
      lastWatchdogAction = {ts: nowMs(), target};
      pushTrace('watchdog_reload',lastWatchdogAction); info('Watchdog reload ->',target);
      location.replace(target);
    }, delay);
  };

  // Try return
  const tryReturn=(why='auto')=>{
    if(ACTIVE_ONLY && !isActive()){ dbg('Skip return: not active'); return false; }
    if(nowMs()<suppressUntil){ dbg('Skip return: suppressed'); return false; }
    if(!lockAcquire()){ dbg('Skip return: lock held'); return false; }

    const last = readLast();
    const fromH = routeFromHash();
    let target = last && last.href;
    const ageOk = last && (nowMs()-last.ts)<=LAST_TTL_MS;

    if((!target||!ageOk) && fromH) target = fromH;

    const bootKey='assyst_session_boot';
    if(!sessionStorage.getItem(bootKey)) sessionStorage.setItem(bootKey,String(nowMs()));
    const cold = (nowMs()-Number(sessionStorage.getItem(bootKey)))<COLD_START_DOWNGRADE_MS;
    if(cold && target && /#event\/DisplayEvent\.do\b/i.test(target)){
      target = target.replace(/#event\/DisplayEvent\.do/i,'#eventsearch/EventSearchDelegatingDispatchAction.do');
      dbg('Cold-start: downgrade to SEARCH');
    }

    if(!isAcceptable(target)){ dbg('No acceptable/stale target',{last,fromH}); lockRelease(); return false; }

    const payload={ts:nowMs(),why,target};
    try{ sessionStorage.setItem(TRACE_KEY,JSON.stringify(payload)); }catch{}
    bus && bus.postMessage({type:'returned',ts:payload.ts});
    announceSuppress();
    pushTrace('redirect',payload); info('Redirect ->',target);
    location.replace(target);
    return true;
  };

  // Wiring
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

  // ===== Debug panel (rich) =====
  if(DEBUG){
    const elId=(id)=>document.getElementById(id);
    const panel=()=>{
      if(elId('assystar-debug-panel')) return;
      const el=document.createElement('div'); el.id='assystar-debug-panel'; el.setAttribute('role','status'); el.setAttribute('aria-live','polite');
      Object.assign(el.style,{position:'fixed',right:'8px',bottom:'64px',zIndex:2147483647,background:'rgba(0,0,0,.8)',color:'#fff',padding:'8px 10px',font:'12px/16px ui-monospace,Consolas,monospace',borderRadius:'6px',boxShadow:'0 2px 8px #0008',minWidth:'320px',maxWidth:'520px',pointerEvents:'auto',whiteSpace:'pre-wrap'});
      el.innerHTML=[
        'AssystAR • Debug',
        'tabId: <span id="ar_tab"></span>',
        'vis: <span id="ar_vis"></span> focus: <span id="ar_focus"></span> net: <span id="ar_net"></span>',
        'page: <span id="ar_page"></span> autoRefresh: <span id="ar_ar"></span> blank: <span id="ar_blank"></span>',
        'suppress left: <span id="ar_sup"></span> last: <span id="ar_sup_at"></span>',
        'lock owner: <span id="ar_lock"></span> age: <span id="ar_lock_age"></span>',
        'boot age: <span id="ar_boot"></span> cold: <span id="ar_cold"></span>',
        'lastURL: <span id="ar_last"></span>',
        'watchdog next: <span id="ar_wd_next"></span> last: <span id="ar_wd_last"></span>',
        'bus msgs: <span id="ar_bus"></span>',
        'trace (last '+TRACE_MAX+'):',
        '<div id="ar_trace" style="max-height:150px;overflow:auto;border-top:1px solid #ffffff33;padding-top:4px;"></div>'
      ].join('\n');
      document.body.appendChild(el);

      // drag
      let sx=0,sy=0,ox=0,oy=0,drag=false;
      el.addEventListener('mousedown',(e)=>{ drag=true; sx=e.clientX; sy=e.clientY; ox=parseInt(el.style.right)||8; oy=parseInt(el.style.bottom)||64; el.style.cursor='grabbing'; });
      window.addEventListener('mouseup',()=>{ drag=false; el.style.cursor='default'; });
      window.addEventListener('mousemove',(e)=>{ if(!drag)return; const dx=e.clientX-sx, dy=e.clientY-sy; el.style.right=Math.max(0,ox-dx)+'px'; el.style.bottom=Math.max(0,oy-dy)+'px'; });

      // close
      const btn=document.createElement('button'); btn.textContent='×';
      Object.assign(btn.style,{position:'absolute',top:'2px',right:'4px',background:'transparent',color:'#fff',border:'none',cursor:'pointer',fontSize:'14px'});
      btn.onclick=()=>el.remove(); el.appendChild(btn);
    };
    const upd=()=>{
      const set=(id,v)=>{const n=elId(id); if(n) n.textContent=String(v);};
      const lock=(()=>{try{return JSON.parse(localStorage.getItem(LOCK_KEY)||'null');}catch{return null;}})();

      set('ar_tab',TAB_ID);
      set('ar_vis',document.visibilityState);
      set('ar_focus',(document.hasFocus&&document.hasFocus())?'yes':'no');
      set('ar_net',navigator.onLine?'online':'offline');

      const page = isEventSearchPage()? 'eventsearch' : (/#event\/DisplayEvent\.do\b/i.test(location.href)? 'event':'other');
      set('ar_page',page);

      const ar = hasAutoRefreshUI()? 'ui' : (hadRecentNetwork()? 'net':'no');
      set('ar_ar',ar);

      set('ar_blank', pageLooksBlank()? 'yes':'no');

      const supLeft = ms(suppressUntil - nowMs());
      set('ar_sup', fmtMs(supLeft));
      set('ar_sup_at', lastSuppressTs? fmtTime(lastSuppressTs):'—');

      const lockOwner = lock? lock.tabId : '—';
      set('ar_lock', lockOwner);
      set('ar_lock_age', lock? fmtMs(nowMs()-lock.ts): '—');

      const boot=Number(sessionStorage.getItem('assyst_session_boot')||nowMs());
      set('ar_boot', fmtMs(nowMs()-boot));
      const cold = (nowMs()-boot)<COLD_START_DOWNGRADE_MS;
      set('ar_cold', cold? 'yes':'no');

      const last = readLast();
      if(last&&last.href){
        const short = last.href.length>140? (last.href.slice(0,137)+'…') : last.href;
        const age = fmtMs(nowMs()-last.ts);
        set('ar_last', `rank=${last.rank} age=${age} ${short}`);
      }else set('ar_last','—');

      set('ar_wd_next', nextWatchdogAt? `${fmtTime(nextWatchdogAt)} (+${fmtMs(nextWatchdogAt-nowMs())})`:'—');
      set('ar_wd_last', lastWatchdogAction? `${fmtTime(lastWatchdogAction.ts)} -> target`:'—');

      set('ar_bus', busMsgCount);

      const box=elId('ar_trace');
      if(box){
        box.innerHTML = trace.map(t=>`${fmtTime(t.ts)} • ${t.type} ${JSON.stringify(t.data)}`).join('\n');
      }
    };
    const ensure=()=>{ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',panel,{once:true}); else panel(); };
    ensure(); upd(); setInterval(upd,1000);
  }

})();
