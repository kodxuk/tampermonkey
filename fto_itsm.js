// ==UserScript==
// @name         Assyst Auto-Return ITSM
// @namespace    https://github.com/kodxuk/tampermonkey
// @version      2.1
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

  // Пассивное удержание (неактивные вкладки)
  const PASSIVE_RETAIN_COOLDOWN_MS = 20000;
  const PASSIVE_DEGRADE = false;
  const PASSIVE_VERIFY_1_MS = 2500;
  const PASSIVE_VERIFY_2_MS = 9000;
  const PASSIVE_MARK_KEY = 'assyst_passive_nav';

  // ===== Keys / channel =====
  const KEY_LAST_OBJ = 'assyst_last_obj';
  const TRACE_KEY    = 'assyst_return_trace';
  const TAB_ID_KEY   = 'assyst_tab_id';
  const LOCK_KEY     = 'assyst_return_lock';
  const BUS_NAME     = 'assyst_ar_bus';

  // ===== Console log helpers =====
  const TAG='[AssystAR]';
  const L = {
    dec: (m,c={})=>console.info(`${TAG} ${m}`,c),
    skip:(m,c={})=>console.warn(`${TAG} SKIP: ${m}`,c),
    bus: (t,c={})=>console.info(`${TAG} BUS: ${t}`,c),
    lok: (t,c={})=>console.info(`${TAG} LOCK: ${t}`,c),
    pas: (t,c={})=>console.info(`${TAG} PASSIVE: ${t}`,c),
    wd:  (t,c={})=>console.info(`${TAG} WD: ${t}`,c),
    wel: (t,c={})=>console.info(`${TAG} WELCOME: ${t}`,c),
    tr:  (t,c={})=>console.info(`${TAG} TRACE: ${t}`,c),
  };
  const nowMs=()=>Date.now();
  const fmtMs=(v)=>{let x=Math.max(0,v|0);const s=Math.floor(x/1000),m=Math.floor(s/60),h=Math.floor(m/60);const ss=(s%60).toString().padStart(2,'0'),mm=(m%60).toString().padStart(2,'0');return h?`${h}:${mm}:${ss}`:`${m}:${ss}`;};

  // ===== Stable tab id =====
  let TAB_ID = sessionStorage.getItem(TAB_ID_KEY);
  if (!TAB_ID){ TAB_ID = Math.random().toString(36).slice(2); sessionStorage.setItem(TAB_ID_KEY, TAB_ID); }

  // ===== Minimal UI badge =====
  if (DEBUG){
    const mountBadge=()=>{
      if(document.getElementById('assystar-debug-badge'))return;
      const el=document.createElement('div');
      el.id='assystar-debug-badge'; el.textContent='Debug: ON';
      Object.assign(el.style,{position:'fixed',right:'8px',bottom:'8px',zIndex:2147483647,background:'rgba(255,215,0,.9)',color:'#000',padding:'2px 6px',font:'12px/16px monospace',borderRadius:'4px',boxShadow:'0 0 0 1px #0003',pointerEvents:'none'});
      document.body.appendChild(el);
    };
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountBadge,{once:true}); else mountBadge();
  }

  // ===== Return banner (session) =====
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
      sessionStorage.removeItem(TRACE_KEY); const t=JSON.parse(raw);
      L.tr('banner_show', t);
      if(t&&t.ts) mountReturnBanner(new Date(t.ts).toLocaleString('ru-RU',{hour12:false}));
    }catch{}
  })();

  // ===== Routing helpers =====
  const S='(?:\\\/|%2F)';
  const ROUTE={EVENT:new RegExp(`#event${S}DisplayEvent\\.do\\b`,'i'),SEARCH:new RegExp(`#eventsearch${S}EventSearchDelegatingDispatchAction\\.do\\b`,'i'),WELCOME:new RegExp(`#welcome${S}WelcomeDispatchAction\\.do\\b`,'i')};
  const canonicalize=(href)=>{ try{ const [base,rawHash='']=href.split('#'); const u=new URL(base); let h=rawHash; try{h=decodeURIComponent(h);}catch{} h=h.replace(/([?&])(checkJukeBoxSettings|resultSet)=[^&#]*/gi,'$1').replace(/[?&]+$/,'').replace(/[?&]{2,}/g,'&').replace('?&','?'); return `${u.origin}${u.pathname}#${h}`; }catch{return href;} };
  const isWorkingPage=()=>/\/assystweb\/application\.do$/i.test(location.pathname)&&location.hash.length>1;
  const routeRank=(href)=>{ const h=canonicalize(href); if(ROUTE.EVENT.test(h))return 3; if(ROUTE.SEARCH.test(h))return 2; if(ROUTE.WELCOME.test(h))return 0; return 1; };
  const isAcceptable=(u)=>u&&u.startsWith(location.origin)&&/\/assystweb\/application\.do#/i.test(u);
  const toSearchBase=()=>location.origin+'/assystweb/application.do#eventsearch/EventSearchDelegatingDispatchAction.do?dispatch=loadQuery';

  // Auto-refresh heuristics
  const isEventSearchPage=()=>/#eventsearch\/EventSearchDelegatingDispatchAction\.do\b/i.test(location.href);
  const hasAutoRefreshUI=()=>!!document.querySelector('[title*="Обновление"][role="menu"], [data-refresh], .auto-refresh');
  const hadRecentNetwork=()=>{ try{ const n=performance.now(); const es=performance.getEntriesByType('resource'); for(let i=es.length-1;i>=0;i--){ if(n-es[i].responseEnd<=NET_ACTIVITY_WINDOW_MS)return true; if(n-es[i].startTime>NET_ACTIVITY_WINDOW_MS)break; } }catch{} return false; };
  const hasListContent=()=>!!document.querySelector('table, .slickgrid, .dataTable, [role="grid"]');

  // ===== Save last =====
  let lastRankSeen=-1,lastHref=null,saveTimer=null;
  const saveLast=(why='event')=>{
    if(/\/logout\/|sessionInvalid=true/i.test(location.href)){L.skip('save_last: logout');return;}
    if(!isWorkingPage()){L.skip('save_last: not app.do',{href:location.href});return;}
    if(document.visibilityState!=='visible'){L.skip('save_last: hidden');return;}
    if(isEventSearchPage()&&(why==='hashchange'||hadRecentNetwork())){L.skip('save_last: auto-refresh',{why});return;}
    const href=canonicalize(location.href); const r=routeRank(href);
    if(r<=0||href===lastHref||r<lastRankSeen) return; lastRankSeen=r; lastHref=href;
    clearTimeout(saveTimer); saveTimer=setTimeout(()=>{ const obj={href,ts:nowMs(),rank:r}; localStorage.setItem(KEY_LAST_OBJ,JSON.stringify(obj)); sessionStorage.setItem(KEY_LAST_OBJ,JSON.stringify(obj)); L.dec('save_last',{why,href,rank:r,at:new Date(obj.ts).toLocaleTimeString('ru-RU',{hour12:false})}); },200);
  };
  ['load','popstate','hashchange','click','keydown','visibilitychange'].forEach(ev=>addEventListener(ev,()=>saveLast(ev),{passive:true}));
  saveLast('bootstrap');
  const readLast=()=>{const raw=sessionStorage.getItem(KEY_LAST_OBJ)||localStorage.getItem(KEY_LAST_OBJ); if(!raw)return null; try{return JSON.parse(raw);}catch{return null;}};

  // Fallback from logout hash
  const routeFromHash=()=>{ if(!location.hash||location.hash.length<=1)return null; try{ const dec=decodeURIComponent(location.hash.slice(1)); if(!/^[-_a-zA-Z0-9/%?=&.]+$/.test(dec)) return null; return location.origin+'/assystweb/application.do#'+dec; }catch{return null;} };

  // Auto-click
  const clickReturnButton=()=>{ const attempt=()=>{ const btn=[...document.querySelectorAll('a,button')].find(n=>/вернуться в сервисдеск|войти|login/i.test(n.textContent||'')); if(btn){ L.dec('click_return_btn'); btn.click(); return true; } return false; };
    if(attempt())return; const mo=new MutationObserver(()=>{ if(attempt()) mo.disconnect(); }); mo.observe(document.documentElement,{childList:true,subtree:true}); };

  // Active tab
  const isActive=()=>document.visibilityState==='visible' && document.hasFocus && document.hasFocus();

  // ===== Inter-tab suppression / lock (time-safe) =====
  const bus=('BroadcastChannel' in window)? new BroadcastChannel(BUS_NAME):null;
  let suppressUntil=0; let lastSuppressTs=0; let busMsgCount=0;
  let lastBlockAt = 0; let blocksCount = 0;

  const addCacheBusterToHash=(href)=>{ try{ const [base,hash='']=href.split('#'); if(!hash) return href; const qi=hash.indexOf('?'); return qi===-1? `${base}#${hash}?_r=${nowMs()}` : `${base}#${hash}&_r=${nowMs()}`; }catch{return href;} };

  // Пассивное удержание для неактивных вкладок
  let lastPassiveAt = 0;
  const passiveRetain = (reason='bus_or_storage') => {
    if (document.visibilityState === 'visible') return;
    const last = readLast(); if (!last || !last.href) return;
    if ((nowMs() - last.ts) > LAST_TTL_MS) return;

    const boot = Number(sessionStorage.getItem('assyst_session_boot')||nowMs());
    const cold = (nowMs()-boot) < COLD_START_DOWNGRADE_MS;
    let target = last.href;
    if (PASSIVE_DEGRADE && cold && /#event\/DisplayEvent\.do\b/i.test(target)) target = toSearchBase();

    const busted = addCacheBusterToHash(target);
    const cooldown  = (nowMs() - lastPassiveAt) < PASSIVE_RETAIN_COOLDOWN_MS;
    if (cooldown) return;

    lastPassiveAt = nowMs();
    try { sessionStorage.setItem(PASSIVE_MARK_KEY, JSON.stringify({ ts: lastPassiveAt, target })); } catch {}
    L.pas('retain', { reason, target: busted });
    location.replace(busted);
  };

  bus && (bus.onmessage=(e)=>{ 
    if(e?.data?.type==='returned'||e?.data?.type==='suppress'){ 
      const safeSup = Math.min(nowMs()+SUPPRESS_MS, nowMs()+2*SUPPRESS_MS);
      suppressUntil=safeSup; lastSuppressTs=nowMs(); busMsgCount++;
      lastBlockAt = lastSuppressTs; blocksCount++; L.bus('suppress', { ts: e?.data?.ts }); 
      passiveRetain('bus');
    } 
  });
  const announceSuppress=()=>{ bus && bus.postMessage({type:'suppress',ts:nowMs()}); L.bus('announce_suppress'); };

  const lockAcquire=()=>{ const t=nowMs(); let lock=null; try{ lock=JSON.parse(localStorage.getItem(LOCK_KEY)||'null'); }catch{}
    if(lock && (t-lock.ts) > 4*SUPPRESS_MS){ localStorage.removeItem(LOCK_KEY); L.lok('autofix',{stale_ms:t-lock.ts}); lock=null; }
    if(lock && t-lock.ts < SUPPRESS_MS){ if(lock.tabId!==TAB_ID){ lastBlockAt=t; blocksCount++; L.lok('blocked_by_other',{owner:lock.tabId,age_ms:t-lock.ts}); } return lock.tabId===TAB_ID; }
    localStorage.setItem(LOCK_KEY,JSON.stringify({tabId:TAB_ID,ts:t})); L.lok('acquire',{tabId:TAB_ID}); return true; };
  const lockRelease=()=>{ try{ const lock=JSON.parse(localStorage.getItem(LOCK_KEY)||'null'); if(!lock || lock.tabId===TAB_ID) localStorage.removeItem(LOCK_KEY); L.lok('release',{own:!lock||lock.tabId===TAB_ID}); }catch{} };
  addEventListener('storage',(e)=>{ if(e.key===LOCK_KEY && e.newValue){ const safeSup = Math.min(nowMs()+SUPPRESS_MS, nowMs()+2*SUPPRESS_MS); suppressUntil=safeSup; lastSuppressTs=nowMs(); lastBlockAt = lastSuppressTs; blocksCount++; L.lok('storage_event',{value:e.newValue}); passiveRetain('storage'); } });

  // ===== Watchdog =====
  const pageLooksBlank=()=>{ const b=document.body; if(!b) return true; const child=b.children.length; const txt=(b.textContent||'').trim().length; return child<3 && txt<40; };
  let nextWatchdogAt=0; let lastWatchdogAction=null;
  const scheduleWatchdog=()=>{ if(!isWorkingPage()) return; const delay = isEventSearchPage()? (WATCHDOG_MS+AUTOREFRESH_GRACE_MS): WATCHDOG_MS; nextWatchdogAt = nowMs()+delay; L.wd('scheduled',{at:nextWatchdogAt,delay});
    setTimeout(()=>{ if(isEventSearchPage() && (hadRecentNetwork()||hasAutoRefreshUI()||hasListContent())){ L.wd('skip_auto_refresh'); return; } if(!pageLooksBlank()){ L.wd('ok_dom_non_blank'); return; }
      const target = addCacheBusterToHash(location.href) || toSearchBase(); lastWatchdogAction = {ts: nowMs(), target}; L.wd('reload',{target}); location.replace(target);
    }, delay); };

  // ===== Passive landing verification =====
  (function verifyPassiveLanding(){
    let mark = null; try { mark = JSON.parse(sessionStorage.getItem(PASSIVE_MARK_KEY) || 'null'); } catch {}
    if (!mark) return; sessionStorage.removeItem(PASSIVE_MARK_KEY);
    const recent = (nowMs() - (mark.ts||0)) <= 60*1000; if (!recent) return;

    setTimeout(() => { if (pageLooksBlank()) { const burst = addCacheBusterToHash(mark.target || location.href); L.pas('verify_reload',{target:burst}); location.replace(burst); } }, PASSIVE_VERIFY_1_MS);
    setTimeout(() => { if (pageLooksBlank()) { const safe = toSearchBase(); L.pas('verify_fallback',{target:safe}); location.replace(safe); } }, PASSIVE_VERIFY_2_MS);
  })();

  // ===== Gentle re-navigate from welcome after 500 =====
  let lastHttp500At = 0;
  addEventListener('error', (e) => { try { if (String(e?.message||'').includes('500') || String(e?.filename||'').includes('WelcomeDispatchAction')) { lastHttp500At = nowMs(); L.wel('500_hint',{ts:lastHttp500At}); } } catch {} }, true);
  const gentleReNavigate = () => {
    const last = readLast(); if (!last || !last.href) return;
    const rankOk = last.rank >= 2; const ageOk  = (nowMs() - last.ts) <= LAST_TTL_MS;
    const isWelcome = /#welcome\/WelcomeDispatchAction\.do\b/i.test(location.href);
    const recently500 = (nowMs() - lastHttp500At) <= 1500;
    if (isWelcome && rankOk && ageOk) {
      const lock = (()=>{ try { return JSON.parse(localStorage.getItem(LOCK_KEY)||'null'); } catch { return null; }})();
      const foreignFreshLock = lock && (nowMs()-lock.ts) < SUPPRESS_MS && lock.tabId !== TAB_ID;
      if (!foreignFreshLock && (recently500 || document.visibilityState==='visible')) {
        L.wel('gentle_nav',{target:last.href,recently500}); location.replace(last.href);
      }
    }
  };
  addEventListener('load', () => setTimeout(gentleReNavigate, 800));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState==='visible') setTimeout(gentleReNavigate, 250); });

  // ===== Try return (active tab only) =====
  const tryReturn=(why='auto')=>{
    if(ACTIVE_ONLY && !isActive()){ L.skip('not active',{visible:document.visibilityState,focus:!!(document.hasFocus&&document.hasFocus())}); return false; }
    if(nowMs()<suppressUntil){ L.skip('suppressed',{left_ms:suppressUntil-nowMs()}); return false; }
    if(!lockAcquire()){ L.skip('lock held'); return false; }
    const last = readLast(); const fromH = routeFromHash(); let target = last && last.href; const ageOk = last && (nowMs()-last.ts)<=LAST_TTL_MS;
    if((!target||!ageOk) && fromH) target = fromH;
    const bootKey='assyst_session_boot'; if(!sessionStorage.getItem(bootKey)) sessionStorage.setItem(bootKey,String(nowMs()));
    const cold = (nowMs()-Number(sessionStorage.getItem(bootKey)))<COLD_START_DOWNGRADE_MS;
    if(cold && target && /#event\/DisplayEvent\.do\b/i.test(target)){ target = target.replace(/#event\/DisplayEvent\.do/i,'#eventsearch/EventSearchDelegatingDispatchAction.do'); L.dec('downgrade_to_search'); }
    if(!isAcceptable(target)){ L.skip('no acceptable/stale target',{last,fromH}); lockRelease(); return false; }
    const payload={ts:nowMs(),why,target}; try{ sessionStorage.setItem(TRACE_KEY,JSON.stringify(payload)); }catch{} bus && bus.postMessage({type:'returned',ts:payload.ts}); announceSuppress();
    L.dec('redirect',payload); location.replace(target); return true; };

  // ===== Wiring =====
  const logoutLike=/\/logout\/|sessionInvalid=true/i.test(location.href); const loginLike =/login|signin|authenticate/i.test(location.pathname);
  if(logoutLike){ if(!tryReturn('logout')){ clickReturnButton(); document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') tryReturn('visible'); }); addEventListener('focus',()=>tryReturn('focus')); } }
  if(!logoutLike && loginLike){ addEventListener('load',()=>setTimeout(()=>tryReturn('after-login'),500)); }
  addEventListener('load',scheduleWatchdog,{once:true}); document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') scheduleWatchdog(); });
})();
