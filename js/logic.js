// Чистая логика без DOM: даты, цены, балансы, регулярные уроки.

export const uid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
export const pad = (n) => String(n).padStart(2, '0');

/* ---------- Даты (ISO 'YYYY-MM-DD', время 'HH:MM', всё в местном времени) ---------- */

export const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function fromISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(iso, n) {
  const d = fromISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}
/** 0 = понедельник … 6 = воскресенье */
export const weekday = (iso) => (fromISO(iso).getDay() + 6) % 7;
export const startOfWeek = (iso) => addDays(iso, -weekday(iso));
export const daysBetween = (a, b) => Math.round((fromISO(b) - fromISO(a)) / 864e5);
export const monthKey = (iso) => iso.slice(0, 7);
export function shiftMonth(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
export const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
export const fromMin = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
export const nowMin = (d) => d.getHours() * 60 + d.getMinutes();

export const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const WD_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const WD_FULL = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
export const WD_ACC = ['понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];
export const WD_PLURAL = ['понедельникам', 'вторникам', 'средам', 'четвергам', 'пятницам', 'субботам', 'воскресеньям'];

const cap = (s) => s[0].toUpperCase() + s.slice(1);
export function monthTitle(key) {
  const [y, m] = key.split('-').map(Number);
  return `${cap(MONTHS[m - 1])} ${y}`;
}
/** «Чт, 13 ноября» */
export function dayTitle(iso, { full = false } = {}) {
  const d = fromISO(iso);
  const wd = full ? WD_FULL[weekday(iso)] : WD_SHORT[weekday(iso)];
  return `${full ? wd : wd}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
}
/** «сегодня», «завтра», «чт, 13 ноября» — для подтверждений голосом. */
export function relDay(iso, todayIso) {
  const diff = daysBetween(todayIso, iso);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  if (diff === 2) return 'послезавтра';
  if (diff === -1) return 'вчера';
  return dayTitle(iso).toLowerCase();
}

/* ---------- Деньги (целые рубли) ---------- */

export function formatRub(n, { sign = false } = {}) {
  const v = Math.round(n || 0);
  const s = Math.abs(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const pre = v < 0 ? '−' : sign && v > 0 ? '+' : '';
  return `${pre}${s} ₽`;
}
export function parseRub(str) {
  const v = Number(String(str).replace(/[\s  ₽р]/g, '').replace(',', '.'));
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
export const lessonsWord = (n) => `${n} ${plural(n, 'урок', 'урока', 'уроков')}`;

/* ---------- Цены ---------- */

/** Цена ученика на дату: история цен [{from, price}], действует последняя с from <= даты. */
export function priceAt(student, iso) {
  const list = [...(student?.prices || [])].sort((a, b) => a.from.localeCompare(b.from));
  if (!list.length) return 0;
  let p = list[0].price;
  for (const x of list) if (x.from <= iso) p = x.price;
  return p;
}
export const currentPrice = (student, todayIso) => priceAt(student, todayIso);
/** Занятость (школа, встречи) — в календаре есть, в деньгах нет. */
export const isBusy = (student) => student?.kind === 'busy';
export const lessonPrice = (lesson, student) => (isBusy(student) ? 0 : lesson.price ?? priceAt(student, lesson.date));

/** Новая цена с даты: запись на ту же дату заменяется. */
export function withPrice(student, price, fromIso) {
  const prices = (student.prices || []).filter((p) => p.from !== fromIso);
  prices.push({ from: fromIso, price });
  prices.sort((a, b) => a.from.localeCompare(b.from));
  return { ...student, prices };
}

/* ---------- Уроки ---------- */

export const lessonStart = (l) => {
  const d = fromISO(l.date);
  d.setMinutes(toMin(l.start));
  return d;
};
export const lessonEnd = (l) => new Date(lessonStart(l).getTime() + l.duration * 60000);
export const endTime = (l) => fromMin(toMin(l.start) + l.duration);

/**
 * planned — впереди; done — проведён (прошедший запланированный считается проведённым);
 * missed — пропуск без предупреждения (оплачивается); cancelled — отменён (не оплачивается).
 */
export function statusOf(l, now) {
  if (l.status === 'planned' && lessonEnd(l) <= now) return 'done';
  return l.status;
}
export const isCharged = (st) => st === 'done' || st === 'missed';
export const STATUS_LABEL = { planned: 'Запланирован', done: 'Проведён', missed: 'Пропуск (оплачивается)', cancelled: 'Отменён' };

export const sortLessons = (a, b) => (a.date === b.date ? a.start.localeCompare(b.start) : a.date.localeCompare(b.date));

/** Пересечения по времени с другими неотменёнными уроками того же дня. */
export function conflicts(lessons, cand) {
  const s = toMin(cand.start);
  const e = s + cand.duration;
  return lessons.filter((l) => l.id !== cand.id && l.date === cand.date && l.status !== 'cancelled'
    && toMin(l.start) < e && toMin(l.start) + l.duration > s);
}

/* ---------- Статистика ---------- */

export function studentStats(student, lessons, payments, now) {
  const own = lessons.filter((l) => l.studentId === student.id);
  const r = { done: 0, missed: 0, cancelled: 0, planned: 0, charged: 0, paid: 0, next: null, last: null };
  for (const l of own) {
    const st = statusOf(l, now);
    r[st]++;
    if (isCharged(st)) r.charged += lessonPrice(l, student);
  }
  for (const p of payments) if (p.studentId === student.id) r.paid += p.amount;
  r.balance = r.paid - r.charged;
  const price = currentPrice(student, toISO(now));
  r.price = price;
  r.lessonsLeft = price > 0 ? Math.floor(r.balance / price) : 0; // >0 — оплачено вперёд, <0 — долг в уроках
  const sorted = own.filter((l) => l.status !== 'cancelled').sort(sortLessons);
  r.next = sorted.find((l) => statusOf(l, now) === 'planned') || null;
  r.last = [...sorted].reverse().find((l) => statusOf(l, now) !== 'planned') || null;
  return r;
}

/** «оплачено ещё 3 урока» / «долг 3 000 ₽» / «расчёт закрыт» */
export function balanceText(st) {
  if (st.balance > 0) {
    if (st.lessonsLeft > 0) return `оплачено ещё ${lessonsWord(st.lessonsLeft)}`;
    return `аванс ${formatRub(st.balance)}`;
  }
  if (st.balance < 0) return `долг ${formatRub(-st.balance)}`;
  return 'расчёт закрыт';
}

export function monthStats(key, { students, lessons, payments }, now) {
  const byId = new Map(students.map((s) => [s.id, s]));
  const r = { done: 0, missed: 0, cancelled: 0, planned: 0, earned: 0, plannedSum: 0, received: 0, perStudent: new Map() };
  const row = (id) => {
    if (!r.perStudent.has(id)) r.perStudent.set(id, { lessons: 0, earned: 0, received: 0, planned: 0 });
    return r.perStudent.get(id);
  };
  for (const l of lessons) {
    if (monthKey(l.date) !== key || isBusy(byId.get(l.studentId))) continue;
    const st = statusOf(l, now);
    const price = lessonPrice(l, byId.get(l.studentId));
    r[st]++;
    if (isCharged(st)) {
      r.earned += price;
      row(l.studentId).lessons++;
      row(l.studentId).earned += price;
    } else if (st === 'planned') {
      r.plannedSum += price;
      row(l.studentId).planned++;
    }
  }
  for (const p of payments) {
    if (monthKey(p.date) !== key) continue;
    r.received += p.amount;
    row(p.studentId).received += p.amount;
  }
  return r;
}

export function totalDebt(students, lessons, payments, now) {
  let debt = 0;
  for (const s of students) {
    if (isBusy(s)) continue;
    const st = studentStats(s, lessons, payments, now);
    if (st.balance < 0) debt -= st.balance;
  }
  return debt;
}

/* ---------- Регулярные уроки ---------- */

export const HORIZON_DAYS = 70; // насколько вперёд раскладывать регулярные уроки

/**
 * Серия: {id, studentId, days:[0..6], start, duration, from, until|null, generatedUntil|null}.
 * Возвращает новые уроки и обновлённую серию. Уже созданные даты не создаются повторно,
 * поэтому перенесённый или удалённый урок серии не «воскресает».
 */
export function extendSeries(series, todayIso) {
  const limit = addDays(todayIso, HORIZON_DAYS);
  const end = series.until && series.until < limit ? series.until : limit;
  let d = series.generatedUntil ? addDays(series.generatedUntil, 1) : series.from;
  if (d < series.from) d = series.from;
  const out = [];
  for (; d <= end; d = addDays(d, 1)) {
    if (!series.days.includes(weekday(d))) continue;
    out.push({ id: uid(), studentId: series.studentId, date: d, start: series.start, duration: series.duration, status: 'planned', price: null, seriesId: series.id, note: series.note || '', ...(series.sheet ? { sheet: series.sheet } : {}) });
  }
  const generatedUntil = series.generatedUntil && series.generatedUntil > end ? series.generatedUntil : end;
  return { lessons: out, series: { ...series, generatedUntil } };
}

export function seriesText(s) {
  const days = [...s.days].sort().map((d) => WD_SHORT[d].toLowerCase()).join(', ');
  return `${days} в ${s.start}, ${s.duration} мин`;
}

/* ---------- Цвета учеников ---------- */

export const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#30b0c7', '#007aff', '#5856d6', '#af52de', '#ff2d55', '#a2845e'];
export function nextColor(students) {
  const used = new Map(COLORS.map((c) => [c, 0]));
  for (const s of students) if (used.has(s.color)) used.set(s.color, used.get(s.color) + 1);
  return [...used.entries()].sort((a, b) => a[1] - b[1])[0][0];
}

/* ---------- Резервная копия ---------- */

export function validateBackup(data) {
  if (!data || data.app !== 'lessons') throw new Error('Это не копия приложения «Уроки»');
  for (const k of ['students', 'lessons', 'payments', 'series']) {
    if (!Array.isArray(data[k])) throw new Error(`В копии нет раздела ${k}`);
  }
  return data;
}
