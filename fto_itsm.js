// ==UserScript==
// @name         Assyst Auto-Return ITSM
// @namespace    https://github.com/kodxuk/tampermonkey
// @version      1.6
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

  // ===== Config (High Load) =====
  const DEBUG = false;
  const ACTIVE_ONLY  = true;
  const SUPPRESS_MS  = 25000;
  const WATCHDOG_MS  = 7000;
  const WATCHDOG_STEP_MS = 8000;
  const LAST_TTL_MS  = 24*60*60*1000;
  const COLD_START_DOWNGRADE_MS = 5*60*1000;
  const MAX_RECOVERY_STAGE = 3;
  const AUTOREFRESH_GRACE_MS = 12000;
  const NET_ACTIVITY_WINDOW_MS = 5000;
  const PING_URL = location.origin + '/assystweb/application.do';
  const PING_TIMEOUT_MS = 1500;
  const BACKOFF_BASE_MS = 1200;
  const BACKOFF_MAX_MS  = 15000;

  // ===== Keys / channel =====
  const KEY_LAST_OBJ     = 'assyst_last_obj';
  const TRACE_KEY        = 'assyst_return_trace';
  const RECOVERY_KEY     = 'assyst_recovery_stage';
  const TAB_ID_KEY       = 'assyst_tab_id';
  const LOCK_KEY         = 'assyst_return_lock';
  const BUS_NAME         = 'assyst_ar_bus';

  // ===== Logging =====
  const TAG = '[AssystAR]';
  const info = (...a) => DEBUG && console.info(TAG, ...a);
  const warn = (...a) => DEBUG && console.warn(TAG, ...a);
  const dbg  = (...a) => DEBUG && console.debug && console.debug(TAG, ...a);

  // ===== Stable Tab ID =====
  let TAB_ID = sessionStorage.getItem(TAB_ID_KEY);
  if (!TAB_ID) { TAB_ID = Math.random().toString(36).slice(2); sessionStorage.setItem(TAB_ID_KEY, TAB_ID); }

  // ===== UI: debug badge =====
  if (DEBUG) {
    const mountBadge = () => {
      if (document.getElementById('assystar-debug-badge')) return;
      const el = document.createElement('div');
      el.id = 'assystar-debug-badge';
      el.textContent = 'Debug: ON';
      Object.assign(el.style, {
        position:'fixed', right:'8px', bottom:'8px', zIndex:2147483647,
        background:'rgba(255,215,0,.9)', color:'#000', padding:'2px 6px',
        font:'12px/16px monospace', borderRadius:'4px', boxShadow:'0 0 0 1px #0003',
        pointerEvents:'none'
      });
      document.body.appendChild(el);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountBadge, { once:true });
    else mountBadge();
  }

  // ===== UI: return banner (session-only) =====
  const fmt = (ms) => new Date(ms).toLocaleString('ru-RU', {
    hour:'2-digit', minute:'2-digit', second:'2-digit',
    day:'2-digit', month:'2-digit', year:'numeric', hour12:false
  });
  const mountReturnBanner = (tsText) => {
    const id = 'assystar-return-banner';
    const el = document.getElementById(id) || (() => {
      const n = document.createElement('div'); n.id = id;
      Object.assign(n.style, {
        position:'fixed', right:'8px', bottom:'36px', zIndex:2147483647,
        background:'rgba(46,204,113,.95)', color:'#000', padding:'4px 8px',
        font:'12px/16px sans-serif', borderRadius:'4px', boxShadow:'0 0 0 1px #0003',
        pointerEvents:'none'
      });
      const mount = () => document.body.appendChild(n);
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once:true });
      else mount();
      return n;
    })();
    el.textContent = `Возврат выполнен: ${tsText}`;
  };
  (function showTraceOnce() {
    try {
      const raw = sessionStorage.getItem(TRACE_KEY);
      if (!raw) return;
      sessionStorage.removeItem(TRACE_KEY);
      const t = JSON.parse(raw);
      console.info(TAG, 'Returned from lock', t);
      if (t && t.ts) mountReturnBanner(fmt(t.ts));
    } catch {}
  })();

  // ===== Routing helpers =====
  const S='(?:\\\/|%2F)';
  const ROUTE = {
    EVENT:   new RegExp(`#event${S}DisplayEvent\\.do\\b`, 'i'),
    SEARCH:  new RegExp(`#eventsearch${S}EventSearchDelegatingDispatchAction\\.do\\b`, 'i'),
    WELCOME: new RegExp(`#welcome${S}WelcomeDispatchAction\\.do\\b`, 'i')
  };
  const canonicalize = (href) => {
    try {
      const [base, rawHash=''] = href.split('#');
      const u = new URL(base);
      let h = rawHash;
      try { h = decodeURIComponent(h); } catch {}
      h = h.replace(/([?&])(checkJukeBoxSettings|resultSet)=[^&#]*/gi,'$1')
           .replace(/[?&]+$/,'').replace(/[?&]{2,}/g,'&').replace('?&','?');
      return `${u.origin}${u.pathname}#${h}`;
    } catch { return href; }
  };
  const isWorkingPage = () => /\/assystweb\/application\.do$/i.test(location.pathname) && location.hash.length>1;
  const routeRank = (href) => {
    const h = canonicalize(href);
    if (ROUTE.EVENT.test(h))   return 3;
    if (ROUTE.SEARCH.test(h))  return 2;
    if (ROUTE.WELCOME.test(h)) return 0;
    return 1;
  };
  const isAcceptable = (u) => u && u.startsWith(location.origin) && /\/assystweb\/application\.do#/i.test(u);

  // ===== Auto-refresh awareness =====
  const isEventSearchPage = () => /#eventsearch\/EventSearchDelegatingDispatchAction\.do\b/i.test(location.href);
  const hasAutoRefreshUI = () => !!document.querySelector('[title*="Обновление"][role="menu"], [data-refresh], .auto-refresh');
  const hadRecentNetwork = () => {
    try {
      const now = performance.now();
      const entries = performance.getEntriesByType('resource');
      for (let i = entries.length - 1; i >= 0; i--) {
        if (now - entries[i].responseEnd <= NET_ACTIVITY_WINDOW_MS) return true;
        if (now - entries[i].startTime > NET_ACTIVITY_WINDOW_MS) break;
      }
    } catch {}
    return false;
  };
  const hasListContent = () => !!document.querySelector('table, .slickgrid, .dataTable, [role="grid"]');

  // ===== Save last {href, ts, rank} =====
  let lastRankSeen = -1, lastHref = null, saveTimer = null;
  const saveLast = (why='event') => {
    if (/\/logout\/|sessionInvalid=true/i.test(location.href)) { dbg('Skip save: logout', why); return; }
    if (!isWorkingPage()) { dbg('Skip save: not app.do', location.href); return; }
    if (document.visibilityState !== 'visible') { dbg('Skip save: hidden'); return; }
    if (isEventSearchPage() && (why === 'hashchange' || hadRecentNetwork())) { dbg('Skip save: auto-refresh', why); return; }

    const href = canonicalize(location.href);
    const r = routeRank(href);
    if (r <= 0) return;
    if (href === lastHref) return;
    if (r < lastRankSeen) return;

    lastRankSeen = r; lastHref = href;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const obj = { href, ts: Date.now(), rank: r };
      localStorage.setItem(KEY_LAST_OBJ, JSON.stringify(obj));
      sessionStorage.setItem(KEY_LAST_OBJ, JSON.stringify(obj));
      info('Saved last:', { href: obj.href, rank: obj.rank, at: new Date(obj.ts).toLocaleString('ru-RU') }, 'why=', why);
    }, 200);
  };
  ['load','popstate','hashchange','click','keydown','visibilitychange']
    .forEach(ev => addEventListener(ev, () => saveLast(ev), { passive:true }));
  saveLast('bootstrap');

  const readLast = () => {
    const raw = sessionStorage.getItem(KEY_LAST_OBJ) || localStorage.getItem(KEY_LAST_OBJ);
    if (!raw) return null; try { return JSON.parse(raw); } catch { return null; }
  };

  // Fallback из хэша logout-страницы
  const routeFromHash = () => {
    if (!location.hash || location.hash.length <= 1) return null;
    try {
      const dec = decodeURIComponent(location.hash.slice(1));
      if (!/^[-_a-zA-Z0-9/%?=&.]+$/.test(dec)) return null;
      return location.origin + '/assystweb/application.do#' + dec;
    } catch { return null; }
  };

  // Автоклик по кнопке «Вернуться в сервисдеск»
  const clickReturnButton = () => {
    const attempt = () => {
      const btn = [...document.querySelectorAll('a,button')]
        .find(n => /вернуться в сервисдеск/i.test(n.textContent || ''));
      if (btn) { info('Click fallback button'); btn.click(); return true; }
      return false;
    };
    if (attempt()) return;
    const mo = new MutationObserver(() => { if (attempt()) mo.disconnect(); });
    mo.observe(document.documentElement, { childList:true, subtree:true });
  };

  // ===== Active/online & cold start =====
  const isActive = () => document.visibilityState==='visible' && document.hasFocus && document.hasFocus();
  const isOnline = () => navigator.onLine !== false;
  const coldStartSince = (() => {
    const k='assyst_session_boot';
    let t = sessionStorage.getItem(k);
    if (!t) { t = String(Date.now()); sessionStorage.setItem(k, t); }
    return Number(t);
  })();

  // ===== Inter-tab bus/lock =====
  const bus = ('BroadcastChannel' in window) ? new BroadcastChannel(BUS_NAME) : null;
  let suppressUntil = 0;
  bus && (bus.onmessage = (e) => {
    if (e?.data?.type === 'returned' || e?.data?.type === 'suppress') {
      suppressUntil = Date.now() + SUPPRESS_MS;
      dbg('Suppressed until', new Date(suppressUntil).toISOString());
    }
  });
  const announceSuppress = () => bus && bus.postMessage({ type:'suppress', ts: Date.now() });

  const lockAcquire = () => {
    const now = Date.now();
    let lock = null;
    try { lock = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null'); } catch {}
    if (lock && now - lock.ts < SUPPRESS_MS) {
      if (lock.tabId === TAB_ID) return true;
      return false;
    }
    localStorage.setItem(LOCK_KEY, JSON.stringify({ tabId: TAB_ID, ts: now }));
    return true;
  };
  const lockRelease = () => {
    try {
      const lock = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null');
      if (!lock || lock.tabId === TAB_ID) localStorage.removeItem(LOCK_KEY);
    } catch {}
  };
  window.addEventListener('storage', (e) => {
    if (e.key === LOCK_KEY && e.newValue) suppressUntil = Date.now() + SUPPRESS_MS;
  });

  // ===== Ping + backoff (single declaration) =====
  let backoffAttempts = 0;
  const jitter = (ms) => Math.floor(ms * (0.75 + Math.random() * 0.5));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const pingReady = async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
    try {
      const res = await fetch(PING_URL, { method:'HEAD', cache:'no-store', signal: ctrl.signal });
      return res.ok;
    } catch { return false; } finally { clearTimeout(t); }
  };
  const calcBackoff = () => {
    const raw = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, backoffAttempts));
    return jitter(raw);
  };

  // ===== Recovery helpers (blank page) =====
  const recoveryState = () => { try { return JSON.parse(sessionStorage.getItem(RECOVERY_KEY) || '{"stage":0,"ts":0}'); } catch { return {stage:0,ts:0}; } };
  const setRecovery = (stage) => sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({ stage, ts: Date.now() }));
  const resetRecovery = () => setRecovery(0);

  const pageLooksBlank = () => {
    const b = document.body;
    if (!b) return true;
    const childCount = b.children.length;
    const textLen = (b.textContent || '').trim().length;
    return childCount < 3 && textLen < 40;
  };
  const addCacheBusterToHash = (href) => {
    try {
      const [base, hash=''] = href.split('#');
      if (!hash) return href;
      const qIndex = hash.indexOf('?');
      if (qIndex === -1) return `${base}#${hash}?_r=${Date.now()}`;
      return `${base}#${hash}&_r=${Date.now()}`;
    } catch { return href; }
  };
  const toSearchBase = () => location.origin + '/assystweb/application.do#eventsearch/EventSearchDelegatingDispatchAction.do?dispatch=loadQuery';
  const toWelcome     = () => location.origin + '/assystweb/application.do#welcome/WelcomeDispatchAction.do?dispatch=refresh';

  const escalateRecovery = () => {
    if (ACTIVE_ONLY && !isActive()) return;
    const st = recoveryState();
    if (st.stage >= MAX_RECOVERY_STAGE) { warn('Recovery limit reached'); return; }
    let target = null;
    if (st.stage === 0) {
      target = addCacheBusterToHash(location.href);
      info('Recovery stage 1: cache-buster reload', target);
    } else if (st.stage === 1) {
      target = toSearchBase();
      info('Recovery stage 2: SEARCH base', target);
    } else if (st.stage === 2) {
      target = toWelcome();
      info('Recovery stage 3: WELCOME base', target);
    }
    setRecovery(st.stage + 1);
    if (target) location.replace(target);
  };

  const scheduleRecoveryChecks = () => {
    if (!isWorkingPage()) return;
    const firstDelay = isEventSearchPage() ? (WATCHDOG_MS + AUTOREFRESH_GRACE_MS) : WATCHDOG_MS;
    setTimeout(() => {
      if (isEventSearchPage() && (hadRecentNetwork() || hasAutoRefreshUI() || hasListContent())) return;
      if (pageLooksBlank()) escalateRecovery();
    }, firstDelay);
    let checks = 3;
    const iv = setInterval(() => {
      if (!pageLooksBlank()) { clearInterval(iv); resetRecovery(); return; }
      if (isEventSearchPage() && (hadRecentNetwork() || hasAutoRefreshUI())) return;
      escalateRecovery();
      if (--checks <= 0) clearInterval(iv);
    }, WATCHDOG_STEP_MS);
  };

  // ===== Return core =====
  const tryReturn = (why='auto') => {
    if (ACTIVE_ONLY && !isActive()) { dbg('Skip return: not active'); return false; }
    if (Date.now() < suppressUntil) { dbg('Skip return: suppressed'); return false; }
    if (!lockAcquire()) { dbg('Skip return: lock held'); return false; }

    const last  = readLast();
    const fromH = routeFromHash();
    let target  = last && last.href;
    const ageOk = last && (Date.now() - last.ts) <= LAST_TTL_MS;

    if ((!target || !ageOk) && fromH) target = fromH;

    const cold = (Date.now() - coldStartSince) < COLD_START_DOWNGRADE_MS;
    if (cold && target && /#event\/DisplayEvent\.do\b/i.test(target)) {
      target = target.replace(/#event\/DisplayEvent\.do/i, '#eventsearch/EventSearchDelegatingDispatchAction.do');
      dbg('Cold-start downgrade to SEARCH');
    }

    if (!isAcceptable(target)) { dbg('No acceptable/stale target', { last, fromH }); lockRelease(); return false; }

    const payload = { ts: Date.now(), why, target };
    try { sessionStorage.setItem(TRACE_KEY, JSON.stringify(payload)); } catch {}
    bus && bus.postMessage({ type:'returned', ts: payload.ts });
    info('Redirect ->', target);
    location.replace(target);
    return true;
  };

  // ===== Guarded return (single definition) =====
  const guardedReturn = async (why='auto') => {
    if (ACTIVE_ONLY && !isActive()) return false;
    if (Date.now() < suppressUntil) return false;
    const ready = await pingReady();
    if (!ready) {
      backoffAttempts++;
      const delay = calcBackoff();
      dbg('Server not ready, backoff ms=', delay);
      bus && bus.postMessage({ type:'suppress', ts: Date.now() });
      await sleep(delay);
      return false;
    }
    backoffAttempts = 0;
    return tryReturn(why);
  };

  // ===== Wiring =====
  const logoutLike = /\/logout\/|sessionInvalid=true/i.test(location.href);
  const loginLike  = /login|signin|authenticate/i.test(location.pathname);

  if (logoutLike) {
    guardedReturn('logout').then((ok) => {
      if (ok) return;
      clickReturnButton();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState==='visible') guardedReturn('visible'); });
      addEventListener('focus', () => guardedReturn('focus'));
      if (!navigator.onLine) window.addEventListener('online', () => guardedReturn('online'), { once:true });
    });
  }

  if (!logoutLike && loginLike) {
    addEventListener('load', () => setTimeout(() => guardedReturn('after-login'), 500));
  }

  addEventListener('load', scheduleRecoveryChecks, { once:true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState==='visible') scheduleRecoveryChecks(); });
})();
