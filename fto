// ==UserScript==
// @name         Assyst: полное время на группе 1С Сопровождение ФТО
// @match        https://itsm.cherkizovsky.net/*
// @run-at       document-end
// @grant        none
// ==/UserScript==
(function(){
  const GROUP = '1С Сопровождение ФТО';
  const norm = s => String(s||'').replace(/[с]/g,'c').replace(/\s+/g,' ').replace(/ /g,'').toLowerCase().trim();
  function parseRUDate(s){
    s = (typeof s === 'string') ? s : '';
    const m = s.match(/(\d{2})\.(\d{2})\.(\d{2,4})\s+(\d{1,2}):(\d{2})/);
    if (!m) return 0;
    let day = parseInt(m[1],10), month = parseInt(m[2],10)-1;
    let year = m[3].length === 2 ? 2000 + parseInt(m[3],10) : parseInt(m[3],10);
    let hour = parseInt(m[4],10), min = parseInt(m[5],10);
    return new Date(year, month, day, hour, min).getTime();
  }
  function extractEvents(){
    const grid = document.getElementById("actionGrid");
    if (!grid) return [];
    const rows = Array.from(grid.querySelectorAll('tr')).filter(row => row.querySelectorAll('td').length > 7);
    return rows.map(row => {
      const tds = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
      return { tds };
    });
  }
  function computeIntervals(events){
    // Определяем все возможные старты (старт каждого куска)
    const groupNorm = norm(GROUP);
    let startList = [];
    events.forEach((ev, i) => {
      const tds = ev.tds;
      if (tds[2] === "Переоткрыть") {
        startList.push({ dt: parseRUDate(tds[3]), date: tds[3], idx: i, action: tds[2] });
      } else if (tds[2] === "Назначить" && norm(tds[7]) === groupNorm) {
        startList.push({ dt: parseRUDate(tds[3]), date: tds[3], idx: i, action: tds[2] });
      } else if (tds[2] === "Принять в работу" && norm(tds[5]) === groupNorm) {
        startList.push({ dt: parseRUDate(tds[3]), date: tds[3], idx: i, action: tds[2] });
      }
    });
    // Определяем все "Выполнить" нужной группой
    let finishList = [];
    events.forEach((ev, i) => {
      const tds = ev.tds;
      if (/Выполнить|complete|resolve|close/i.test(tds[2]) && norm(tds[5]) === groupNorm) {
        finishList.push({ dt: parseRUDate(tds[3]), date: tds[3], idx: i });
      }
    });
    // Для КАЖДОГО стартового события ищем ближайшее неиспользованное "Выполнить" после него
    let usedFinishes = {};
    let intervals = [];
    startList.forEach(st => {
      let nextFinish = finishList.find(fn => fn.dt > st.dt && !usedFinishes[fn.idx]);
      if (nextFinish) {
        intervals.push({
          start: st.date,
          end: nextFinish.date,
          min: Math.round((nextFinish.dt - st.dt)/60000)
        });
        usedFinishes[nextFinish.idx] = true;
      }
    });
    let total = intervals.reduce((s,p)=>s+p.min,0);
    return {intervals, total};
  }
  function showBadge(text){
    let el = document.getElementById('assyst-time-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'assyst-time-badge';
      Object.assign(el.style, {
        position:'fixed',right:'16px',top:'16px',zIndex:999999,
        background:'rgba(20,20,20,.92)',color:'#fff',padding:'8px 12px',
        font:'12px/1.3 -apple-system,Segoe UI,Roboto',borderRadius:'8px',pointerEvents:'none'
      });
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
  }
  function main(){
    const events = extractEvents();
    const result = computeIntervals(events);
    let msg = `Время на группе «${GROUP}»: ${Math.floor(result.total/60)} ч ${result.total%60} мин`;
    if(result.intervals.length > 1){
      msg += `  (интервалов: ${result.intervals.length})`;
    }
    showBadge(msg);
    // Для аудита:
    // result.intervals.forEach((p,i)=>console.log(`#${i+1}: ${p.start} — ${p.end} = ${p.min} мин`));
  }
  function readyLoop(){
    if(document.getElementById("actionGrid")){
      main();
      const mo = new MutationObserver(main);
      mo.observe(document.getElementById("actionGrid"),{childList:true,subtree:true});
    }else{
      setTimeout(readyLoop,400);
    }
  }
  const p=history.pushState,r=history.replaceState;
  history.pushState=function(){const o=p.apply(this,arguments);window.dispatchEvent(new Event('assyst-route'));return o;};
  history.replaceState=function(){const o=r.apply(this,arguments);window.dispatchEvent(new Event('assyst-route'));return o;};
  window.addEventListener('popstate',()=>window.dispatchEvent(new Event('assyst-route')));
  window.addEventListener('assyst-route',()=>readyLoop());
  readyLoop();
})();
