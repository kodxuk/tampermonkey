// ==UserScript==
// @name         Assyst Auto-Return ITSM
// @namespace    https://github.com/kodxuk/tampermonkey
// @version      1.0
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
// ==/UserScript==

(function () {
  'use strict';

  // ===== Config =====
  const DEBUG = false;                        // включить/выключить логи и бейдж
  const ACTIVE_ONLY  = true;                 // возврат только в активной вкладке
  const SUPPRESS_MS  = 15000;                // подавление возврата на других вкладках
  const WATCHDOG_MS  = 6000;                 // «белый экран» перезагрузка (один раз)
  const LAST_TTL_MS  = 24*60*60*1000;        // срок годности последнего URL (24ч)
  const COLD_START_DOWNGRADE_MS = 2*60*1000; // в первые 2 мин понижать карточку до списка

  // ===== Keys / channel =====
  const KEY_LAST_OBJ     = 'assyst_last_obj';     // { href, ts, rank }
  const TRACE_KEY        = 'assyst_return_trace'; // session-only метка возврата
  const RELOAD_ONCE_KEY  = 'assyst_reload_once';
  const TAB_ID_KEY       = 'assyst_tab_id';
  const LOCK_KEY         = 'assyst_return_lock';  // { tabId, ts }
  const BUS_NAME         = 'assyst_ar_bus';

  // ===== Logging =====
  const TAG = '[AssystAR]';
  const info = (...a) => DEBUG && console.info(TAG, ...a);
  const warn = (...a) => DEBUG && console.warn(TAG, ...a);
  const dbg  = (...a) => DEBUG && console.debug && console.debug(TAG, ...a);

  // ===== Stable Tab ID =====
  let TAB_ID = sessionStorage.getItem(TAB_ID_KEY);
  if (!TAB_ID) { TAB_ID = Math.random().toString(36).slice(2); sessionStorage.setItem(TAB_ID_KEY, TAB_ID); }

  // ===== UI: Debug badge (bottom-right) =====
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

  // ===== UI: Return banner (session only, above badge) =====
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

  // ===== Save last as {href, ts, rank} =====
  let lastRankSeen = -1;
  let lastHref = null;
  let saveTimer = null;
  const saveLast = (why='event') => {
    if (/\/logout\/|sessionInvalid=true/i.test(location.href)) { dbg('Skip save: logout', why); return; }
    if (!isWorkingPage()) { dbg('Skip save: not app.do', location.href); return; }
    if (document.visibilityState !== 'visible') { dbg('Skip save: hidden'); return; }

    const href = canonicalize(location.href);
    const r = routeRank(href);
    if (r <= 0) return;
    if (href === lastHref) return;
    if (r < lastRankSeen) return;

    lastRankSeen = r;
    lastHref = href;

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const obj = { href, ts: Date.now(), rank: r };
      localStorage.setItem(KEY_LAST_OBJ, JSON.stringify(obj));
      sessionStorage.setItem(KEY_LAST_OBJ, JSON.stringify(obj));
      info('Saved last', obj, 'why=', why);
    }, 200);
  };
  ['load','popstate','hashchange','click','keydown','visibilitychange']
    .forEach(ev => addEventListener(ev, () => saveLast(ev), { passive:true }));
  saveLast('bootstrap');

  const readLast = () => {
    const raw = sessionStorage.getItem(KEY_LAST_OBJ) || localStorage.getItem(KEY_LAST_OBJ);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
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

  // ===== Active/online helpers =====
  const isActive = () => document.visibilityState==='visible' && document.hasFocus && document.hasFocus();
  const isOnline = () => navigator.onLine !== false;

  // Cold-start baseline (per session)
  const coldStartSince = (() => {
    const k='assyst_session_boot';
    let t = sessionStorage.getItem(k);
    if (!t) { t = String(Date.now()); sessionStorage.setItem(k, t); }
    return Number(t);
  })();

  // ===== Inter-tab lock and bus =====
  const bus = ('BroadcastChannel' in window) ? new BroadcastChannel(BUS_NAME) : null;
  let suppressUntil = 0;
  bus && (bus.onmessage = (e) => {
    if (e && e.data && e.data.type==='returned') {
      suppressUntil = Date.now() + SUPPRESS_MS;
      dbg('Suppressed by other tab until', new Date(suppressUntil).toISOString());
    }
  });
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

  // ===== Return =====
  const logoutLike = /\/logout\/|sessionInvalid=true/i.test(location.href);
  const loginLike  = /login|signin|authenticate/i.test(location.pathname);

  const tryReturn = (why='auto') => {
    if (ACTIVE_ONLY && !isActive()) { dbg('Skip return: not active'); return false; }
    if (!isOnline()) { dbg('Skip return: offline, wait online'); window.addEventListener('online', () => tryReturn('online'), { once:true }); return false; }
    if (Date.now() < suppressUntil) { dbg('Skip return: suppressed'); return false; }
    if (!lockAcquire()) { dbg('Skip return: lock held'); return false; }

    const last  = readLast();
    const fromH = routeFromHash();
    let target  = last && last.href;
    const ageOk = last && (Date.now() - last.ts) <= LAST_TTL_MS;

    // если нет свежего last — использовать хэш с logout
    if ((!target || !ageOk) && fromH) target = fromH;

    // деградация карточки до списка сразу после холодного старта
    const cold = (Date.now() - coldStartSince) < COLD_START_DOWNGRADE_MS;
    if (cold && target && /#event\/DisplayEvent\.do\b/i.test(target)) {
      target = target.replace(/#event\/DisplayEvent\.do/i, '#eventsearch/EventSearchDelegatingDispatchAction.do');
      dbg('Cold-start downgrade to SEARCH');
    }

    if (!isAcceptable(target)) {
      dbg('No acceptable/stale target', { last, fromH });
      lockRelease();
      return false;
    }

    const payload = { ts: Date.now(), why, target };
    try { sessionStorage.setItem(TRACE_KEY, JSON.stringify(payload)); } catch {}
    bus && bus.postMessage({ type:'returned', ts: payload.ts });
    info('Redirect ->', target);
    location.replace(target);
    return true;
  };

  if (logoutLike) {
    if (!tryReturn('logout')) {
      // автоклик по кнопке на экране выхода
      clickReturnButton();

      // повторные попытки, когда вкладка активируется/появляется сеть
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState==='visible') tryReturn('visible');
      });
      addEventListener('focus', () => tryReturn('focus'));
      if (!isOnline()) window.addEventListener('online', () => tryReturn('online'), { once:true });

      // watchdog «белого экрана» — один раз
      setTimeout(() => {
        if (!isActive()) return;
        const once = sessionStorage.getItem(RELOAD_ONCE_KEY);
        const tooEmpty = document.body && document.body.children && document.body.children.length < 2;
        if (!once && tooEmpty) {
          sessionStorage.setItem(RELOAD_ONCE_KEY, '1');
          const last = readLast();
          const fallback = routeFromHash();
          const t = (last && last.href) || fallback;
          if (t && isAcceptable(t)) location.replace(t);
        }
      }, WATCHDOG_MS);
    }
  }

  if (!logoutLike && loginLike) {
    addEventListener('load', () => setTimeout(() => tryReturn('after-login'), 500));
  }
})();
