import * as db from './db.js';
import {
  uid, pad, toISO, fromISO, addDays, weekday, startOfWeek, monthKey, shiftMonth, toMin, fromMin, nowMin,
  monthTitle, dayTitle, relDay, formatRub, parseRub, plural, lessonsWord, WD_SHORT, WD_FULL, MONTHS_GEN,
  priceAt, lessonPrice, withPrice, statusOf, isCharged, STATUS_LABEL, sortLessons, conflicts, endTime,
  studentStats, balanceText, monthStats, totalDebt, extendSeries, seriesText, COLORS, nextColor, validateBackup,
  lessonStart, isBusy,
} from './logic.js';
import { interpret, findCommands, findSchedule, EXAMPLES, speechSupported, listen } from './voice.js';
import { recognize } from './ocr.js';
import * as media from './media.js';

const APP_VERSION = 'v10';
const ZOOMS = [28, 36, 46, 60, 76, 96, 124];
const BACKUP_REMIND_DAYS = 30;
const DEFAULT_SHEETS = [
  { id: 'tutor', name: 'Репетиторство', color: '#007aff' },
  { id: 'school', name: 'Школа', color: '#ff9500' },
];
const DEFAULT_SETTINGS = { price: 1500, duration: 60, dayStart: 8, dayEnd: 22, sheets: DEFAULT_SHEETS };

const S = {
  tab: 'cal',
  calMode: 'day', // day | 3day | week | month
  zoom: 60, // пикселей на час
  shown: null, // какие листы показаны; null — все
  date: toISO(new Date()),
  moneyMonth: monthKey(toISO(new Date())),
  students: [],
  lessons: [],
  payments: [],
  series: [],
  media: [],
  settings: { ...DEFAULT_SETTINGS },
  lastBackup: null,
  query: '',
  showArchived: false,
  sheet: null,
  sheetStack: [],
  scrollToNow: true,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => new Date();
const today = () => toISO(new Date());
const stById = (id) => S.students.find((s) => s.id === id);
const activeStudents = () => S.students.filter((s) => !s.archived).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
/* Листы календаря: у каждого ученика (класса) свой лист — «Репетиторство», «Школа»… */
const sheets = () => (S.settings.sheets?.length ? S.settings.sheets : DEFAULT_SHEETS);
const sheetById = (id) => sheets().find((x) => x.id === id);
const sheetOf = (stu) => (stu && sheetById(stu.sheet) ? stu.sheet : sheets()[0].id);
const shownIds = () => {
  const ids = (S.shown || []).filter((id) => sheetById(id));
  return ids.length ? ids : sheets().map((x) => x.id);
};
const allShown = () => shownIds().length === sheets().length;
const visibleStudent = (stu) => shownIds().includes(sheetOf(stu));
/** Лист для нового ученика: открытый сейчас, если открыт один. */
const defaultSheet = () => (allShown() ? sheets()[0].id : shownIds()[0]);
/** Уроки дня в календаре — только с показанных листов. */
const dayLessons = (iso) => S.lessons.filter((l) => l.date === iso && visibleStudent(stById(l.studentId))).sort(sortLessons);
const TIMELINE = { day: 1, '3day': 3, week: 7 };
const calDays = () => {
  const n = TIMELINE[S.calMode] || 1;
  const first = S.calMode === 'week' ? startOfWeek(S.date) : S.date;
  return Array.from({ length: n }, (_, i) => addDays(first, i));
};
const saveView = () => db.setMeta('view', { calMode: S.calMode, zoom: S.zoom, shown: S.shown }).catch(console.error);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/* ---------- Тост с отменой ---------- */

let undoOps = null;
function toast(msg, undo = null) {
  const t = $('#toast');
  undoOps = undo;
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button data-act="undo">Вернуть</button>' : ''}`;
  t.classList.toggle('has-btn', Boolean(undo));
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.classList.remove('show'); undoOps = null; }, undo ? 6000 : 2600);
}

/* ---------- Изменение данных ---------- */

const ARR = { students: () => S.students, lessons: () => S.lessons, payments: () => S.payments, series: () => S.series, media: () => S.media };

function applyLocal(ops) {
  for (const o of ops) {
    if (o.put) {
      const [store, item] = o.put;
      const arr = ARR[store]();
      const i = arr.findIndex((x) => x.id === item.id);
      if (i >= 0) arr[i] = item; else arr.push(item);
    } else {
      const [store, id] = o.del;
      const arr = ARR[store]();
      const i = arr.findIndex((x) => x.id === id);
      if (i >= 0) arr.splice(i, 1);
    }
  }
}

/** Сохранить изменения; возвращает обратные операции для «Вернуть». */
async function commit(ops, msg) {
  for (const o of ops) if (o.put?.[0] === 'students' && !o.put[1].sheet) o.put[1] = { ...o.put[1], sheet: defaultSheet() };
  const inverse = [];
  for (const o of [...ops].reverse()) {
    const [store, x] = o.put || o.del;
    const id = o.put ? x.id : x;
    const prev = ARR[store]().find((y) => y.id === id);
    inverse.push(prev ? { put: [store, structuredClone(prev)] } : { del: [store, id] });
  }
  await db.apply(ops);
  applyLocal(ops);
  render();
  if (msg) toast(msg, inverse);
  return inverse;
}

async function undo() {
  if (!undoOps) return;
  const ops = undoOps;
  undoOps = null;
  await db.apply(ops);
  applyLocal(ops);
  render();
  toast('Вернул как было');
}

/* ---------- Календарь ---------- */

function calHeader() {
  const d = fromISO(S.date);
  const isToday = S.date === today();
  const modes = [['day', 'День'], ['3day', '3 дня'], ['week', 'Неделя'], ['month', 'Месяц']];
  return `
    <div class="cal-head">
      <button class="cal-title" data-act="cal-mode" data-mode="month">
        ${cap(monthTitle(monthKey(S.date)).split(' ')[0])}${d.getFullYear() !== now().getFullYear() ? `<span class="muted"> ${d.getFullYear()}</span>` : ''}
      </button>
      <div class="cal-tools">
        ${S.calMode === 'month' ? '' : zoomBtns()}
        <button class="pill ${isToday ? 'dim' : ''}" data-act="goto" data-date="${today()}">Сегодня</button>
        <button class="icon-btn" data-act="lesson-new" aria-label="Новый урок">+</button>
      </div>
    </div>
    <div class="seg cal-seg">${modes.map(([m, t]) => `<button class="${S.calMode === m ? 'on' : ''}" data-act="cal-mode" data-mode="${m}">${t}</button>`).join('')}</div>
    ${sheetBar()}`;
}

/** Переключатель листов. Один лист — только его уроки; отметить ещё — листы совмещаются. */
function sheetBar() {
  const list = sheets();
  if (list.length < 2) return `<div class="sheets"><button class="sh add" data-act="sheets-open">+ Лист</button></div>`;
  const ids = shownIds();
  return `
    <div class="sheets" role="group" aria-label="Листы: какие показывать">
      ${list.map((x) => {
    const on = ids.includes(x.id);
    return `<button class="sh ${on ? 'on' : ''}" style="--c:${x.color}" data-act="sheet-tap" data-id="${x.id}" aria-pressed="${on}"><i>${on ? '✓' : ''}</i>${esc(x.name)}</button>`;
  }).join('')}
      ${allShown() ? '' : '<button class="sh ghost" data-act="sheet-all">Все</button>'}
      <button class="sh ghost gear" data-act="sheets-open" aria-label="Настроить листы">⚙</button>
    </div>`;
}

function weekStrip() {
  const start = startOfWeek(S.date);
  const t = today();
  const cells = [];
  for (let i = 0; i < 7; i++) {
    const iso = addDays(start, i);
    const ls = dayLessons(iso).filter((l) => l.status !== 'cancelled');
    const cls = [iso === S.date ? 'sel' : '', iso === t ? 'today' : ''].join(' ');
    cells.push(`
      <button class="wd ${cls}" data-act="goto" data-date="${iso}">
        <span class="wd-l">${WD_SHORT[i][0]}</span>
        <span class="wd-n">${fromISO(iso).getDate()}</span>
        <span class="wd-dots">${ls.slice(0, 4).map((l) => `<i style="background:${stById(l.studentId)?.color || '#999'}"></i>`).join('')}</span>
      </button>`);
  }
  return `<div class="week" data-swipe="week">${cells.join('')}</div>`;
}

const zoomBtns = () => `<span class="zoom">
    <button data-act="zoom" data-d="-1" ${S.zoom <= ZOOMS[0] ? 'disabled' : ''} aria-label="Мельче">−</button>
    <button data-act="zoom" data-d="1" ${S.zoom >= ZOOMS.at(-1) ? 'disabled' : ''} aria-label="Крупнее">+</button></span>`;

function daySummary(iso) {
  const ls = dayLessons(iso).filter((l) => l.status !== 'cancelled' && !isBusy(stById(l.studentId)));
  const sum = ls.reduce((a, l) => a + lessonPrice(l, stById(l.studentId)), 0);
  return `<div class="day-sum"><strong>${cap(dayTitle(iso, { full: true }))}</strong><span class="muted">${ls.length ? `${lessonsWord(ls.length)} · ${formatRub(sum)}` : 'Нет уроков'}</span></div>`;
}

function rangeSummary(days) {
  const ls = days.flatMap((d) => dayLessons(d)).filter((l) => l.status !== 'cancelled' && !isBusy(stById(l.studentId)));
  const sum = ls.reduce((a, l) => a + lessonPrice(l, stById(l.studentId)), 0);
  const a = fromISO(days[0]);
  const b = fromISO(days.at(-1));
  const title = a.getMonth() === b.getMonth() ? `${a.getDate()}–${b.getDate()} ${MONTHS_GEN[b.getMonth()]}` : `${a.getDate()} ${MONTHS_GEN[a.getMonth()]} – ${b.getDate()} ${MONTHS_GEN[b.getMonth()]}`;
  return `<div class="day-sum">
      <span class="rng"><button data-act="shift" data-d="-1" aria-label="Назад">‹</button><strong>${title}</strong><button data-act="shift" data-d="1" aria-label="Вперёд">›</button></span>
      <span class="muted">${ls.length ? `${lessonsWord(ls.length)} · ${formatRub(sum)}` : 'Нет уроков'}</span></div>`;
}

/** Раскладка пересекающихся уроков по колонкам. */
function layoutColumns(ls) {
  const items = ls.map((l) => ({ l, s: toMin(l.start), e: toMin(l.start) + l.duration, col: 0, cols: 1 }));
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const ends = [];
    for (const it of cluster) {
      let c = ends.findIndex((e) => e <= it.s);
      if (c < 0) { c = ends.length; ends.push(0); }
      ends[c] = it.e;
      it.col = c;
    }
    for (const it of cluster) it.cols = ends.length;
    cluster = [];
  };
  for (const it of items) {
    if (it.s >= clusterEnd && cluster.length) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) flush();
  return items;
}

function lessonBlockClass(st) {
  return { done: 'is-done', missed: 'is-missed', cancelled: 'is-cancelled', planned: '' }[st];
}

/**
 * Шкала времени на один или несколько дней. Все высоты — через var(--hp) (пикселей на час),
 * поэтому масштаб щипком меняется плавно, без перерисовки.
 */
function timeline(days) {
  const N = days.length;
  const perDay = days.map((d) => dayLessons(d));
  let h0 = S.settings.dayStart;
  let h1 = S.settings.dayEnd;
  for (const l of perDay.flat()) {
    h0 = Math.min(h0, Math.floor(toMin(l.start) / 60));
    h1 = Math.max(h1, Math.ceil((toMin(l.start) + l.duration) / 60));
  }
  const n = now();
  const t = toISO(n);
  const mixed = shownIds().length > 1 && sheets().length > 1;
  const colL = (x) => `calc(56px + (100% - 60px) * ${x})`;
  const parts = [];
  for (let h = h0; h <= h1; h++) {
    parts.push(`<div class="hr" style="top:calc(${h - h0} * var(--hp))"><span>${pad(h)}:00</span></div>`);
    if (h === h1) continue;
    days.forEach((d, di) => parts.push(`<button class="slot" data-act="slot" data-h="${h}" data-date="${d}" style="top:calc(${h - h0} * var(--hp));height:var(--hp);left:${colL(di / N)};width:calc((100% - 60px) / ${N})" aria-label="Урок ${dayTitle(d)} в ${pad(h)}:00"></button>`));
  }
  for (let di = 1; di < N; di++) parts.push(`<div class="vl" style="left:${colL(di / N)}"></div>`);
  days.forEach((d, di) => {
    for (const { l, s, col, cols } of layoutColumns(perDay[di])) {
      const stu = stById(l.studentId);
      const st = statusOf(l, n);
      const hpx = (l.duration / 60) * S.zoom;
      const tag = st === 'done' ? '✓' : st === 'missed' ? 'пропуск' : st === 'cancelled' ? 'отменён' : '';
      const sh = mixed ? sheetById(sheetOf(stu)) : null;
      parts.push(`
      <button class="lb ${lessonBlockClass(st)} ${hpx < 40 ? 'tiny' : ''}" data-act="lesson-open" data-id="${l.id}"
        style="--c:${stu?.color || '#8e8e93'};top:calc(${(s - h0 * 60) / 60} * var(--hp));height:max(22px, calc(${l.duration / 60} * var(--hp) - 2px));left:${colL((di + col / cols) / N)};width:calc((100% - 60px) / ${N * cols} - 2px)">
        ${sh ? `<i class="lb-sh" style="background:${sh.color}" title="${esc(sh.name)}"></i>` : ''}
        <span class="lb-name">${esc(stu?.name || 'Без ученика')}</span>
        <span class="lb-time">${N > 3 ? l.start : `${l.start}–${endTime(l)}`}${tag && N < 7 ? ` · ${tag}` : ''}</span>
        ${l.note && hpx >= 56 && N === 1 ? `<span class="lb-note">${esc(l.note)}</span>` : ''}
      </button>`);
    }
  });
  const di = days.indexOf(t);
  if (di >= 0) {
    const m = nowMin(n);
    if (m >= h0 * 60 && m <= h1 * 60) {
      parts.push(`<div class="now ${N > 1 ? 'part' : ''}" style="top:calc(${(m - h0 * 60) / 60} * var(--hp));${N > 1 ? `left:${colL(di / N)};width:calc((100% - 60px) / ${N})` : ''}"><span>${fromMin(m)}</span></div>`);
    }
  }
  const head = N > 1 ? `<div class="mdh" style="grid-template-columns:52px repeat(${N}, 1fr)"><span></span>${days.map((d) => {
    const dd = fromISO(d);
    return `<button class="${d === t ? 'today' : ''} ${d === S.date ? 'sel' : ''}" data-act="open-day" data-date="${d}"><span>${WD_SHORT[weekday(d)]}</span><b>${dd.getDate()}</b></button>`;
  }).join('')}</div>` : '';
  return `${head}<div class="tl ${N > 1 ? `multi n${N}` : ''}" data-swipe="day" data-n="${N}" style="--hp:${S.zoom}px;height:calc(${h1 - h0} * var(--hp) + 16px)" data-h0="${h0}">${parts.join('')}</div>`;
}

function monthGrid() {
  const key = monthKey(S.date);
  const start = startOfWeek(`${key}-01`);
  const t = today();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const iso = addDays(start, i);
    if (i >= 35 && monthKey(iso) !== key) break;
    const inMonth = monthKey(iso) === key;
    const ls = dayLessons(iso).filter((l) => l.status !== 'cancelled');
    cells.push(`
      <button class="mc ${inMonth ? '' : 'out'} ${iso === S.date ? 'sel' : ''} ${iso === t ? 'today' : ''}" data-act="pick" data-date="${iso}">
        <span class="mc-n">${fromISO(iso).getDate()}</span>
        <span class="mc-dots">${ls.slice(0, 3).map((l) => `<i style="background:${stById(l.studentId)?.color || '#999'}"></i>`).join('')}${ls.length > 3 ? '<b>+</b>' : ''}</span>
      </button>`);
  }
  return `
    <div class="month-nav">
      <button data-act="month" data-d="-1" aria-label="Предыдущий месяц">‹</button>
      <strong>${monthTitle(key)}</strong>
      <button data-act="month" data-d="1" aria-label="Следующий месяц">›</button>
    </div>
    <div class="mgrid-head">${WD_SHORT.map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="mgrid" data-swipe="month">${cells.join('')}</div>`;
}

function agenda(iso) {
  const ls = dayLessons(iso);
  if (!ls.length) return `<div class="empty">Уроков нет<br><button class="link" data-act="lesson-new">Добавить урок</button></div>`;
  const n = now();
  return `<div class="list">${ls.map((l) => {
    const stu = stById(l.studentId);
    const st = statusOf(l, n);
    return `
      <button class="ag ${lessonBlockClass(st)}" data-act="lesson-open" data-id="${l.id}">
        <span class="ag-time"><b>${l.start}</b><span>${endTime(l)}</span></span>
        <i class="ag-bar" style="background:${stu?.color || '#999'}"></i>
        <span class="ag-mid"><span class="ag-name">${esc(stu?.name || '—')}</span><span class="sub">${STATUS_LABEL[st]} · ${l.duration} мин</span></span>
        <span class="ag-price">${formatRub(lessonPrice(l, stu))}</span>
      </button>`;
  }).join('')}</div>`;
}

function backupBanner() {
  const days = S.lastBackup ? (Date.now() - S.lastBackup) / 864e5 : Infinity;
  const firstUse = Math.min(Date.now(), ...S.students.map((s) => s.createdAt || Date.now()));
  if (!S.lessons.length || days <= BACKUP_REMIND_DAYS || (!S.lastBackup && Date.now() - firstUse < 14 * 864e5)) return '';
  return `<div class="banner"><span>${S.lastBackup ? 'Давно не было резервной копии' : 'Резервной копии ещё нет'}</span><button data-act="export">Сохранить</button></div>`;
}

function onboarding() {
  if (S.students.length) return '';
  return `
    <section class="card onboard">
      <h2 class="section-title">С чего начать</h2>
      <p class="muted">Добавьте учеников с ценой урока, затем уроки — разово или каждую неделю. Можно голосом: нажмите 🎤 и скажите
      «новый ученик Маша, цена 1500», потом «Маша каждый вторник в 17».</p>
      <div class="row-btns">
        <button class="btn primary" data-act="student-new">Добавить ученика</button>
        <button class="btn" data-act="voice">🎤 Голосом</button>
      </div>
    </section>`;
}

function calView() {
  if (S.calMode === 'month') {
    return `${calHeader()}${backupBanner()}${monthGrid()}${daySummary(S.date)}${agenda(S.date)}${onboarding()}`;
  }
  if (S.calMode === 'day') return `${calHeader()}${weekStrip()}${backupBanner()}${daySummary(S.date)}${onboarding()}${timeline([S.date])}`;
  const days = calDays();
  return `${calHeader()}${backupBanner()}${rangeSummary(days)}${onboarding()}${timeline(days)}`;
}

/* ---------- Ученики ---------- */

function studentRow(s) {
  const st = studentStats(s, S.lessons, S.payments, now());
  const badge = st.balance < 0 ? 'bad' : st.balance > 0 ? 'good' : '';
  const busy = isBusy(s);
  return `
    <button class="srow" data-act="student-open" data-id="${s.id}">
      <i class="dot" style="background:${s.color}"></i>
      <span class="srow-mid">
        <span class="srow-name">${esc(s.name)}</span>
        <span class="sub">${busy ? 'не урок' : formatRub(st.price)} · ${st.next ? `след. ${relDay(st.next.date, today())} ${st.next.start}` : 'ничего впереди'}</span>
      </span>
      ${busy ? '' : `<span class="badge ${badge}">${balanceText(st)}</span>`}
    </button>`;
}

function studentsView() {
  const q = S.query.trim().toLowerCase();
  const list = S.students
    .filter((s) => (S.showArchived ? s.archived : !s.archived))
    .filter((s) => !q || `${s.name} ${s.aliases || ''}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const archivedCount = S.students.filter((s) => s.archived).length;
  return `
    <div class="page-head"><h1 class="title">${S.showArchived ? 'Архив' : 'Ученики'}</h1><button class="icon-btn" data-act="student-new" aria-label="Новый ученик">+</button></div>
    ${S.students.length > 6 ? `<input class="search" type="search" placeholder="Поиск" value="${esc(S.query)}" data-input="query">` : ''}
    ${sheetBar()}
    ${sheets().filter((x) => shownIds().includes(x.id)).map((x) => {
    const mine = list.filter((s) => sheetOf(s) === x.id);
    if (!mine.length) return '';
    const title = sheets().length > 1 ? `<h2 class="section-title mt"><i class="dot" style="background:${x.color}"></i> ${esc(x.name)}</h2>` : '';
    return `${title}
      ${mine.some((s) => !isBusy(s)) ? `<div class="list">${mine.filter((s) => !isBusy(s)).map(studentRow).join('')}</div>` : ''}
      ${mine.some(isBusy) ? `<h3 class="sub mt">Занятость</h3><div class="list">${mine.filter(isBusy).map(studentRow).join('')}</div>` : ''}`;
  }).join('')}
    ${list.length ? '' : `<div class="empty">${S.showArchived ? 'Архив пуст' : 'Учеников пока нет'}<br>${S.showArchived ? '' : '<button class="link" data-act="student-new">Добавить ученика</button>'}</div>`}
    ${archivedCount || S.showArchived ? `<button class="btn ghost" data-act="toggle-archived">${S.showArchived ? '← Активные ученики' : `Архив (${archivedCount})`}</button>` : ''}`;
}

/* ---------- Деньги ---------- */

function moneyView() {
  const key = S.moneyMonth;
  const n = now();
  const ms = monthStats(key, S, n);
  const debt = totalDebt(S.students.filter((s) => !s.archived), S.lessons, S.payments, n);
  const rows = [...ms.perStudent.entries()].map(([id, r]) => ({ s: stById(id), ...r })).filter((r) => r.s).sort((a, b) => b.earned - a.earned || b.received - a.received);
  const max = Math.max(1, ...rows.map((r) => r.earned + r.planned * priceAt(r.s, `${key}-28`)));
  const debtors = activeStudents().map((s) => ({ s, st: studentStats(s, S.lessons, S.payments, n) })).filter((x) => x.st.balance < 0).sort((a, b) => a.st.balance - b.st.balance);
  const pays = S.payments.filter((p) => monthKey(p.date) === key).sort((a, b) => b.date.localeCompare(a.date));
  return `
    <div class="page-head"><h1 class="title">Деньги</h1></div>
    <div class="month-nav">
      <button data-act="money-month" data-d="-1" aria-label="Предыдущий месяц">‹</button>
      <strong>${monthTitle(key)}</strong>
      <button data-act="money-month" data-d="1" aria-label="Следующий месяц">›</button>
    </div>
    <section class="card hero">
      <span class="label">Заработано за проведённые уроки</span>
      <span class="big">${formatRub(ms.earned)}</span>
      <div class="note">${lessonsWord(ms.done + ms.missed)}${ms.missed ? `, из них пропусков ${ms.missed}` : ''}${ms.cancelled ? ` · отменено ${ms.cancelled}` : ''}</div>
      <div class="stats">
        <div><b>${formatRub(ms.received)}</b><span>Получено оплат</span></div>
        <div><b>${formatRub(ms.plannedSum)}</b><span>Ещё впереди (${ms.planned})</span></div>
        <div><b class="${debt ? 'bad-t' : ''}">${formatRub(debt)}</b><span>Долги сейчас</span></div>
      </div>
    </section>
    ${rows.length ? `
      <section class="card">
        <h2 class="section-title">По ученикам</h2>
        ${rows.map((r) => `
          <button class="meter-row" data-act="student-open" data-id="${r.s.id}">
            <div class="meter-top"><span class="nm"><i class="dot" style="background:${r.s.color}"></i>${esc(r.s.name)}</span><span class="val">${formatRub(r.earned)}</span></div>
            <div class="bar"><i style="width:${(r.earned / max) * 100}%;background:${r.s.color}"></i><i class="ghost" style="width:${((r.planned * priceAt(r.s, `${key}-28`)) / max) * 100}%"></i></div>
            <div class="note">${lessonsWord(r.lessons)}${r.planned ? ` · впереди ${r.planned}` : ''} · оплачено ${formatRub(r.received)}</div>
          </button>`).join('')}
      </section>` : '<div class="empty">В этом месяце уроков нет</div>'}
    ${debtors.length ? `
      <section class="card">
        <h2 class="section-title">Должники</h2>
        ${debtors.map(({ s, st }) => `
          <button class="list-row" data-act="pay-new" data-student="${s.id}">
            <span><i class="dot" style="background:${s.color}"></i>${esc(s.name)}</span>
            <span class="bad-t">${formatRub(-st.balance)} · принять</span>
          </button>`).join('')}
      </section>` : ''}
    ${pays.length ? `
      <section class="card">
        <h2 class="section-title">Оплаты за месяц</h2>
        ${pays.map((p) => `
          <button class="list-row" data-act="pay-open" data-id="${p.id}">
            <span>${esc(stById(p.studentId)?.name || '—')}<span class="sub block">${dayTitle(p.date)}${p.note ? ` · ${esc(p.note)}` : ''}</span></span>
            <b class="good-t">${formatRub(p.amount)}</b>
          </button>`).join('')}
      </section>` : ''}
    <button class="btn" data-act="pay-new">+ Записать оплату</button>`;
}

/* ---------- Ещё ---------- */

function moreView() {
  const st = S.settings;
  return `
    <div class="page-head"><h1 class="title">Ещё</h1></div>
    <section class="card">
      <h2 class="section-title">По умолчанию</h2>
      <div class="two">
        <label class="field">Цена урока, ₽<input class="input" inputmode="numeric" value="${st.price}" data-setting="price"></label>
        <label class="field">Длительность, мин<input class="input" inputmode="numeric" value="${st.duration}" data-setting="duration"></label>
      </div>
      <div class="two mt">
        <label class="field">День с<select class="input" data-setting="dayStart">${hourOptions(st.dayStart, 0, 12)}</select></label>
        <label class="field">День до<select class="input" data-setting="dayEnd">${hourOptions(st.dayEnd, 13, 24)}</select></label>
      </div>
    </section>
    <section class="card">${sheetsManager()}</section>
    <section class="card">
      <h2 class="section-title">Уроки</h2>
      ${(() => {
    const n = lessonsToWipe().length;
    const name = allShown() ? '' : ` (${shownIds().map((id) => sheetById(id).name).join(', ')})`;
    return `<p class="muted small">${n ? `В календаре ${lessonsWord(n)}${name}. Ученики, оплаты и файлы останутся.` : 'Уроков нет.'}</p>
      ${n ? `<button class="btn danger mt" data-act="lessons-wipe">Удалить все уроки${esc(name)}</button>` : ''}`;
  })()}
    </section>
    <section class="card">
      <h2 class="section-title">Резервная копия</h2>
      <p class="muted small">Все данные хранятся только на этом телефоне. Раз в месяц сохраняйте копию в «Файлы» или отправьте себе.</p>
      <div class="row-btns mt">
        <button class="btn primary" data-act="export">Сохранить копию</button>
        <label class="btn">Восстановить<input type="file" accept="application/json,.json" data-change="restore"></label>
      </div>
      <p class="note">${S.lastBackup ? `Последняя копия: ${new Date(S.lastBackup).toLocaleDateString('ru-RU')}` : 'Копий ещё не было'}</p>
    </section>
    <section class="card">
      <h2 class="section-title">Голосовые команды</h2>
      <p class="muted small">Нажмите 🎤 внизу и скажите, что сделать. Перед изменением покажу, что понял, — останется нажать «Применить».</p>
      <ul class="examples">${EXAMPLES.map((e) => `<li>«${esc(e)}»</li>`).join('')}</ul>
    </section>
    <section class="card">
      <h2 class="section-title">Как поставить на iPhone</h2>
      <p class="muted small">Откройте сайт в Safari → «Поделиться» → «На экран „Домой“». После первого запуска приложение работает без интернета.</p>
    </section>
    <p class="note center">Версия ${APP_VERSION} · <button class="link" data-act="hard-reload">Обновить приложение</button></p>`;
}

/** Листы: создать, переименовать, перекрасить, удалить. И в «Ещё», и по ⚙ в календаре. */
function sheetsManager() {
  return `
      <h2 class="section-title">Листы календаря</h2>
      <p class="muted small">У каждого ученика (класса) свой лист. Вверху календаря: нажмите лист — будут только его уроки, нажмите ещё один — листы совместятся, «Все» — всё расписание сразу. Лист ученика меняется в его карточке.</p>
      <div class="sheet-list">${sheets().map((x) => `
        <div class="sheet-row">
          <button class="sw" style="background:${x.color}" data-act="sheet-color" data-id="${x.id}" aria-label="Сменить цвет"></button>
          <input class="input" value="${esc(x.name)}" data-sheetname="${x.id}" aria-label="Название листа">
          <span class="muted small">${S.students.filter((s) => sheetOf(s) === x.id).length} уч.</span>
          ${sheets().length > 1 ? `<button class="link danger-t" data-act="sheet-del" data-id="${x.id}" aria-label="Удалить лист">✕</button>` : ''}
        </div>`).join('')}</div>
      <button class="btn mt" data-act="sheet-add">+ Новый лист</button>`;
}

function hourOptions(sel, from, to) {
  let o = '';
  for (let h = from; h <= to; h++) o += `<option value="${h}" ${h === sel ? 'selected' : ''}>${pad(h)}:00</option>`;
  return o;
}

/* ---------- Отрисовка ---------- */

function render() {
  const view = $('#view');
  const html = { cal: calView, students: studentsView, money: moneyView, more: moreView }[S.tab]();
  view.innerHTML = html;
  for (const b of document.querySelectorAll('#tabs [data-tab]')) b.classList.toggle('on', b.dataset.tab === S.tab);
  if (S.tab === 'cal' && S.calMode !== 'month' && S.scrollToNow) {
    S.scrollToNow = false;
    const tl = $('.tl');
    if (tl) {
      const days = calDays();
      const first = days.flatMap((d) => dayLessons(d)).sort((a, b) => toMin(a.start) - toMin(b.start))[0];
      const h0 = Number(tl.dataset.h0);
      const target = days.includes(today()) ? nowMin(now()) - 90 : first ? toMin(first.start) - 30 : (h0 + 1) * 60;
      view.scrollTop = Math.max(0, tl.offsetTop + ((target - h0 * 60) / 60) * S.zoom - 20);
    }
  }
  renderSheet();
  animateView();
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(.2, .8, .2, 1)';
/** Плавное появление после смены вкладки, вида, дня или листа. Обычные перерисовки — без анимации. */
function animateView() {
  const a = S.anim;
  S.anim = null;
  if (!a || reducedMotion()) return;
  if (a === 'tab') {
    $('#view').animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE });
    return;
  }
  const dx = a === 'next' ? 22 : a === 'prev' ? -22 : 0;
  const dy = a === 'fade' ? 6 : 0;
  const sel = a === 'fade' ? '.tl, .mdh, .week, .mgrid, .day-sum, .list, .empty' : '.tl, .mdh, .mgrid, .day-sum, .list, .empty';
  for (const el of document.querySelectorAll(sel.split(', ').map((x) => `#view ${x}`).join(', '))) {
    el.animate([{ opacity: 0, transform: `translate(${dx}px, ${dy}px)` }, { opacity: 1, transform: 'none' }], { duration: 280, easing: EASE });
  }
}

function go(iso) {
  if (!S.anim) S.anim = iso > S.date ? 'next' : iso < S.date ? 'prev' : null;
  S.date = iso;
}

/* ---------- Шторки ---------- */

function openSheet(sheet, { push = false } = {}) {
  if (push && S.sheet) S.sheetStack.push(S.sheet);
  else S.sheetStack = [];
  S.sheet = sheet;
  renderSheet();
}

function closeSheet() {
  if (S.sheet?.rec) try { S.sheet.rec.abort(); } catch { /* уже остановлено */ }
  S.sheet = S.sheetStack.pop() || null;
  renderSheet();
}

function renderSheet() {
  const root = $('#sheet-root');
  const ov = $('.overlay', root);
  if (!S.sheet) {
    document.body.classList.remove('locked');
    root._sheet = null;
    if (ov && !reducedMotion()) {
      if (!ov.classList.contains('closing')) {
        ov.classList.add('closing');
        setTimeout(() => { if (!S.sheet) { root.innerHTML = ''; root.dataset.type = ''; } }, 260);
      }
    } else { root.innerHTML = ''; root.dataset.type = ''; }
    return;
  }
  const fresh = !ov || ov.classList.contains('closing');
  const swapped = !fresh && root._sheet !== S.sheet;
  root._sheet = S.sheet;
  const fn = { sheets: (sh) => `${head('Листы')}${sheetsManager()}`, lesson: lessonSheet, student: studentSheet, studentEdit: studentEditSheet, payment: paymentSheet, series: seriesSheet, voice: voiceSheet, media: mediaSheet }[S.sheet.type];
  const prevScroll = $('.sheet', root)?.scrollTop || 0;
  const same = root.dataset.type === S.sheet.type;
  root.dataset.type = S.sheet.type;
  root.innerHTML = `<div class="overlay ${fresh ? 'enter' : ''}" data-act="overlay"><div class="sheet ${S.sheet.full ? 'full' : ''} ${swapped ? 'swap' : ''}" role="dialog" aria-modal="true">${fn(S.sheet)}</div></div>`;
  if (same && !swapped && !fresh) $('.sheet', root).scrollTop = prevScroll;
  document.body.classList.add('locked');
}

const head = (title, extra = '') => `<div class="sheet-head"><h2>${title}</h2><div class="head-r">${extra}<button class="close" data-act="close" aria-label="Закрыть">×</button></div></div>`;

function studentOptions(sel) {
  const list = activeStudents();
  const cur = sel && !list.find((s) => s.id === sel) ? [stById(sel)].filter(Boolean) : [];
  return `<option value="" ${sel ? '' : 'selected'} disabled>Выберите ученика</option>${[...cur, ...list].map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}<option value="__new">+ Новый ученик…</option>`;
}

const DURATIONS = [30, 45, 60, 90, 120];

/* Урок */
function lessonSheet(sh) {
  const d = sh.draft;
  const stu = stById(d.studentId);
  const n = now();
  const st = sh.isNew ? 'planned' : statusOf(d, n);
  const past = lessonStart(d) <= n;
  const clash = d.studentId && d.start ? conflicts(S.lessons, d).filter((l) => l.id !== d.id) : [];
  const ser = d.seriesId ? S.series.find((x) => x.id === d.seriesId) : null;
  const statuses = past ? ['done', 'missed', 'cancelled'] : ['planned', 'cancelled'];
  return `
    ${head(sh.isNew ? 'Новый урок' : 'Урок')}
    <label class="field">Ученик<select class="input" data-field="studentId">${studentOptions(d.studentId)}</select></label>
    <div class="two">
      <label class="field">День<input class="input" type="date" value="${d.date}" data-field="date"></label>
      <label class="field">Начало<input class="input" type="time" value="${d.start}" step="300" data-field="start"></label>
    </div>
    <div class="field">Длительность
      <div class="seg seg-n">${DURATIONS.map((m) => `<button data-act="dur" data-v="${m}" class="${d.duration === m ? 'on' : ''}">${m < 60 ? m : m === 60 ? '1 ч' : m === 90 ? '1,5 ч' : '2 ч'}</button>`).join('')}</div>
      ${DURATIONS.includes(d.duration) ? '' : `<span class="note">${d.duration} мин</span>`}
    </div>
    ${isBusy(stu) ? '' : `<label class="field">Цена${stu ? ` (обычная ${formatRub(priceAt(stu, d.date))})` : ''}<input class="input" inputmode="numeric" placeholder="${stu ? priceAt(stu, d.date) : ''}" value="${d.price ?? ''}" data-field="price"></label>`}
    ${clash.length ? `<div class="warn-box">Пересекается: ${clash.map((l) => `${esc(stById(l.studentId)?.name || '')} ${l.start}–${endTime(l)}`).join(', ')}</div>` : ''}
    ${sh.isNew ? `
      <label class="toggle"><input type="checkbox" data-field="repeat" ${sh.repeat ? 'checked' : ''}><span>Повторять каждую неделю (${WD_SHORT[weekday(d.date)].toLowerCase()})</span></label>` : `
      <div class="field">Статус
        <div class="seg seg-n">${statuses.map((x) => `<button data-act="lstatus" data-v="${x}" class="${st === x ? 'on' : ''}">${{ planned: 'Будет', done: 'Проведён', missed: 'Пропуск', cancelled: 'Отменён' }[x]}</button>`).join('')}</div>
        <span class="note">${st === 'missed' ? 'Пропуск без предупреждения — оплачивается' : st === 'cancelled' ? 'Отменённый урок не оплачивается' : st === 'done' ? 'Прошедшие уроки считаются проведёнными сами' : ''}</span>
      </div>`}
    <label class="field">Заметка<input class="input" value="${esc(d.note)}" data-field="note" placeholder="Тема, домашнее задание…"></label>
    ${ser ? `<p class="note">Из расписания: ${seriesText(ser)}. Изменения касаются только этого урока.</p>` : ''}
    <button class="btn primary" data-act="lesson-save" ${d.studentId ? '' : 'disabled'}>${sh.isNew ? 'Добавить' : 'Сохранить'}</button>
    ${sh.isNew ? '' : `
      ${mediaBlock({ lessonId: d.id, studentId: d.studentId })}
      <div class="row-btns">
        <button class="btn" data-act="student-open" data-id="${d.studentId}" data-push="1">Ученик</button>
        <button class="btn danger" data-act="lesson-del">Удалить</button>
      </div>`}`;
}

function newLessonDraft(date, start, studentId = '') {
  const stu = stById(studentId);
  return { id: uid(), studentId, date, start, duration: stu?.duration || S.settings.duration, status: 'planned', price: null, seriesId: null, note: '' };
}

async function saveLesson() {
  const sh = S.sheet;
  const d = { ...sh.draft };
  if (!d.studentId || !d.date || !d.start) return toast('Заполните ученика, день и время');
  if (sh.isNew && sh.repeat) {
    const series = { id: uid(), studentId: d.studentId, days: [weekday(d.date)], start: d.start, duration: d.duration, from: d.date, until: null, generatedUntil: null };
    const ext = extendSeries(series, today() > d.date ? today() : d.date);
    const ops = [{ put: ['series', ext.series] }, ...ext.lessons.map((l) => ({ put: ['lessons', { ...l, price: d.price, note: l.date === d.date ? d.note : '' }] }))];
    closeSheet();
    go(d.date);
    await commit(ops, `Каждый ${WD_FULL[weekday(d.date)]} — ${lessonsWord(ext.lessons.length)}`);
    return;
  }
  closeSheet();
  go(d.date);
  await commit([{ put: ['lessons', d] }], sh.isNew ? 'Урок добавлен' : 'Сохранено');
}

/* Ученик: карточка со статистикой */
function studentSheet(sh) {
  const s = stById(sh.id);
  if (!s) return `${head('Ученик')}<div class="empty">Ученик удалён</div>`;
  const n = now();
  const st = studentStats(s, S.lessons, S.payments, n);
  const own = S.lessons.filter((l) => l.studentId === s.id).sort(sortLessons);
  const upcoming = own.filter((l) => statusOf(l, n) === 'planned').slice(0, 5);
  const history = [
    ...own.filter((l) => statusOf(l, n) !== 'planned').map((l) => ({ kind: 'l', date: l.date, t: l.start, l })),
    ...S.payments.filter((p) => p.studentId === s.id).map((p) => ({ kind: 'p', date: p.date, t: '99', p })),
  ].sort((a, b) => (b.date + b.t).localeCompare(a.date + a.t));
  const shown = sh.all ? history : history.slice(0, 15);
  const series = S.series.filter((x) => x.studentId === s.id && (!x.until || x.until >= today()));
  const balCls = st.balance < 0 ? 'bad-t' : st.balance > 0 ? 'good-t' : '';
  return `
    ${head(`<i class="dot big" style="background:${s.color}"></i>${esc(s.name)}`, `<button class="link" data-act="student-edit" data-id="${s.id}">Изменить</button>`)}
    ${isBusy(s) ? `<p class="muted small">Занятость — показывается в календаре, в деньгах не считается.</p>
    <div class="row-btns">
      <button class="btn" data-act="lesson-new" data-student="${s.id}" data-push="1">+ В календарь</button>
      <button class="btn" data-act="series-new" data-student="${s.id}" data-push="1">Расписание</button>
    </div>` : `
    <section class="card hero">
      <span class="label">Баланс</span>
      <span class="big ${balCls}">${formatRub(st.balance, { sign: true })}</span>
      <div class="note ${balCls}">${cap(balanceText(st))}</div>
      <div class="stats four">
        <div><b>${st.done}</b><span>Проведено</span></div>
        <div><b>${st.missed}</b><span>Пропуски</span></div>
        <div><b>${st.cancelled}</b><span>Отмены</span></div>
        <div><b>${st.planned}</b><span>Впереди</span></div>
      </div>
      <div class="stats">
        <div><b>${formatRub(st.charged)}</b><span>Начислено</span></div>
        <div><b>${formatRub(st.paid)}</b><span>Оплачено</span></div>
        <div><b>${formatRub(st.price)}</b><span>Цена · ${s.duration} мин</span></div>
      </div>
    </section>
    <div class="row-btns three">
      <button class="btn primary" data-act="pay-new" data-student="${s.id}" data-push="1">+ Оплата</button>
      <button class="btn" data-act="lesson-new" data-student="${s.id}" data-push="1">+ Урок</button>
      <button class="btn" data-act="series-new" data-student="${s.id}" data-push="1">Расписание</button>
    </div>`}
    ${series.length ? `
      <section class="card">
        <h3 class="section-title">Каждую неделю</h3>
        ${series.map((x) => `<div class="list-row"><span>${seriesText(x)}</span><button class="link bad-t" data-act="series-stop" data-id="${x.id}">Остановить</button></div>`).join('')}
      </section>` : ''}
    ${upcoming.length ? `
      <section class="card">
        <h3 class="section-title">Ближайшие уроки</h3>
        ${upcoming.map((l) => `<button class="list-row" data-act="lesson-open" data-id="${l.id}" data-push="1"><span>${cap(relDay(l.date, today()))}, ${l.start}</span><span class="muted">${l.duration} мин · ${formatRub(lessonPrice(l, s))}</span></button>`).join('')}
      </section>` : ''}
    <section class="card">
      <h3 class="section-title">История</h3>
      ${shown.length ? shown.map((h) => (h.kind === 'p'
        ? `<button class="list-row" data-act="pay-open" data-id="${h.p.id}" data-push="1"><span>💰 Оплата<span class="sub block">${dayTitle(h.p.date)}${h.p.note ? ` · ${esc(h.p.note)}` : ''}</span></span><b class="good-t">+${formatRub(h.p.amount)}</b></button>`
        : (() => {
          const ls = statusOf(h.l, n);
          return `<button class="list-row ${ls === 'cancelled' ? 'dimmed' : ''}" data-act="lesson-open" data-id="${h.l.id}" data-push="1"><span>${{ done: '✓', missed: '✗', cancelled: '–' }[ls]} ${STATUS_LABEL[ls]}<span class="sub block">${dayTitle(h.l.date)}, ${h.l.start}</span></span><span class="${isCharged(ls) ? '' : 'muted'}">${isCharged(ls) ? '−' : ''}${formatRub(lessonPrice(h.l, s))}</span></button>`;
        })())).join('') : '<div class="muted small">Пока пусто</div>'}
      ${!sh.all && history.length > 15 ? `<button class="btn ghost" data-act="history-all">Показать всё (${history.length})</button>` : ''}
    </section>
    ${mediaBlock({ studentId: s.id })}
    ${s.note ? `<section class="card"><h3 class="section-title">Заметки</h3><p class="pre">${esc(s.note)}</p></section>` : ''}`;
}

/* Ученик: редактирование */
function studentEditSheet(sh) {
  const d = sh.draft;
  return `
    ${head(sh.isNew ? 'Новый ученик' : 'Изменить ученика')}
    <label class="field">Имя<input class="input" value="${esc(d.name)}" data-field="name" placeholder="Маша" autocomplete="off"></label>
    <label class="field">Другие имена для голоса<input class="input" value="${esc(d.aliases)}" data-field="aliases" placeholder="Мария, Маруся, Иванова"></label>
    ${sheets().length > 1 ? `<div class="field">Лист<div class="seg">${sheets().map((x) => `<button class="${d.sheet === x.id ? 'on' : ''}" data-act="draft-sheet" data-id="${x.id}">${esc(x.name)}</button>`).join('')}</div></div>` : ''}
    <label class="toggle"><input type="checkbox" data-field="busy" ${d.kind === 'busy' ? 'checked' : ''}><span>Не урок — школа, встречи (в деньгах не считать)</span></label>
    <div class="two">
      <label class="field" ${d.kind === 'busy' ? 'hidden' : ''}>Цена урока, ₽<input class="input" inputmode="numeric" value="${d.price}" data-field="price"></label>
      <label class="field">Длительность, мин<input class="input" inputmode="numeric" value="${d.duration}" data-field="duration"></label>
    </div>
    ${!sh.isNew && Number(d.price) !== sh.oldPrice ? `<label class="field">Новая цена действует с<input class="input" type="date" value="${d.priceFrom}" data-field="priceFrom"><span class="note">Уроки до этой даты остаются по ${formatRub(sh.oldPrice)}</span></label>` : ''}
    <div class="field">Цвет<div class="colors">${COLORS.map((c) => `<button class="${d.color === c ? 'on' : ''}" style="background:${c}" data-act="color" data-v="${c}" aria-label="Цвет"></button>`).join('')}</div></div>
    <label class="field">Заметки, контакты<textarea class="input area" data-field="note" placeholder="Телефон родителя, цели, учебник…">${esc(d.note)}</textarea></label>
    ${!sh.isNew && sh.priceHistory.length > 1 ? `<details><summary>История цен</summary>${sh.priceHistory.map((p) => `<div>${p.from === '2000-01-01' ? 'сначала' : `с ${dayTitle(p.from)}`}: ${formatRub(p.price)}</div>`).join('')}</details>` : ''}
    <button class="btn primary" data-act="student-save">${sh.isNew ? 'Добавить' : 'Сохранить'}</button>
    ${sh.isNew ? '' : `<div class="row-btns"><button class="btn" data-act="student-archive">${d.archived ? 'Вернуть из архива' : 'В архив'}</button><button class="btn danger" data-act="student-del">Удалить</button></div>`}`;
}

function openStudentEdit(id, push) {
  const s = id ? stById(id) : null;
  const t = today();
  openSheet({
    type: 'studentEdit', isNew: !s, full: true,
    oldPrice: s ? priceAt(s, t) : null,
    priceHistory: s?.prices || [],
    draft: s
      ? { id: s.id, kind: s.kind || 'student', sheet: sheetOf(s), name: s.name, aliases: s.aliases || '', price: priceAt(s, t), duration: s.duration, color: s.color, note: s.note || '', archived: s.archived, priceFrom: t }
      : { id: uid(), kind: 'student', sheet: defaultSheet(), name: '', aliases: '', price: S.settings.price, duration: S.settings.duration, color: nextColor(S.students), note: '', archived: false, priceFrom: t },
  }, { push });
}

async function saveStudent() {
  const sh = S.sheet;
  const d = sh.draft;
  const name = d.name.trim();
  if (!name) return toast('Введите имя');
  const price = parseRub(d.price);
  const duration = Number(d.duration);
  if (price === null) return toast('Проверьте цену');
  if (!(duration >= 10 && duration <= 300)) return toast('Длительность от 10 до 300 минут');
  let s = stById(d.id);
  if (!s) {
    s = { id: d.id, kind: d.kind, sheet: d.sheet, name, aliases: d.aliases.trim(), color: d.color, duration, prices: [{ from: '2000-01-01', price }], note: d.note, archived: false, createdAt: Date.now() };
  } else {
    s = { ...s, kind: d.kind, sheet: d.sheet, name, aliases: d.aliases.trim(), color: d.color, duration, note: d.note };
    if (price !== sh.oldPrice) s = withPrice(s, price, d.priceFrom || today());
  }
  closeSheet();
  // Пришли из нового урока — подставим ученика туда.
  if (S.sheet?.type === 'lesson' && sh.isNew) {
    S.sheet.draft.studentId = s.id;
    S.sheet.draft.duration = s.duration;
  }
  await commit([{ put: ['students', s] }], sh.isNew ? `${name} добавлен(а)` : 'Сохранено');
}

/* Оплата */
function paymentSheet(sh) {
  const d = sh.draft;
  const stu = stById(d.studentId);
  const price = stu ? priceAt(stu, today()) : 0;
  const st = stu ? studentStats(stu, S.lessons, S.payments.filter((p) => p.id !== d.id), now()) : null;
  return `
    ${head(sh.isNew ? 'Оплата' : 'Изменить оплату')}
    <label class="field">Ученик<select class="input" data-field="studentId">${studentOptions(d.studentId).replace('<option value="__new">+ Новый ученик…</option>', '')}</select></label>
    ${st ? `<p class="note">Сейчас: ${balanceText(st)}</p>` : ''}
    <input class="input amount" inputmode="numeric" placeholder="0 ₽" value="${d.amount}" data-field="amount" aria-label="Сумма">
    ${price ? `<div class="chips">${[1, 4, 8].map((k) => `<button class="chip" data-act="pay-k" data-k="${k}">${lessonsWord(k)}<span class="muted">${formatRub(k * price)}</span></button>`).join('')}${st && st.balance < 0 ? `<button class="chip" data-act="pay-debt">Весь долг<span class="muted">${formatRub(-st.balance)}</span></button>` : ''}</div>` : ''}
    <div class="two">
      <label class="field">Дата<input class="input" type="date" value="${d.date}" data-field="date"></label>
      <label class="field">Заметка<input class="input" value="${esc(d.note)}" data-field="note" placeholder="Перевод, наличные…"></label>
    </div>
    <button class="btn primary" data-act="pay-save" ${d.studentId ? '' : 'disabled'}>Сохранить</button>
    ${sh.isNew ? '' : '<button class="btn danger" data-act="pay-del">Удалить оплату</button>'}`;
}

async function savePayment() {
  const sh = S.sheet;
  const d = sh.draft;
  const amount = parseRub(d.amount);
  if (!d.studentId) return toast('Выберите ученика');
  if (!amount) return toast('Введите сумму');
  const p = { id: d.id, studentId: d.studentId, date: d.date || today(), amount, note: d.note.trim(), createdAt: d.createdAt || Date.now() };
  closeSheet();
  await commit([{ put: ['payments', p] }], `Оплата ${formatRub(amount)}`);
}

/* Расписание (регулярные уроки) */
function seriesSheet(sh) {
  const d = sh.draft;
  const stu = stById(d.studentId);
  return `
    ${head(`Расписание: ${esc(stu?.name || '')}`)}
    <p class="muted small">Уроки создаются на 10 недель вперёд и дальше добавляются сами. Любой урок можно потом перенести отдельно.</p>
    <div class="field">Дни недели<div class="days">${WD_SHORT.map((w, i) => `<button class="${d.days.includes(i) ? 'on' : ''}" data-act="sday" data-v="${i}">${w}</button>`).join('')}</div></div>
    <div class="two">
      <label class="field">Начало<input class="input" type="time" value="${d.start}" step="300" data-field="start"></label>
      <label class="field">Длительность, мин<input class="input" inputmode="numeric" value="${d.duration}" data-field="duration"></label>
    </div>
    <label class="field">Начиная с<input class="input" type="date" value="${d.from}" data-field="from"></label>
    <button class="btn primary" data-act="series-save" ${d.days.length ? '' : 'disabled'}>Создать уроки</button>`;
}

async function saveSeries() {
  const d = S.sheet.draft;
  const duration = Number(d.duration);
  if (!d.days.length || !d.start || !(duration >= 10)) return toast('Выберите дни и время');
  const series = { id: uid(), studentId: d.studentId, days: [...d.days].sort(), start: d.start, duration, from: d.from || today(), until: null, generatedUntil: null };
  const ext = extendSeries(series, today());
  const n = now();
  // Дата начала в прошлом — дозаполняем историю; иначе не создаём уже прошедший сегодня урок.
  const lessons = ext.lessons.filter((l) => lessonStart(l) > n || series.from < today());
  closeSheet();
  await commit([{ put: ['series', ext.series] }, ...lessons.map((l) => ({ put: ['lessons', l] }))], `Расписание: ${lessonsWord(lessons.length)}`);
}

async function stopSeries(id) {
  const ser = S.series.find((x) => x.id === id);
  if (!ser) return;
  const n = now();
  const future = S.lessons.filter((l) => l.seriesId === id && statusOf(l, n) === 'planned' && lessonStart(l) > n);
  if (!confirm(`Остановить расписание «${seriesText(ser)}»? Удалю ${lessonsWord(future.length)} впереди.`)) return;
  await commit([{ put: ['series', { ...ser, until: today() }] }, ...future.map((l) => ({ del: ['lessons', l.id] }))], 'Расписание остановлено');
}

/* Голос */
function voiceSheet(sh) {
  const r = sh.result;
  const can = speechSupported() && !sh.speechFailed;
  let res = '';
  if (r?.kind === 'action') {
    res = `
      <section class="card vres">
        <h3>${esc(r.title)}</h3>
        ${r.lines.map((l) => `<p>${esc(l)}</p>`).join('')}
        ${r.newStudent ? `<label class="field mt">Новый ученик — проверьте имя<input class="input" value="${esc(r.newStudent.name)}" data-vname></label>` : ''}
        ${r.warn?.length ? `<div class="warn-box">${r.warn.map(esc).join('<br>')}</div>` : ''}
        <div class="row-btns mt"><button class="btn ghost" data-act="voice-clear">Не то</button><button class="btn primary" data-act="voice-apply">Применить</button></div>
      </section>`;
  } else if (r?.kind === 'answer') {
    res = `<section class="card vres"><p class="answer">${esc(r.text)}</p>${r.nav ? '<button class="btn mt" data-act="voice-nav">Показать</button>' : ''}</section>`;
  } else if (r?.kind === 'error') {
    res = `<section class="card vres err"><p>${esc(r.text)}</p></section>`;
  }
  return `
    ${head('Голосовая команда')}
    ${can ? `
      <button class="mic ${sh.listening ? 'on' : ''}" data-act="${sh.listening ? 'mic-stop' : 'mic'}" aria-label="${sh.listening ? 'Остановить' : 'Говорить'}">
        <span>🎤</span>
      </button>
      <p class="center muted small">${sh.listening ? 'Слушаю… говорите' : 'Нажмите и скажите команду'}</p>` : `
      <p class="muted small">${sh.speechFailed ? `Встроенное распознавание недоступно (${esc(sh.speechFailed)}). ` : ''}Нажмите в поле и используйте 🎤 на клавиатуре iPhone — диктовка работает и без интернета.</p>`}
    <div class="vinput">
      <textarea class="input area" rows="2" placeholder="Например: перенеси Машу с четверга на пятницу в 17" data-vtext>${esc(sh.text)}</textarea>
      <button class="btn primary" data-act="voice-run">Разобрать</button>
    </div>
    ${sh.ocr ? ocrProgress(sh.ocr) : `<label class="btn">📷 Из скриншота или фото<input type="file" accept="image/*" multiple data-change="ocr-voice"></label>`}
    ${batchView(sh)}
    ${res}
    ${r || sh.batch || sh.ocr ? '' : `<div class="field">Примеры — можно нажать<div class="ex-chips">${EXAMPLES.slice(0, 8).map((e) => `<button class="ex" data-act="voice-ex" data-t="${esc(e)}">${esc(e)}</button>`).join('')}</div></div>`}`;
}

function voiceCtx() {
  return { students: S.students, lessons: S.lessons, payments: S.payments, series: S.series, settings: S.settings, now: now() };
}

function runVoice(text) {
  const sh = S.sheet;
  if (!sh || sh.type !== 'voice') return;
  sh.text = text;
  sh.batch = null;
  sh.result = null;
  // Длинный текст (переписка, скриншот) — ищем в нём несколько команд.
  if (/\n/.test(text.trim()) || text.length > 140) {
    const { items } = findCommands(text, voiceCtx());
    sh.batch = items.map((x) => ({ ...x, on: x.result.kind === 'action' }));
  } else if (text.trim()) sh.result = interpret(text, voiceCtx());
  renderSheet();
}

function ocrProgress(o) {
  return `<div class="card"><p class="small">${esc(o.label)}</p><div class="progress mt"><i style="width:${Math.round(o.p * 100)}%"></i></div>
    ${o.first ? '<p class="note">Первый раз загружается модуль распознавания (~10 МБ), дальше работает без интернета.</p>' : ''}</div>`;
}

function batchView(sh) {
  if (!sh.batch) return '';
  if (!sh.batch.length) {
    return `<section class="card vres err"><p>${sh.text ? 'Уроков и команд в тексте не нашёл.' : 'Текста на картинке не нашёл.'}</p>
      <p class="small mt">Подходят скриншоты календаря (видны время и имя ученика) и переписки («перенесём на 18», «перевела 3000»). Распознанный текст — в поле выше: можно поправить и нажать «Разобрать».</p></section>`;
  }
  const n = sh.batch.filter((b) => b.on && b.result.kind === 'action').length;
  const acts = sh.batch.filter((b) => b.result.kind === 'action');
  const known = acts.filter((b) => b.exists).length;
  const fresh = acts.length - known;
  const allOn = acts.length && acts.every((b) => b.on);
  const dates = (sh.dates || []).map((d, i) => (d ? `
    <label class="field">${sh.dates.filter(Boolean).length > 1 ? `Дата на картинке ${i + 1}` : 'Дата на картинке'} — проверьте
      <input class="input" type="date" value="${d}" data-change="sched-date" data-page="${i}"></label>` : '')).join('');
  return `
    <h3 class="section-title mt">Нашёл: ${[fresh ? `новое — ${fresh}` : '', known ? `уже есть — ${known}` : ''].filter(Boolean).join(', ') || 'только ответы'}</h3>
    ${dates}
    ${acts.length > 1 ? `<button class="btn" data-act="batch-all">${allOn ? 'Снять все' : `Выбрать все (${acts.length})`}</button>` : ''}
    ${sh.batch.map((b, i) => ({ b, i })).map(({ b, i }) => (b.result.kind === 'answer'
    ? `<section class="card vres"><p class="sub">«${esc(b.text)}»</p><p class="answer">${esc(b.result.text)}</p></section>`
    : `<label class="card vres pick ${b.on ? '' : 'off'}"><input type="checkbox" data-bi="${i}" ${b.on ? 'checked' : ''}>
        <span><p class="sub">«${esc(b.text)}»</p><h3>${esc(b.result.title)}</h3>${b.result.lines.map((l) => `<p>${esc(l)}</p>`).join('')}
        ${b.result.warn?.length ? `<div class="warn-box mt">${b.result.warn.map(esc).join('<br>')}</div>` : ''}</span></label>`)).join('')}
    ${n ? `<button class="btn primary" data-act="batch-apply">Применить (${n})</button>` : '<p class="note">Отметьте галочкой, что добавить, или «Выбрать все».</p>'}`;
}

async function applyBatch() {
  const sh = S.sheet;
  const picked = sh.batch.filter((b) => b.on && b.result.kind === 'action');
  if (!picked.length) return;
  // Если две команды меняют один урок — в итоге остаётся последняя.
  const ops = picked.flatMap((b) => b.result.ops);
  const nav = picked.find((b) => b.result.nav?.date)?.result.nav;
  closeSheet();
  if (nav) { S.tab = 'cal'; go(nav.date); }
  await commit(ops, picked.length === 1 ? picked[0].result.title : `Применено: ${picked.length}`);
}

/** Распознать текст на картинках; onState получает {label, p 0..1, first}. */
let ocrUsed = false;
async function ocrText(files, onState) {
  const parts = [];
  const pages = [];
  for (let i = 0; i < files.length; i++) {
    const label = files.length > 1 ? `Распознаю текст: картинка ${i + 1} из ${files.length}` : 'Распознаю текст…';
    onState({ label, p: 0, first: !ocrUsed });
    const { text, lines } = await recognize(files[i], (p) => onState({ label, p, first: false }, true));
    ocrUsed = true;
    parts.push(text.trim());
    pages.push(lines.map((l) => ({ text: l.text, box: l.box })));
  }
  return { text: parts.join('\n\n'), pages };
}

/** Уроки со скриншотов календаря + команды из переписки — одним списком с галочками. */
function showFound(sh, text, pages) {
  sh.text = text;
  sh.result = null;
  sh.pages = pages;
  sh.pageDates = sh.pageDates || [];
  const ctx = voiceCtx();
  const found = pages.map((lines, i) => findSchedule(lines, ctx, S.date, sh.pageDates[i]));
  // Дату показываем, только если на картинке нашлись уроки, — её можно поправить.
  sh.dates = found.map((f) => (f.items.length ? f.date : null));
  const sched = found.flatMap((f) => f.items);
  const cmds = findCommands(text, ctx).items.filter((x) => x.result.kind === 'action');
  // Если на картинке расписание, ответы-вопросы из текста не нужны.
  sh.batch = [...sched, ...(sched.length ? cmds : findCommands(text, ctx).items)].map((x) => ({ ...x, on: x.on ?? x.result.kind === 'action' }));
  renderSheet();
}

function ocrState(sh) {
  return (o, quick) => {
    sh.ocr = o;
    const bar = $('.sheet .progress i');
    if (quick && bar) bar.style.width = `${Math.round(o.p * 100)}%`;
    else if (S.sheet === sh) renderSheet();
  };
}

async function ocrToVoice(files) {
  const sh = S.sheet;
  sh.result = null;
  sh.batch = null;
  try {
    const { text, pages } = await ocrText(files, ocrState(sh));
    sh.ocr = null;
    if (S.sheet !== sh) return;
    if (!text.trim()) { sh.text = ''; sh.batch = []; renderSheet(); return; }
    showFound(sh, text, pages);
  } catch (e) {
    sh.ocr = null;
    renderSheet();
    alert(`Не получилось распознать: ${e.message}`);
  }
}

/* ---------- Фото и файлы ---------- */

function mediaBlock({ studentId, lessonId = null }) {
  const items = S.media.filter((m) => (lessonId ? m.lessonId === lessonId : m.studentId === studentId)).sort((a, b) => b.createdAt - a.createdAt);
  return `
    <section class="card">
      <h3 class="section-title">Фото и файлы${items.length ? ` · ${items.length}` : ''}</h3>
      ${items.length ? `<div class="media-grid">${items.map((m) => `
        <button class="mthumb" data-act="media-open" data-id="${m.id}" aria-label="${esc(m.name)}">
          ${media.isImage(m) ? `<img src="${media.urlOf(m)}" alt="" loading="lazy">` : `<span class="mi">${media.kindIcon(m)}</span><span class="mn">${esc(m.name)}</span>`}
          ${m.text ? '<b class="mt-badge">Аа</b>' : ''}
        </button>`).join('')}</div>` : '<p class="muted small">Домашка, фото тетради, PDF — хранятся на телефоне. С картинок можно распознать текст.</p>'}
      <label class="btn mt">+ Добавить<input type="file" multiple data-change="media-add" data-student="${studentId || ''}" data-lesson="${lessonId || ''}"></label>
    </section>`;
}

function mediaSheet(sh) {
  const m = S.media.find((x) => x.id === sh.id);
  if (!m) return `${head('Файл')}<div class="empty">Файл удалён</div>`;
  const stu = stById(m.studentId);
  const les = m.lessonId ? S.lessons.find((l) => l.id === m.lessonId) : null;
  const url = media.urlOf(m);
  const view = media.isImage(m) ? `<img class="mview" src="${url}" alt="${esc(m.name)}">`
    : /^video\//.test(m.type) ? `<video class="mview" src="${url}" controls playsinline></video>`
      : /^audio\//.test(m.type) ? `<audio src="${url}" controls></audio>`
        : `<a class="btn" href="${url}" target="_blank" rel="noopener">Открыть ${esc(m.name)}</a>`;
  return `
    ${head(esc(m.name))}
    ${view}
    <p class="note">${media.sizeText(m.size)} · ${new Date(m.createdAt).toLocaleDateString('ru-RU')}${stu ? ` · ${esc(stu.name)}` : ''}${les ? `, урок ${dayTitle(les.date)} ${les.start}` : ''}</p>
    ${sh.ocr ? ocrProgress(sh.ocr) : ''}
    ${media.isImage(m) && !m.text && !sh.ocr ? '<button class="btn primary" data-act="media-ocr">Распознать текст</button>' : ''}
    ${m.text ? `
      <label class="field">Текст с картинки (можно поправить)<textarea class="input area tall" data-mtext>${esc(m.text)}</textarea></label>
      <div class="row-btns">
        <button class="btn primary" data-act="media-cmd">Найти команды</button>
        <button class="btn" data-act="media-copy">Копировать</button>
      </div>
      <button class="btn" data-act="media-note">Добавить в заметку ${les ? 'урока' : 'ученика'}</button>` : ''}
    <div class="row-btns">
      <button class="btn" data-act="media-share">Поделиться</button>
      <button class="btn danger" data-act="media-del">Удалить</button>
    </div>`;
}

async function addMedia(files, studentId, lessonId) {
  const items = [];
  for (const f of files) {
    if (f.size > 200e6) { toast(`${f.name}: больше 200 МБ, пропускаю`); continue; }
    items.push(await media.fromFile(f, { studentId: studentId || null, lessonId: lessonId || null }));
  }
  if (!items.length) return;
  await commit(items.map((m) => ({ put: ['media', m] })), items.length === 1 ? 'Файл добавлен' : `Добавлено файлов: ${items.length}`);
}

async function ocrMedia() {
  const sh = S.sheet;
  const m = S.media.find((x) => x.id === sh.id);
  try {
    const { text, pages } = await ocrText([m.blob], ocrState(sh));
    sh.ocr = null;
    await commit([{ put: ['media', { ...m, text: text.trim() || '(текст не найден)', lines: pages[0] || [] }] }]);
  } catch (e) {
    sh.ocr = null;
    renderSheet();
    alert(`Не получилось распознать: ${e.message}`);
  }
}

function startMic() {
  const sh = S.sheet;
  try {
    sh.rec = listen({
      onText: (t) => {
        sh.text = t;
        const ta = $('[data-vtext]');
        if (ta) ta.value = t;
      },
      onEnd: (t) => {
        sh.listening = false;
        sh.rec = null;
        if (S.sheet !== sh) return;
        if (t) runVoice(t); else renderSheet();
      },
      onError: (e) => {
        sh.listening = false;
        if (e === 'no-speech' || e === 'aborted') return;
        sh.speechFailed = e;
        renderSheet();
        setTimeout(() => $('[data-vtext]')?.focus(), 50);
      },
    });
    sh.listening = true;
    sh.result = null;
    sh.text = '';
  } catch (e) {
    sh.speechFailed = e.message || 'ошибка';
  }
  renderSheet();
}

async function applyVoice() {
  const sh = S.sheet;
  const r = sh.result;
  if (r?.kind !== 'action') return;
  const nameInput = $('[data-vname]');
  if (r.newStudent && nameInput) {
    const name = nameInput.value.trim();
    if (!name) return toast('Введите имя ученика');
    r.newStudent.name = name;
  }
  closeSheet();
  if (r.nav?.date) { S.tab = 'cal'; go(r.nav.date); }
  await commit(r.ops, r.title);
}

/* ---------- Резервная копия ---------- */

async function exportBackup() {
  const withMedia = S.media.length && confirm(`Включить в копию фото и файлы (${media.sizeText(S.media.reduce((a, m) => a + m.size, 0))})? «Отмена» — только расписание и оплаты.`);
  const mediaData = withMedia ? await Promise.all(S.media.map(async ({ blob, ...m }) => ({ ...m, data: await media.toDataURL(blob) }))) : [];
  const data = { app: 'lessons', version: 2, exportedAt: new Date().toISOString(), students: S.students, lessons: S.lessons, payments: S.payments, series: S.series, media: mediaData, settings: S.settings };
  const name = `uroki-${today()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  let saved = true;
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (e) {
      if (e.name === 'AbortError') saved = false;
      else throw e;
    }
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  if (saved) {
    S.lastBackup = Date.now();
    await db.setMeta('lastBackup', S.lastBackup);
    render();
    toast('Копия готова');
  }
}

async function restoreBackup(file) {
  try {
    const data = validateBackup(JSON.parse(await file.text()));
    const msg = `Заменить все данные копией от ${new Date(data.exportedAt).toLocaleDateString('ru-RU')}? Учеников: ${data.students.length}, уроков: ${data.lessons.length}.`;
    if (!confirm(msg)) return;
    data.media = await Promise.all((data.media || []).map(async ({ data: url, ...m }) => ({ ...m, blob: await media.fromDataURL(url) })));
    for (const m of S.media) media.forget(m.id);
    await db.replaceAll(data);
    await loadAll();
    await extendAllSeries();
    render();
    toast('Данные восстановлены');
  } catch (e) {
    alert(`Не получилось: ${e.message}`);
  }
}

/* ---------- События ---------- */

const ACTIONS = {
  tab: (b) => { if (S.tab !== b.dataset.tab) S.anim = 'tab'; S.tab = b.dataset.tab; if (S.tab === 'cal') S.scrollToNow = true; $('#view').scrollTop = 0; render(); },
  close: () => closeSheet(),
  overlay: (b, e) => { if (e.target === b) closeSheet(); },
  undo: () => undo(),
  'cal-mode': (b) => { if (S.calMode !== b.dataset.mode) S.anim = 'fade'; S.calMode = b.dataset.mode; saveView(); render(); },
  'open-day': (b) => { S.anim = 'fade'; S.calMode = 'day'; go(b.dataset.date); saveView(); render(); },
  shift: (b) => { go(addDays(S.date, Number(b.dataset.d) * calDays().length)); render(); },
  zoom: (b) => setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, nearestZoom(S.zoom) + Number(b.dataset.d)))]),
  'sheets-open': () => openSheet({ type: 'sheets' }),
  'lessons-wipe': () => wipeLessons(),
  'hard-reload': () => globalThis.__hardReload?.(),
  'sheet-color': async (b) => {
    const x = sheetById(b.dataset.id);
    const used = sheets().filter((y) => y.id !== x.id).map((y) => y.color);
    const from = COLORS.indexOf(x.color);
    const c = [...COLORS.slice(from + 1), ...COLORS.slice(0, from + 1)].find((k) => !used.includes(k)) || x.color;
    await saveSheets(sheets().map((y) => (y.id === x.id ? { ...y, color: c } : y)));
  },
  'sheet-all': () => { S.shown = null; S.anim = 'fade'; saveView(); render(); },
  'sheet-tap': (b) => {
    const id = b.dataset.id;
    let ids = shownIds();
    if (ids.includes(id)) {
      if (ids.length === 1) { toast('Хотя бы один лист должен быть включён'); return; }
      ids = ids.filter((x) => x !== id);
    } else ids = [...ids, id];
    S.shown = ids.length === sheets().length ? null : ids;
    S.anim = 'fade';
    saveView();
    render();
  },
  'draft-sheet': (b) => { S.sheet.draft.sheet = b.dataset.id; renderSheet(); },
  'sheet-add': async () => {
    const name = (prompt('Название листа', 'Новый лист') || '').trim();
    if (!name) return;
    const used = sheets().map((x) => x.color);
    const color = COLORS.find((c) => !used.includes(c)) || COLORS[sheets().length % COLORS.length];
    const id = uid();
    await saveSheets([...sheets(), { id, name, color }]);
    toast(`Лист «${name}» добавлен. Учеников на него — в их карточке`);
  },
  'sheet-del': async (b) => {
    const x = sheetById(b.dataset.id);
    const rest = sheets().filter((y) => y.id !== x.id);
    const mine = S.students.filter((s) => sheetOf(s) === x.id);
    if (!confirm(`Удалить лист «${x.name}»?${mine.length ? ` Ученики (${mine.length}) и их уроки перейдут на лист «${rest[0].name}».` : ''}`)) return;
    if (mine.length) await commit(mine.map((s) => ({ put: ['students', { ...s, sheet: rest[0].id }] })));
    S.shown = S.shown?.filter((id) => id !== x.id) || null;
    saveView();
    await saveSheets(rest);
  },
  goto: (b) => { if (b.classList.contains('pill')) S.scrollToNow = true; go(b.dataset.date); if (S.calMode === 'month' && b.closest('.week')) S.calMode = 'day'; render(); },
  pick: (b) => {
    if (S.date === b.dataset.date) { S.calMode = 'day'; go(b.dataset.date); } else S.date = b.dataset.date;
    render();
  },
  month: (b) => { S.anim = Number(b.dataset.d) > 0 ? 'next' : 'prev'; S.date = `${shiftMonth(monthKey(S.date), Number(b.dataset.d))}-01`; render(); },
  'money-month': (b) => { S.moneyMonth = shiftMonth(S.moneyMonth, Number(b.dataset.d)); render(); },
  slot: (b) => openSheet({ type: 'lesson', isNew: true, draft: newLessonDraft(b.dataset.date || S.date, `${pad(Number(b.dataset.h))}:00`, lastStudent()) }),
  'lesson-new': (b) => {
    const sid = b.dataset.student || '';
    const t = S.date === today() ? fromMin(Math.min(23 * 60, Math.ceil((nowMin(now()) + 1) / 60) * 60)) : `${pad(Math.max(S.settings.dayStart, 15))}:00`;
    openSheet({ type: 'lesson', isNew: true, draft: newLessonDraft(sid ? (S.date < today() ? today() : S.date) : S.date, t, sid || lastStudent()) }, { push: Boolean(b.dataset.push) });
  },
  'lesson-open': (b) => {
    const l = S.lessons.find((x) => x.id === b.dataset.id);
    if (l) openSheet({ type: 'lesson', isNew: false, draft: structuredClone(l) }, { push: Boolean(b.dataset.push) });
  },
  dur: (b) => { S.sheet.draft.duration = Number(b.dataset.v); renderSheet(); },
  lstatus: (b) => { S.sheet.draft.status = b.dataset.v === 'done' ? 'done' : b.dataset.v; renderSheet(); },
  'lesson-save': () => saveLesson(),
  'lesson-del': async () => {
    const d = S.sheet.draft;
    closeSheet();
    const files = S.media.filter((m) => m.lessonId === d.id).map((m) => ({ put: ['media', { ...m, lessonId: null }] }));
    await commit([{ del: ['lessons', d.id] }, ...files], files.length ? 'Урок удалён, файлы остались у ученика' : 'Урок удалён');
  },
  'student-new': (b) => openStudentEdit(null, Boolean(b.dataset.push)),
  'student-open': (b) => openSheet({ type: 'student', id: b.dataset.id, full: true }, { push: Boolean(b.dataset.push) }),
  'student-edit': (b) => openStudentEdit(b.dataset.id, true),
  'student-save': () => saveStudent(),
  'student-archive': async () => {
    const s = stById(S.sheet.draft.id);
    S.sheetStack = [];
    S.sheet = null;
    await commit([{ put: ['students', { ...s, archived: !s.archived }] }], s.archived ? 'Вернул из архива' : 'В архиве');
  },
  'student-del': async () => {
    const s = stById(S.sheet.draft.id);
    const ls = S.lessons.filter((l) => l.studentId === s.id);
    const ps = S.payments.filter((p) => p.studentId === s.id);
    if (!confirm(`Удалить ${s.name} вместе с ${lessonsWord(ls.length)} и ${ps.length} ${plural(ps.length, 'оплатой', 'оплатами', 'оплатами')}? Если ученик просто закончил — лучше «В архив».`)) return;
    S.sheetStack = [];
    S.sheet = null;
    await commit([
      { del: ['students', s.id] },
      ...ls.map((l) => ({ del: ['lessons', l.id] })),
      ...ps.map((p) => ({ del: ['payments', p.id] })),
      ...S.series.filter((x) => x.studentId === s.id).map((x) => ({ del: ['series', x.id] })),
      ...S.media.filter((m) => m.studentId === s.id).map((m) => ({ del: ['media', m.id] })),
    ], `${s.name} удалён(а)`);
  },
  color: (b) => { S.sheet.draft.color = b.dataset.v; renderSheet(); },
  'toggle-archived': () => { S.showArchived = !S.showArchived; render(); },
  'history-all': () => { S.sheet.all = true; renderSheet(); },
  'pay-new': (b) => openSheet({ type: 'payment', isNew: true, draft: { id: uid(), studentId: b.dataset.student || '', amount: '', date: today(), note: '' } }, { push: Boolean(b.dataset.push) }),
  'pay-open': (b) => {
    const p = S.payments.find((x) => x.id === b.dataset.id);
    if (p) openSheet({ type: 'payment', isNew: false, draft: { ...p, amount: String(p.amount) } }, { push: Boolean(b.dataset.push) });
  },
  'pay-k': (b) => {
    const d = S.sheet.draft;
    const k = Number(b.dataset.k);
    d.amount = String(k * priceAt(stById(d.studentId), today()));
    d.note = `за ${lessonsWord(k)}`;
    renderSheet();
  },
  'pay-debt': () => {
    const d = S.sheet.draft;
    const st = studentStats(stById(d.studentId), S.lessons, S.payments.filter((p) => p.id !== d.id), now());
    d.amount = String(-st.balance);
    renderSheet();
  },
  'pay-save': () => savePayment(),
  'pay-del': async () => {
    const d = S.sheet.draft;
    closeSheet();
    await commit([{ del: ['payments', d.id] }], 'Оплата удалена');
  },
  'series-new': (b) => {
    const s = stById(b.dataset.student);
    openSheet({ type: 'series', draft: { studentId: s.id, days: [], start: '16:00', duration: s.duration, from: today() } }, { push: true });
  },
  sday: (b) => {
    const d = S.sheet.draft;
    const v = Number(b.dataset.v);
    d.days = d.days.includes(v) ? d.days.filter((x) => x !== v) : [...d.days, v];
    renderSheet();
  },
  'series-save': () => saveSeries(),
  'series-stop': (b) => stopSeries(b.dataset.id),
  export: () => exportBackup().catch((e) => alert(e.message)),
  voice: () => {
    openSheet({ type: 'voice', text: '', result: null, listening: false });
  },
  mic: () => startMic(),
  'mic-stop': () => { try { S.sheet.rec?.stop(); } catch { /* уже остановлено */ } },
  'voice-run': () => runVoice($('[data-vtext]')?.value || ''),
  'voice-ex': (b) => runVoice(b.dataset.t),
  'voice-clear': () => { S.sheet.result = null; S.sheet.text = ''; renderSheet(); setTimeout(() => $('[data-vtext]')?.focus(), 30); },
  'voice-apply': () => applyVoice(),
  'batch-apply': () => applyBatch(),
  'batch-all': () => {
    const acts = S.sheet.batch.filter((b) => b.result.kind === 'action');
    const on = !acts.every((b) => b.on);
    acts.forEach((b) => { b.on = on; });
    renderSheet();
  },
  'media-open': (b) => openSheet({ type: 'media', id: b.dataset.id, full: true }, { push: true }),
  'media-ocr': () => ocrMedia(),
  'media-cmd': () => {
    const m = S.media.find((x) => x.id === S.sheet.id);
    const text = $('[data-mtext]')?.value || '';
    openSheet({ type: 'voice', text, result: null, listening: false }, { push: true });
    // Если текст не правили — используем и положение строк (для скриншотов календаря).
    showFound(S.sheet, text, m?.lines && text === m.text ? [m.lines] : [text.split('\n')]);
  },
  'media-copy': async () => {
    try { await navigator.clipboard.writeText($('[data-mtext]')?.value || ''); toast('Скопировано'); } catch { toast('Не получилось скопировать'); }
  },
  'media-note': async () => {
    const m = S.media.find((x) => x.id === S.sheet.id);
    const text = ($('[data-mtext]')?.value || '').trim();
    const les = m.lessonId && S.lessons.find((l) => l.id === m.lessonId);
    const target = les || stById(m.studentId);
    if (!target) return;
    const note = [target.note, text].filter(Boolean).join('\n');
    await commit([{ put: [les ? 'lessons' : 'students', { ...target, note }] }], 'Добавлено в заметку');
  },
  'media-share': () => media.share(S.media.find((x) => x.id === S.sheet.id)),
  'media-del': async () => {
    const m = S.media.find((x) => x.id === S.sheet.id);
    if (!confirm(`Удалить «${m.name}»?`)) return;
    closeSheet();
    await commit([{ del: ['media', m.id] }], 'Файл удалён');
  },
  'voice-nav': () => {
    const r = S.sheet.result;
    closeSheet();
    if (r.nav.date) { S.tab = 'cal'; S.calMode = 'day'; go(r.nav.date); render(); }
    else if (r.nav.student) openSheet({ type: 'student', id: r.nav.student, full: true });
  },
};

/** Уроки показанных листов (если включены все — вообще все). */
const lessonsToWipe = () => S.lessons.filter((l) => visibleStudent(stById(l.studentId)));

async function wipeLessons() {
  const ls = lessonsToWipe();
  if (!ls.length) return;
  const name = allShown() ? '' : ` с листа «${shownIds().map((id) => sheetById(id).name).join('», «')}»`;
  if (!confirm(`Удалить ${lessonsWord(ls.length)}${name}? Регулярные расписания тоже удалятся, ученики и оплаты останутся. Сразу после удаления можно нажать «Вернуть».`)) return;
  const ids = new Set(ls.map((l) => l.id));
  const studentIds = new Set(ls.map((l) => l.studentId));
  const ops = [
    ...ls.map((l) => ({ del: ['lessons', l.id] })),
    // иначе регулярные уроки создадутся заново
    ...S.series.filter((x) => studentIds.has(x.studentId) && visibleStudent(stById(x.studentId))).map((x) => ({ del: ['series', x.id] })),
    ...S.media.filter((m) => ids.has(m.lessonId)).map((m) => ({ put: ['media', { ...m, lessonId: null }] })),
  ];
  await commit(ops, `Удалено: ${lessonsWord(ls.length)}`);
}

async function saveSheets(list) {
  S.settings = { ...S.settings, sheets: list };
  await db.setMeta('settings', S.settings);
  render();
}

const nearestZoom = (z) => ZOOMS.reduce((bi, v, i) => (Math.abs(v - z) < Math.abs(ZOOMS[bi] - z) ? i : bi), 0);
/** Меняем масштаб, сохраняя на месте то время, что было посередине экрана. */
function setZoom(z, { save = true } = {}) {
  const view = $('#view');
  const tl = $('.tl');
  const old = S.zoom;
  S.zoom = Math.round(Math.max(ZOOMS[0], Math.min(ZOOMS.at(-1), z)));
  if (tl) {
    const mid = view.scrollTop + view.clientHeight / 2 - tl.offsetTop;
    tl.style.setProperty('--hp', `${S.zoom}px`);
    view.scrollTop = tl.offsetTop + (mid * S.zoom) / old - view.clientHeight / 2;
  }
  if (save) { saveView(); render(); }
}

function lastStudent() {
  return activeStudents().length === 1 ? activeStudents()[0].id : '';
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const fn = ACTIONS[b.dataset.act];
  if (fn) {
    if (b.dataset.act !== 'overlay') e.preventDefault();
    Promise.resolve(fn(b, e)).catch((err) => { console.error(err); alert(`Ошибка: ${err.message}`); });
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.input === 'query') {
    S.query = t.value;
    const pos = t.selectionStart;
    render();
    const n = $('[data-input="query"]');
    n?.focus();
    n?.setSelectionRange(pos, pos);
    return;
  }
  if (t.dataset.field && S.sheet?.draft) {
    if (t.type === 'checkbox') return;
    S.sheet.draft[t.dataset.field] = t.dataset.field === 'price' && S.sheet.type === 'lesson' ? (t.value.trim() === '' ? null : parseRub(t.value)) : t.value;
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.change === 'restore' && t.files[0]) { await restoreBackup(t.files[0]); t.value = ''; return; }
  if (t.dataset.change === 'ocr-voice' && t.files.length) { const files = [...t.files]; t.value = ''; ocrToVoice(files); return; }
  if (t.dataset.change === 'media-add' && t.files.length) { const files = [...t.files]; t.value = ''; await addMedia(files, t.dataset.student, t.dataset.lesson); return; }
  if (t.dataset.change === 'sched-date' && S.sheet?.pages && t.value) {
    S.sheet.pageDates[Number(t.dataset.page)] = t.value;
    showFound(S.sheet, S.sheet.text, S.sheet.pages);
    return;
  }
  if (t.dataset.bi !== undefined && S.sheet?.batch) { S.sheet.batch[Number(t.dataset.bi)].on = t.checked; renderSheet(); return; }
  if (t.matches('[data-mtext]') && S.sheet?.type === 'media') {
    const m = S.media.find((x) => x.id === S.sheet.id);
    if (m && m.text !== t.value) await commit([{ put: ['media', { ...m, text: t.value }] }]);
    return;
  }
  if (t.dataset.sheetname) {
    const name = t.value.trim();
    if (name) await saveSheets(sheets().map((x) => (x.id === t.dataset.sheetname ? { ...x, name } : x)));
    return;
  }
  if (t.dataset.setting) {
    const k = t.dataset.setting;
    const v = Number(String(t.value).replace(/\s/g, ''));
    if (!Number.isFinite(v)) return;
    S.settings = { ...S.settings, [k]: v };
    if (S.settings.dayEnd <= S.settings.dayStart) S.settings.dayEnd = S.settings.dayStart + 1;
    await db.setMeta('settings', S.settings);
    toast('Сохранено');
    return;
  }
  if (!t.dataset.field || !S.sheet?.draft) return;
  const d = S.sheet.draft;
  if (t.dataset.field === 'repeat') { S.sheet.repeat = t.checked; renderSheet(); return; }
  if (t.dataset.field === 'busy') { d.kind = t.checked ? 'busy' : 'student'; renderSheet(); return; }
  if (t.dataset.field === 'studentId' && t.value === '__new') { openStudentEdit(null, true); return; }
  if (t.dataset.field === 'studentId' && S.sheet.type === 'lesson' && S.sheet.isNew) d.duration = stById(t.value)?.duration || d.duration;
  if (t.dataset.field === 'duration' && S.sheet.type === 'lesson') d.duration = Number(t.value);
  if (!(t.dataset.field === 'price' && S.sheet.type === 'lesson')) d[t.dataset.field] = t.value;
  // Перерисовываем только после выбора в пикерах — иначе при переходе между полями закрывается клавиатура.
  if (['studentId', 'date', 'start'].includes(t.dataset.field) || (S.sheet.type === 'studentEdit' && t.dataset.field === 'price')) renderSheet();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.sheet) closeSheet();
  if (e.key === 'Enter' && e.target.matches('[data-vtext]') && !e.shiftKey) { e.preventDefault(); runVoice(e.target.value); }
});

/* Свайпы: день/неделя/месяц */
let touch = null;
document.addEventListener('touchstart', (e) => {
  const area = e.target.closest('[data-swipe]');
  if (e.touches.length === 2 && e.target.closest('.tl')) {
    const [a, b] = e.touches;
    pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: S.zoom };
    touch = null;
    return;
  }
  touch = area && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, kind: area.dataset.swipe, n: Number(area.dataset.n) || 1 } : null;
}, { passive: true });
/* Щипок по шкале времени — масштаб. */
let pinch = null;
document.addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const [a, b] = e.touches;
  const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  setZoom(pinch.z * (d / pinch.d), { save: false });
}, { passive: false });
document.addEventListener('gesturestart', (e) => { if (e.target.closest?.('.tl')) e.preventDefault(); });
document.addEventListener('touchend', (e) => {
  if (pinch) {
    if (e.touches.length < 2) { pinch = null; saveView(); render(); }
    return;
  }
  if (!touch) return;
  const dx = e.changedTouches[0].clientX - touch.x;
  const dy = e.changedTouches[0].clientY - touch.y;
  const kind = touch.kind;
  const days = touch.n;
  touch = null;
  if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
  const dir = dx < 0 ? 1 : -1;
  if (kind === 'day') go(addDays(S.date, dir * days));
  else if (kind === 'week') go(addDays(S.date, dir * 7));
  else if (kind === 'month') { S.anim = dir > 0 ? 'next' : 'prev'; S.date = `${shiftMonth(monthKey(S.date), dir)}-01`; }
  render();
}, { passive: true });

/* ---------- Запуск ---------- */

async function loadAll() {
  [S.students, S.lessons, S.payments, S.series] = await Promise.all(db.STORES.map((s) => db.getAll(s)));
  S.settings = { ...DEFAULT_SETTINGS, ...((await db.getMeta('settings')) || {}) };
  S.lastBackup = (await db.getMeta('lastBackup')) || null;
  const v = (await db.getMeta('view')) || {};
  if (['day', '3day', 'week', 'month'].includes(v.calMode)) S.calMode = v.calMode;
  if (v.zoom) S.zoom = v.zoom;
  S.shown = v.shown || null;
  S.media = await db.getAll('media');
}

/** Раскладываем регулярные уроки на 10 недель вперёд. */
async function extendAllSeries() {
  const t = today();
  const ops = [];
  for (const s of S.series) {
    if (s.until && s.until < t) continue;
    const ext = extendSeries(s, t);
    if (ext.series.generatedUntil === s.generatedUntil) continue;
    ops.push({ put: ['series', ext.series] }, ...ext.lessons.map((l) => ({ put: ['lessons', l] })));
  }
  if (ops.length) {
    await db.apply(ops);
    applyLocal(ops);
  }
}

/** Один раз: ученикам без листа — «Репетиторство», занятость «Школа» — на лист «Школа». */
async function initSheets() {
  if (await db.getMeta('sheetsInit')) return;
  const ops = S.students.filter((s) => !s.sheet).map((s) => ({ put: ['students', { ...s, sheet: isBusy(s) && /школ/i.test(s.name) && sheetById('school') ? 'school' : sheets()[0].id }] }));
  if (ops.length) { await db.apply(ops); applyLocal(ops); }
  await db.setMeta('sheetsInit', true);
}

async function start() {
  await db.openDB();
  await loadAll();
  await extendAllSeries();
  await initSheets();
  render();
  // Обновляем линию «сейчас» и смену дня.
  let lastDay = today();
  setInterval(() => {
    if (today() !== lastDay) { lastDay = today(); extendAllSeries().then(render); return; }
    if (S.tab === 'cal' && !S.sheet) render();
  }, 60000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);
}

start().catch((e) => {
  document.body.innerHTML = `<p style="padding:24px">Не удалось открыть хранилище: ${esc(e.message)}</p>`;
});

// для отладки в консоли
globalThis.__lessons = { S, interpret: (t) => interpret(t, voiceCtx()), MONTHS_GEN };
