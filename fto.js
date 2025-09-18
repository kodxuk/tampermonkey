// ==UserScript==
// @name         Assyst: время на группе 1С Сопровождение ФТО (SLA, чистые интервалы)
// @namespace    https://github.com/kodxuk/tampermonkey
// @version      1.8.0
// @description  Считает только время, когда тикет реально назначен на «1С Сопровождение ФТО». Интервалы обрезаются на повторном старте/переназначении/Выполнить. Поддерживает подгруппы (Администраторы). Сортировка по времени + устойчивая нормализация «1C/1С».
// @author       kodx
// @match        https://itsm.cherkizovsky.net/*
// @grant        none
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function () {
    // Настройки
    const TARGET_GROUP = '1С Сопровождение ФТО';
    const DEBUG = true; // true — подробный лог в консоль

    // Нормализация строк: лат/кир «похожие» символы, неразрывные пробелы, регистр
    function norm(s) {
        s = String(s || '')
            .normalize('NFKD')
            .replace(/\u00A0/g, ' ') // NBSP -> space
            .trim()
            .toLowerCase();

        // Сопоставление часто встречающихся гомоглифов
        const map = {
            'с': 'c', 'c': 'c',
            'о': 'o',
            'е': 'e', 'ё': 'e',
            'а': 'a',
            'р': 'p',
            'к': 'k',
            'х': 'x',
            'м': 'm',
            'т': 't',
            'у': 'y',
            'в': 'v',
            'н': 'h',
            'і': 'i'
        };

        s = s.replace(/./g, ch => map[ch] ?? ch).replace(/\s+/g, ' ');
        return s;
    }

    const TARGET_N = norm(TARGET_GROUP);

    // Проверка, является ли группа "нашей" (включая подгруппы)
    function isOur(groupName) {
        return norm(groupName).startsWith(TARGET_N);
    }

    // Парсер дат DD.MM.YY(YY) HH:MM
    function parseRUDate(s) {
        s = (typeof s === 'string') ? s : '';
        const m = s.match(/(\d{2})\.(\d{2})\.(\d{2,4})\s+(\d{1,2}):(\d{2})/);
        if (!m) return 0;

        const dd = +m[1], MM = +m[2] - 1;
        const yyyy = m[3].length === 2 ? 2000 + +m[3] : +m[3];
        const HH = +m[4], mm = +m[5];

        return new Date(yyyy, MM, dd, HH, mm).getTime();
    }

    // Извлечение событий из таблицы actionGrid
    function extractEvents() {
        const grid = document.getElementById('actionGrid');
        if (!grid) return [];

        const rows = Array.from(grid.querySelectorAll('tr'))
            .filter(r => r.querySelectorAll('td').length > 7);

        const evs = rows.map(row => {
            const tds = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());

            const action = tds[2] || '';
            const date = tds[3] || '';
            const gExec = tds[5] || '';
            const gAssgn = tds[7] || '';
            const dt = parseRUDate(date);

            return {
                action,
                date,
                dt,
                gExec,
                gAssgn,
                gExecN: norm(gExec),
                gAssgnN: norm(gAssgn)
            };
        });

        // Критично: всегда считаем в хронологическом порядке
        return evs.filter(e => e.dt > 0).sort((a, b) => a.dt - b.dt);
    }

    // Расчёт «чистых» интервалов на группе
    function computeIntervals(events) {
        // Старт периода ответственности нашей группы (включая подгруппы)
        const isStartOnUs = ev =>
            ev.action === 'Переоткрыть' ||
            (ev.action === 'Назначить' && isOur(ev.gAssgn)) ||
            (ev.action === 'Принять в работу' && isOur(ev.gExec));

        // Потеря ответственности (уходит к группе, НЕ являющейся нашей подгруппой)
        const leftOurGroup = ev =>
            (ev.action === 'Назначить' && !isOur(ev.gAssgn)) ||
            (ev.action === 'Принять в работу' && !isOur(ev.gExec));

        // Завершение нашей группой (включая подгруппы)
        const isFinishByUs = ev =>
            /Выполнить|complete|resolve|close/i.test(ev.action) && isOur(ev.gExec);

        let intervals = [];
        let inGroup = false;
        let tStart = null;
        let startDate = null;

        for (const ev of events) {
            if (DEBUG) console.log('EVT:', ev.date, ev.action, ev.gExec, ev.gAssgn);

            // Повторный старт на нас — закрывает предыдущий интервал и открывает новый
            if (isStartOnUs(ev)) {
                if (inGroup && tStart !== null && ev.dt > tStart) {
                    intervals.push({
                        start: startDate,
                        end: ev.date,
                        min: Math.round((ev.dt - tStart) / 60000)
                    });
                    if (DEBUG) console.log('END by re-start:', startDate, '→', ev.date);
                }

                inGroup = true;
                tStart = ev.dt;
                startDate = ev.date;
                if (DEBUG) console.log('START on us:', startDate);
                continue;
            }

            // Переназначено/принято группой, НЕ являющейся нашей — обрезаем
            if (inGroup && leftOurGroup(ev) && ev.dt > tStart) {
                intervals.push({
                    start: startDate,
                    end: ev.date,
                    min: Math.round((ev.dt - tStart) / 60000)
                });
                if (DEBUG) console.log('END by leaving:', startDate, '→', ev.date, ev.gAssgn || ev.gExec);
                inGroup = false;
                tStart = null;
                startDate = null;
                continue;
            }

            // Выполнено нашей группой (включая подгруппы) — обрезаем
            if (inGroup && isFinishByUs(ev) && ev.dt > tStart) {
                intervals.push({
                    start: startDate,
                    end: ev.date,
                    min: Math.round((ev.dt - tStart) / 60000)
                });
                if (DEBUG) console.log('END by finish:', startDate, '→', ev.date);
                inGroup = false;
                tStart = null;
                startDate = null;
            }
        }

        // Хвост (незавершённый период) намеренно не учитываем для SLA.
        const total = intervals.reduce((s, p) => s + p.min, 0);
        return { intervals, total };
    }

    // Плашка с итогом
    function showBadge(text) {
        let el = document.getElementById('assyst-time-badge');
        if (!el) {
            el = document.createElement('div');
            el.id = 'assyst-time-badge';
            Object.assign(el.style, {
                position: 'fixed',
                right: '16px',
                top: '16px',
                zIndex: 999999,
                background: 'rgba(20,20,20,.92)',
                color: '#fff',
                padding: '8px 12px',
                font: '12px/1.3 -apple-system,Segoe UI,Roboto',
                borderRadius: '8px',
                pointerEvents: 'none'
            });
            document.documentElement.appendChild(el);
        }
        el.textContent = text;
    }

    function main() {
        const events = extractEvents();
        const { intervals, total } = computeIntervals(events);

        // Итог
        let msg = `Время на группе «${TARGET_GROUP}»: ${Math.floor(total / 60)} ч ${total % 60} мин`;
        if (intervals.length > 1) msg += ` (интервалов: ${intervals.length})`;

        showBadge(msg);

        if (DEBUG) {
            console.log('— Итоговые интервалы —');
            intervals.forEach((p, i) => console.log(`#${i + 1}: ${p.start} — ${p.end} = ${p.min} мин`));
        }
    }

    function readyLoop() {
        if (document.getElementById('actionGrid')) {
            main();
            const mo = new MutationObserver(main);
            mo.observe(document.getElementById('actionGrid'), { childList: true, subtree: true });
        } else {
            setTimeout(readyLoop, 400);
        }
    }

    // Реакция на SPA-навигацию Assyst
    const p = history.pushState, r = history.replaceState;
    history.pushState = function () { const o = p.apply(this, arguments); window.dispatchEvent(new Event('assyst-route')); return o; };
    history.replaceState = function () { const o = r.apply(this, arguments); window.dispatchEvent(new Event('assyst-route')); return o; };
    window.addEventListener('popstate', () => window.dispatchEvent(new Event('assyst-route')));
    window.addEventListener('assyst-route', () => readyLoop());

    readyLoop();
})();
