// Голосовые команды: текст (от распознавания речи iPhone или с клавиатуры) → понятное действие.
// Разбор целиком на устройстве, без сети и без ИИ — по правилам русской речи.
import {
  addDays, startOfWeek, weekday, toISO, fromISO, toMin, fromMin, statusOf, sortLessons, lessonStart, lessonEnd,
  conflicts, priceAt, withPrice, uid, extendSeries, studentStats, balanceText, formatRub, relDay, dayTitle, WD_SHORT,
  nextColor, lessonsWord, plural,
} from './logic.js';

/* ---------- Числа словами ---------- */

const UNITS = { ноль: 0, один: 1, одна: 1, одну: 1, одного: 1, два: 2, две: 2, двух: 2, три: 3, трех: 3, четыре: 4, четырех: 4, пять: 5, пяти: 5, шесть: 6, шести: 6, семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9 };
const TEENS = { десять: 10, десяти: 10, одиннадцать: 11, одиннадцати: 11, двенадцать: 12, двенадцати: 12, тринадцать: 13, тринадцати: 13, четырнадцать: 14, четырнадцати: 14, пятнадцать: 15, пятнадцати: 15, шестнадцать: 16, шестнадцати: 16, семнадцать: 17, семнадцати: 17, восемнадцать: 18, восемнадцати: 18, девятнадцать: 19, девятнадцати: 19 };
const TENS = { двадцать: 20, двадцати: 20, тридцать: 30, тридцати: 30, сорок: 40, сорока: 40, пятьдесят: 50, пятидесяти: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90 };
const HUNDS = { сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500, шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900 };
const ORD = {
  первое: 1, первого: 1, второе: 2, второго: 2, третье: 3, третьего: 3, четвертое: 4, четвертого: 4, пятое: 5, пятого: 5,
  шестое: 6, шестого: 6, седьмое: 7, седьмого: 7, восьмое: 8, восьмого: 8, девятое: 9, девятого: 9, десятое: 10, десятого: 10,
  одиннадцатое: 11, одиннадцатого: 11, двенадцатое: 12, двенадцатого: 12, тринадцатое: 13, тринадцатого: 13, четырнадцатое: 14, четырнадцатого: 14,
  пятнадцатое: 15, пятнадцатого: 15, шестнадцатое: 16, шестнадцатого: 16, семнадцатое: 17, семнадцатого: 17, восемнадцатое: 18, восемнадцатого: 18,
  девятнадцатое: 19, девятнадцатого: 19, двадцатое: 20, двадцатого: 20, тридцатое: 30, тридцатого: 30,
};
const THOUSAND = /^(тысяч[аиу]?|тыс|тыщ[аиу]?)$/;

function wordsToNumbers(tokens) {
  const out = [];
  let cur = null; // собираемое число
  let lp = Infinity; // разряд последнего слова
  let teen = false;
  let ord = false;
  let thousands = 0;
  const flush = () => {
    if (cur !== null || thousands) out.push(String(thousands + (cur || 0)) + (ord ? '-го' : ''));
    cur = null; lp = Infinity; teen = false; ord = false; thousands = 0;
  };
  for (const t of tokens) {
    let v = null;
    let p = 0;
    let isTeen = false;
    let isOrd = false;
    if (t in HUNDS) { v = HUNDS[t]; p = 100; }
    else if (t in TENS) { v = TENS[t]; p = 10; }
    else if (t in TEENS) { v = TEENS[t]; p = 1; isTeen = true; }
    else if (t in UNITS) { v = UNITS[t]; p = 1; }
    else if (t in ORD) { v = ORD[t]; p = v >= 10 && v % 10 === 0 ? 10 : 1; isOrd = true; isTeen = v >= 10 && v < 20; }
    else if (t === 'полтора' || t === 'полторы') { v = 1.5; p = 1; }

    if (v !== null) {
      const fits = cur !== null && !ord && !teen && lp > p && !(isTeen && lp !== 100);
      const afterThousand = cur === null && thousands > 0;
      if (!fits && !afterThousand && (cur !== null || thousands)) flush();
      cur = (cur || 0) + v; lp = p; teen = isTeen; ord = isOrd;
      continue;
    }
    if (THOUSAND.test(t)) {
      let base = cur;
      if (base === null && /^\d+(\.\d+)?$/.test(out[out.length - 1] || '')) base = Number(out.pop());
      if (base === null) base = 1;
      cur = null; ord = false; teen = false;
      thousands += Math.round(base * 1000); lp = 1000;
      continue;
    }
    if (thousands && cur === null && /^\d{1,3}$/.test(t)) { cur = Number(t); flush(); continue; }
    flush();
    const pol = t.match(/^пол(\S+)$/);
    if (pol && pol[1] in ORD && ORD[pol[1]] <= 12) out.push(`${ORD[pol[1]] - 1 || 12}:30`);
    else if (t === 'полдень' || t === 'полдня') out.push('12:00');
    else if (t === 'полчаса') out.push('30', 'минут');
    else out.push(t);
  }
  flush();
  return out;
}

export function normalize(text) {
  let s = ` ${String(text || '').toLowerCase().replace(/ё/g, 'е')} `;
  s = s.replace(/₽/g, ' руб ');
  s = s.replace(/[,!?;«»"“”()]/g, ' ').replace(/[–—]/g, ' ');
  s = s.replace(/\.(?!\d)/g, ' ');
  s = s.replace(/(\d)\s(\d{3})(?!\d)/g, '$1$2'); // 1 500 → 1500
  s = s.replace(/(\d)(руб|р)(?=\s)/g, '$1 руб');
  s = s.replace(/(\d{1,2})-(\d{2})(?!\d)/g, '$1:$2'); // 18-00 → 18:00
  s = s.replace(/(\d)\s*(ч|час)\.?\s*(\d{2})\s*(мин\S*)?(?=\s)/g, '$1:$3');
  const tokens = s.split(/\s+/).filter(Boolean);
  return ` ${wordsToNumbers(tokens).join(' ')} `;
}

/* ---------- Время и даты в тексте ---------- */

const blank = (s, m) => s.slice(0, m.index) + ' '.repeat(m[0].length) + s.slice(m.index + m[0].length);

function adjHour(h, mer) {
  if (mer === 'утра') return h === 12 ? 0 : h;
  if (mer === 'ночи') return h === 12 ? 0 : h;
  if ((mer === 'дня' || mer === 'вечера') && h < 12) return h + 12;
  if (!mer && h >= 1 && h <= 7) return h + 12; // «в пять» у репетитора — 17:00
  return h;
}

const PREP = '(?:в|во|к|ко|на|с|со|до|около|по)';
const MER = '(?:\\s+(утра|дня|вечера|ночи))?';
const TIME_RES = [
  new RegExp(`\\s(?:${PREP}\\s+)?(\\d{1,2}):(\\d{2})${MER}(?=\\s)`),
  new RegExp(`\\s${PREP}\\s+(\\d{1,2})\\.(\\d{2})${MER}(?=\\s)`),
  new RegExp(`\\s${PREP}\\s+(\\d{1,2})(?:\\s+час(?:а|ов)?)?(?:\\s+(\\d{2})(?:\\s+мин\\S*)?)?${MER}(?=\\s)(?!\\s+(?:руб|урок|занят|минут|мин|числ|тыс))`),
  new RegExp(`\\s${PREP}\\s+(\\d{1,2})\\s+(?:час(?:а|ов)?)${MER}(?=\\s)`),
  /\s(?:в|к|на|до)\s+час(?:\s+(дня|ночи))?(?=\s)(?!\s+(?:позже|раньше))/,
];

/** Все времена в строке по порядку: [{min, idx}] и строка без них. */
export function parseTimes(str) {
  let s = str;
  const found = [];
  for (;;) {
    let best = null;
    TIME_RES.forEach((re, i) => {
      const m = s.match(re);
      if (m && (!best || m.index < best.m.index)) best = { m, i };
    });
    if (!best) break;
    const { m, i } = best;
    let h;
    let min = 0;
    let mer;
    if (i === 4) { h = 1; mer = m[1] || 'дня'; } else { h = Number(m[1]); min = m[2] ? Number(m[2]) : 0; mer = m[3]; }
    s = blank(s, m);
    if (h > 23 || min > 59) continue;
    found.push({ min: adjHour(h, mer) * 60 + min, idx: m.index });
  }
  return { times: found, rest: s };
}

const MONTH_STEMS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
const MONTH_RE = /\s(\d{1,2})(?:-?го|-?е)?\s+(январ\S*|феврал\S*|марта?|апрел\S*|ма[яй]|июн\S*|июл\S*|август\S*|сентябр\S*|октябр\S*|ноябр\S*|декабр\S*)(?=\s)/;
const WD_RE = /\s(?:(следующ\S*|будущ\S*|эт\S*|ближайш\S*|прошл\S*)\s+)?(понедельник\S*|вторник\S*|сред(?:а|у|ы|е|ам|ами)?|четверг\S*|пятниц\S*|суббот\S*|воскресен\S*)(?=\s)/;
const WD_STEMS = ['понедельник', 'вторник', 'сред', 'четверг', 'пятниц', 'суббот', 'воскресен'];
const wdIndex = (w) => WD_STEMS.findIndex((st) => w.startsWith(st));

function monthDay(day, month, todayIso, explicitYear) {
  const t = fromISO(todayIso);
  let y = explicitYear || t.getFullYear();
  let d = new Date(y, month, day);
  if (d.getMonth() !== month) return null;
  if (!explicitYear && (t - d) / 864e5 > 60) d = new Date(++y, month, day);
  return toISO(d);
}

/**
 * Даты в строке: [{iso, wd, wdOnly, idx}] и строка без них.
 * dir — куда искать день недели без уточнений: 'future' (ближайший впереди) или 'past'.
 */
export function parseDates(str, todayIso, dir = 'future') {
  let s = str;
  const found = [];
  const add = (iso, m, extra = {}) => { found.push({ iso, idx: m.index, ...extra }); s = blank(s, m); };
  let m;
  const REL = [
    [/\s(позавчера|позавчерашн\S*)(?=\s)/, -2], [/\s(послезавтра|послезавтрашн\S*)(?=\s)/, 2],
    [/\s(сегодня|сегодняшн\S*)(?=\s)/, 0], [/\s(завтра|завтрашн\S*)(?=\s)/, 1], [/\s(вчера|вчерашн\S*)(?=\s)/, -1],
  ];
  for (const [re, n] of REL) while ((m = s.match(re))) add(addDays(todayIso, n), m);
  while ((m = s.match(/\sчерез\s+(?:(\d+)\s+)?(дн\S*|день|недел\S*)(?=\s)/))) {
    const n = Number(m[1] || 1);
    add(addDays(todayIso, m[2].startsWith('недел') ? n * 7 : n), m);
  }
  while ((m = s.match(MONTH_RE))) {
    const mon = MONTH_STEMS.findIndex((st) => m[2].startsWith(st));
    const iso = monthDay(Number(m[1]), mon, todayIso);
    if (iso) add(iso, m); else s = blank(s, m);
  }
  while ((m = s.match(/(?<!\s(?:в|к|до|около))\s(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?=\s)/))) {
    const mon = Number(m[2]) - 1;
    if (mon > 11 || Number(m[1]) > 31) break;
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : 0;
    const iso = monthDay(Number(m[1]), mon, todayIso, y);
    if (iso) add(iso, m); else s = blank(s, m);
  }
  while ((m = s.match(/\s(\d{1,2})(?:-?го|-?е|\s+числа)(?=\s)/))) {
    const t = fromISO(todayIso);
    const day = Number(m[1]);
    let d = new Date(t.getFullYear(), t.getMonth(), day);
    if (day < t.getDate()) d = new Date(t.getFullYear(), t.getMonth() + 1, day);
    add(toISO(d), m);
  }
  while ((m = s.match(WD_RE))) {
    const wd = wdIndex(m[2]);
    const mod = m[1] || '';
    const tw = weekday(todayIso);
    let iso;
    if (/^(следующ|будущ)/.test(mod)) iso = addDays(startOfWeek(todayIso), 7 + wd);
    else if (/^эт/.test(mod)) iso = addDays(startOfWeek(todayIso), wd);
    else if (/^прошл/.test(mod)) iso = addDays(startOfWeek(todayIso), wd - 7);
    else if (dir === 'past') iso = addDays(todayIso, -((tw - wd + 7) % 7));
    else iso = addDays(todayIso, (wd - tw + 7) % 7);
    add(iso, m, { wd, wdOnly: !mod });
  }
  found.sort((a, b) => a.idx - b.idx);
  return { dates: found, rest: s };
}

/** Длительность: «на 90 минут», «по полтора часа», «на 2 часа». */
export function parseDuration(str) {
  let s = str;
  const res = [
    [/\s(?:на|по|длительностью|продолжительностью)?\s*(\d{2,3})\s+(?:минут\S*|мин)(?=\s)(?!\s+(?:позже|раньше|попозже|пораньше))/, (m) => Number(m[1])],
    [/\s(?:на|по|длительностью)\s+1\.5\s+час\S*(?=\s)/, () => 90],
    [/\s(?:на|по|длительностью)\s+(\d)\s+час(?:а|ов)?(?=\s)(?!\s+(?:дня|ночи|утра|вечера|позже|раньше))/, (m) => Number(m[1]) * 60],
    [/\s(?:на|по|длительностью)\s+час(?=\s)(?!\s+(?:дня|ночи|позже|раньше|попозже|пораньше))/, () => 60],
  ];
  for (const [re, val] of res) {
    const m = s.match(re);
    if (m) {
      const v = val(m);
      if (v >= 15 && v <= 300) return { duration: v, rest: blank(s, m) };
    }
  }
  return { duration: null, rest: s };
}

/** Сдвиг: «на час позже», «на 30 минут раньше», «позже на полчаса». */
export function parseShift(str) {
  const unit = '(?:(\\d+(?:\\.5)?)\\s+)?(час\\S*|минут\\S*|мин)';
  const dir = '(позже|попозже|раньше|пораньше|вперед|назад)';
  let m = str.match(new RegExp(`\\sна\\s+${unit}\\s+${dir}(?=\\s)`));
  let n; let u; let d;
  if (m) [, n, u, d] = m;
  else {
    m = str.match(new RegExp(`\\s${dir}\\s+на\\s+${unit}(?=\\s)`));
    if (!m) return null;
    [, d, n, u] = m;
  }
  const amount = Number(n || 1) * (u.startsWith('час') ? 60 : 1);
  const sign = /^(раньше|пораньше|назад)$/.test(d) ? -1 : 1;
  return { delta: sign * amount, rest: blank(str, m) };
}

/* ---------- Имена учеников ---------- */

const ENDINGS = ['ами', 'ями', 'ого', 'его', 'ой', 'ей', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'у', 'ю', 'а', 'я', 'е', 'и', 'ы', 'о', 'ь', 'й'];
export function stem(word) {
  let w = word.toLowerCase().replace(/ё/g, 'е');
  for (const e of ENDINGS) {
    if (w.length - e.length >= 2 && w.endsWith(e)) { w = w.slice(0, -e.length); break; }
  }
  return w;
}

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 9;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

const STOP = new Set(`в во на с со к ко у до по за для и а но или из от о об при через не нет да же ли бы то это эту этот все всё всех всем
урок урока уроку уроком уроки уроков занятие занятия занятий занятию занятием пару
перенеси перенести перенесите передвинь сдвинь подвинь поставь поставить добавь добавить запиши записать назначь отмени отменить удали удалить убери
сегодня завтра послезавтра вчера позавчера час часа часов минут минуты утра дня вечера ночи позже раньше пожалуйста мне меня мой моя моего моей
новый новая новое новую нового ученик ученица ученика ученицу ученику учеником студент студента студентку каждый каждую каждое каждые
цена цену стоимость оплатил оплатила оплатили заплатил заплатила перевел перевела рублей рубля рубль руб тысяч тысячи тысяча когда сколько
следующий следующую следующее ближайший ближайшую время теперь будет будут был была было пришел пришла пропустил пропустила
провел провела проведен прошел прошла урок-то ещё еще его ее её их она он они сделай сделать поменяй измени`.split(/\s+/));

const isWordish = (t) => /^[а-яa-z-]{3,}$/.test(t) && !STOP.has(t) && wdIndex(t) < 0 && !MONTH_STEMS.some((m) => m.length > 2 && t.startsWith(m));

function nameKeys(student) {
  const parts = `${student.name} ${student.aliases || ''}`.toLowerCase().replace(/ё/g, 'е').split(/[\s,]+/).filter((p) => p.length >= 2);
  return parts;
}

function tokenScore(token, part) {
  if (token === part) return 3;
  const a = stem(token);
  const b = stem(part);
  if (a === b && a.length >= 2) return 2;
  if (a.length >= 4 && b.length >= 4 && a[0] === b[0] && lev(a, b) <= 1) return 1;
  return 0;
}

/** Ученики, упомянутые в тексте, по убыванию уверенности. */
export function findStudents(norm, students) {
  const tokens = norm.split(/\s+/).filter(isWordish);
  const res = [];
  for (const st of students) {
    if (st.archived) continue;
    let score = 0;
    let first = Infinity;
    for (const part of nameKeys(st)) {
      let best = 0;
      tokens.forEach((t, i) => {
        const sc = tokenScore(t, part);
        if (sc > best) best = sc;
        if (sc) first = Math.min(first, i);
      });
      score += best;
    }
    if (score) res.push({ student: st, score, first });
  }
  return res.sort((a, b) => b.score - a.score || a.first - b.first);
}

/** «Машу» → «Маша», «Петю» → «Петя», «Ани» → «Аня» — для нового ученика, имя можно поправить. */
export function guessNominative(word) {
  const w = word.toLowerCase();
  const capw = (x) => x.replace(/(^|-)([а-яa-z])/g, (_, p, c) => p + c.toUpperCase());
  let r = w;
  if (/[жшщчц]ей$/.test(w)) r = `${w.slice(0, -2)}а`;
  else if (/ей$/.test(w) && w.length > 4) r = `${w.slice(0, -2)}я`;
  else if (/ой$/.test(w) && w.length > 4) r = `${w.slice(0, -2)}а`;
  else if (/ю$/.test(w)) r = `${w.slice(0, -1)}я`;
  else if (/у$/.test(w)) r = `${w.slice(0, -1)}а`;
  else if (/[жшщчкгх]и$/.test(w)) r = `${w.slice(0, -1)}а`;
  else if (/и$/.test(w)) r = `${w.slice(0, -1)}я`;
  else if (/ы$/.test(w)) r = `${w.slice(0, -1)}а`;
  return capw(r);
}

function unknownName(norm, after) {
  const tokens = norm.split(/\s+/).filter(Boolean);
  let start = 0;
  if (after) {
    const i = tokens.findIndex((t) => after.test(t));
    if (i >= 0) start = i + 1;
  }
  const out = [];
  for (let i = start; i < tokens.length && out.length < 2; i++) {
    const t = tokens[i];
    if (isWordish(t) && !/^(для|урок\S*|занят\S*|цен\S*|по|кажд\S*)$/.test(t)) out.push(t);
    else if (out.length) break;
  }
  return out.length ? out.map(guessNominative).join(' ') : null;
}

/* ---------- Намерение ---------- */

const RX = {
  queryDay: /^\s*(что|кто|какие|покажи|расписание|открой|какое)\s/,
  newStudent: /\s(нов\S*\s+(ученик\S*|учениц\S*|студент\S*)|добав\S*\s+(ученик\S*|ученицу|студент\S*))\s/,
  stop: /\s(больше не (занима|будет|ходит)|не будет заниматься|бросил|бросила|(отмени|удали|убери|останови)\S*\s+(все|расписание|регулярн\S*|постоянн\S*))/,
  series: /\s(кажд\S*|еженедельн\S*|регулярн\S*|постоянн\S*|по\s+(понедельникам|вторникам|средам|четвергам|пятницам|субботам|воскресеньям))\s/,
  payment: /\s(оплат\S*|заплат\S*|перев[её]л\S*|перечисл\S*|скинул\S*|внес\S*|предоплат\S*|аванс\S*|получил\S*|отдал\S*|прислал\S*)\s/,
  price: /\s(цен\S*|стоимост\S*|стоит|стоят|тариф\S*)\s/,
  move: /\s(перенес\S*|перенос\S*|передвин\S*|сдвин\S*|подвин\S*|перестав\S*|поменя\S*|измени\S*)\s/,
  remove: /\s(удали\S*|убери|убрать|сотри)\s/,
  cancel: /\s(отмен\S*|не будет|не будем|не прид\S*|не смож\S*|не получится|заболе\S*|боле(ет|ем|ю))\s/,
  missed: /\s(пропуст\S*|прогул\S*|не пришл\S*|не пришел|не явил\S*|не было)\s/,
  done: /\s(провел\S*|проведен\S*|прошел|прошло|состоял\S*)\s/,
  when: /\s(когда)\s/,
  balance: /\s(сколько|долг\S*|должен|должна|баланс\S*|остал\S*|оплачено)\s/,
  add: /\s(добав\S*|запиш\S*|запис\S*|постав\S*|назнач\S*|урок\S*|заняти\S*)\s/,
};

export function detectIntent(norm) {
  if (RX.newStudent.test(norm)) return 'newStudent';
  if (RX.stop.test(norm)) return 'stop';
  if (RX.payment.test(norm) && !/\sсколько\s/.test(norm)) return 'payment';
  if (RX.price.test(norm)) return 'price';
  if (RX.series.test(norm)) return 'series';
  if (parseShift(norm)) return 'shift';
  if (RX.move.test(norm)) return 'move';
  if (RX.remove.test(norm)) return 'remove';
  if (RX.cancel.test(norm)) return 'cancel';
  if (RX.missed.test(norm)) return 'missed';
  if (RX.done.test(norm)) return 'done';
  if (RX.when.test(norm)) return 'when';
  if (RX.balance.test(norm)) return 'balance';
  if (RX.queryDay.test(norm)) return 'day';
  if (RX.add.test(norm)) return 'add';
  return null;
}

/* ---------- Сборка действия ---------- */

const err = (text) => ({ kind: 'error', text });
const ansr = (text, nav) => ({ kind: 'answer', text, nav });
const fmtTime = (min) => fromMin(min);
const who = (s) => s.name;

function lessonLabel(l, today) {
  return `${relDay(l.date, today)} в ${l.start}`;
}

/** Урок ученика по уточнениям (день/время). dir: 'future' — ближайший впереди, 'past' — последний прошедший. */
function pickLesson(studentId, dates, times, dir, ctx) {
  const { now } = ctx;
  const all = ctx.lessons.filter((l) => l.studentId === studentId && l.status !== 'cancelled').sort(sortLessons);
  const byTime = (list) => {
    if (!times.length) return list;
    const exact = list.filter((l) => toMin(l.start) === times[0].min);
    return exact;
  };
  if (dates.length) {
    const d = dates[0];
    let list = byTime(all.filter((l) => l.date === d.iso));
    if (!list.length && d.wdOnly) {
      const alt = addDays(d.iso, dir === 'past' ? -7 : 7);
      list = byTime(all.filter((l) => l.date === alt));
    }
    return list[0] || null;
  }
  const list = byTime(all);
  if (dir === 'future') return list.find((l) => lessonEnd(l) > now) || null;
  return [...list].reverse().find((l) => lessonStart(l) <= now) || null;
}

function studentOrError(norm, ctx, { allowNew = false, after } = {}) {
  const found = findStudents(norm, ctx.students);
  if (found.length > 1 && found[0].score === found[1].score) {
    return { error: err(`Кого именно: ${found.filter((f) => f.score === found[0].score).map((f) => f.student.name).join(' или ')}? Скажите полное имя.`) };
  }
  if (found.length) return { student: found[0].student };
  if (allowNew) {
    const name = unknownName(norm, after);
    if (name) {
      const student = {
        id: uid(), name, aliases: '', color: nextColor(ctx.students), duration: ctx.settings.duration,
        prices: [{ from: '2000-01-01', price: ctx.settings.price }], note: '', archived: false, createdAt: Date.now(),
      };
      return { student, isNew: true };
    }
  }
  return { error: err(ctx.students.length ? 'Не расслышал имя ученика. Повторите, пожалуйста.' : 'Сначала добавьте ученика: «новый ученик Маша, цена 1500».') };
}

function conflictWarn(cand, ctx, ignoreIds = []) {
  const c = conflicts(ctx.lessons.filter((l) => !ignoreIds.includes(l.id)), cand);
  if (!c.length) return [];
  const byId = new Map(ctx.students.map((s) => [s.id, s]));
  return c.map((l) => `Пересекается: ${byId.get(l.studentId)?.name || 'урок'} ${l.start}–${fromMin(toMin(l.start) + l.duration)}`);
}

/** Сумма из текста: «4 занятия» → 4 × цена, иначе самое крупное число. */
function amountFrom(rest, student, today) {
  const m = rest.match(/\s(\d+)\s+(урок\S*|заняти\S*|раз)(?=\s)/);
  const price = priceAt(student, today);
  if (m) return { amount: Number(m[1]) * price, count: Number(m[1]) };
  const nums = [...rest.matchAll(/\s(\d+(?:\.\d+)?)(?=\s)/g)].map((x) => Number(x[1])).filter((n) => n >= 50);
  if (nums.length) return { amount: Math.round(Math.max(...nums)) };
  if (/\s(урок|заняти\S*)\s/.test(rest) && price) return { amount: price, count: 1 };
  return null;
}

/**
 * Главная функция. ctx = {students, lessons, payments, series, settings:{duration, price}, now: Date}.
 * Результат: {kind:'action', title, lines, warn, ops, newStudent?, nav?} | {kind:'answer', text, nav?} | {kind:'error', text}.
 * ops: [{put:[store, item]} | {del:[store, id]}] — приложение применяет их одной транзакцией.
 */
export function interpret(text, ctx) {
  const norm = normalize(text);
  if (!norm.trim()) return err('Пусто. Скажите, например: «перенеси Машу с четверга на пятницу в 17».');
  const today = toISO(ctx.now);
  const intent = detectIntent(norm);
  if (!intent) return err('Не понял команду. Посмотрите примеры ниже.');
  return HANDLERS[intent](norm, ctx, today);
}

const HANDLERS = {
  day(norm, ctx, today) {
    const { dates } = parseDates(norm, today);
    const iso = dates[0]?.iso || today;
    const n = ctx.lessons.filter((l) => l.date === iso && l.status !== 'cancelled').length;
    return ansr(`${relDay(iso, today)[0].toUpperCase()}${relDay(iso, today).slice(1)}: ${n ? lessonsWord(n) : 'уроков нет'}.`, { date: iso });
  },

  when(norm, ctx) {
    const r = studentOrError(norm, ctx);
    if (r.error) return r.error;
    const st = studentStats(r.student, ctx.lessons, ctx.payments, ctx.now);
    if (!st.next) return ansr(`У ${who(r.student)} нет запланированных уроков.`);
    return ansr(`${who(r.student)}: следующий урок ${lessonLabel(st.next, toISO(ctx.now))}.`, { date: st.next.date });
  },

  balance(norm, ctx) {
    const r = studentOrError(norm, ctx);
    if (r.error) return r.error;
    const st = studentStats(r.student, ctx.lessons, ctx.payments, ctx.now);
    return ansr(`${who(r.student)}: ${balanceText(st)}. Проведено ${lessonsWord(st.done)}${st.missed ? `, пропусков ${st.missed}` : ''}, оплачено ${formatRub(st.paid)}.`, { student: r.student.id });
  },

  add(norm, ctx, today) {
    const r = studentOrError(norm, ctx, { allowNew: true, after: /^(запиш\S*|добав\S*|постав\S*|назнач\S*|урок\S*|заняти\S*|для|с|у)$/ });
    if (r.error) return r.error;
    const { duration, rest: r1 } = parseDuration(norm);
    const { dates, rest: r2 } = parseDates(r1, today);
    const { times } = parseTimes(r2);
    if (!times.length) return err('Во сколько? Скажите время, например «завтра в 17».');
    const date = dates[0]?.iso || today;
    const dur = duration || (times[1] && times[1].min > times[0].min ? times[1].min - times[0].min : null) || r.student.duration || ctx.settings.duration;
    const lesson = { id: uid(), studentId: r.student.id, date, start: fmtTime(times[0].min), duration: dur, status: 'planned', price: null, seriesId: null, note: '' };
    const ops = [{ put: ['lessons', lesson] }];
    if (r.isNew) ops.unshift({ put: ['students', r.student] });
    return {
      kind: 'action', title: 'Новый урок',
      lines: [`${who(r.student)}: ${lessonLabel(lesson, today)}, ${dur} мин`],
      warn: conflictWarn(lesson, ctx), ops, newStudent: r.isNew ? r.student : null, nav: { date },
    };
  },

  move(norm, ctx, today) {
    const r = studentOrError(norm, ctx);
    if (r.error) return r.error;
    const { duration, rest: base } = parseDuration(norm);
    // Делим фразу на «откуда» и «куда» по первому «на», после которого есть день или время.
    let src = ' ';
    let dst = base;
    const re = /\sна\s/g;
    let m;
    while ((m = re.exec(base))) {
      const after = ` ${base.slice(m.index + 1)} `;
      if (parseDates(after, today).dates.length || parseTimes(after).times.length) {
        src = `${base.slice(0, m.index)} `;
        dst = after;
        break;
      }
    }
    const s1 = parseDates(src, today, 'future');
    const s2 = parseTimes(s1.rest);
    const t1 = parseDates(dst, today, 'future');
    const t2 = parseTimes(t1.rest);
    if (!t1.dates.length && !t2.times.length && !duration) return err('Куда перенести? Скажите день или время: «на пятницу в 17».');
    const lesson = pickLesson(r.student.id, s1.dates, s2.times, 'future', ctx);
    if (!lesson) return err(`Не нашёл урок ${who(r.student)}${s1.dates.length ? ` ${relDay(s1.dates[0].iso, today)}` : ''}${s2.times.length ? ` в ${fmtTime(s2.times[0].min)}` : ''}.`);
    let date = lesson.date;
    if (t1.dates.length) {
      const d = t1.dates[0];
      date = d.iso;
      // «с понедельника на пятницу» — пятница той же недели, что и урок.
      if (d.wdOnly && s1.dates.length) {
        date = addDays(startOfWeek(lesson.date), d.wd);
        if (date < today) date = addDays(date, 7);
      }
    }
    const start = t2.times.length ? fmtTime(t2.times[0].min) : lesson.start;
    const moved = { ...lesson, date, start, duration: duration || lesson.duration, status: 'planned' };
    if (moved.date === lesson.date && moved.start === lesson.start && moved.duration === lesson.duration) return err('Урок уже стоит на это время.');
    return {
      kind: 'action', title: 'Перенос',
      lines: [`${who(r.student)}: ${lessonLabel(lesson, today)} → ${lessonLabel(moved, today)}${duration ? `, ${duration} мин` : ''}`],
      warn: conflictWarn(moved, ctx, [lesson.id]), ops: [{ put: ['lessons', moved] }], nav: { date },
    };
  },

  shift(norm, ctx, today) {
    const r = studentOrError(norm, ctx);
    if (r.error) return r.error;
    const { delta, rest } = parseShift(norm);
    const d = parseDates(rest, today, 'future');
    const t = parseTimes(d.rest);
    const lesson = pickLesson(r.student.id, d.dates, t.times, 'future', ctx);
    if (!lesson) return err(`Не нашёл ближайший урок ${who(r.student)}.`);
    const min = toMin(lesson.start) + delta;
    if (min < 0 || min + lesson.duration > 24 * 60) return err('Получается за пределами дня.');
    const moved = { ...lesson, start: fmtTime(min) };
    return {
      kind: 'action', title: 'Сдвиг',
      lines: [`${who(r.student)}: ${lessonLabel(lesson, today)} → ${moved.start}`],
      warn: conflictWarn(moved, ctx, [lesson.id]), ops: [{ put: ['lessons', moved] }], nav: { date: lesson.date },
    };
  },

  cancel(norm, ctx, today, { remove = false } = {}) {
    const d = parseDates(norm, today, 'future');
    const t = parseTimes(d.rest);
    const found = findStudents(norm, ctx.students);
    const verb = remove ? 'Удалить' : 'Отменить';
    // «отмени всё завтра» — все уроки дня.
    if (!found.length && d.dates.length) {
      const day = ctx.lessons.filter((l) => l.date === d.dates[0].iso && l.status !== 'cancelled').sort(sortLessons);
      if (!day.length) return err(`${relDay(d.dates[0].iso, today)} уроков нет.`);
      const byId = new Map(ctx.students.map((s) => [s.id, s]));
      return {
        kind: 'action', title: `${verb} все уроки ${relDay(d.dates[0].iso, today)}`,
        lines: day.map((l) => `${byId.get(l.studentId)?.name || '—'} в ${l.start}`), warn: [],
        ops: day.map((l) => (remove ? { del: ['lessons', l.id] } : { put: ['lessons', { ...l, status: 'cancelled' }] })), nav: { date: d.dates[0].iso },
      };
    }
    const r = studentOrError(norm, ctx);
    if (r.error) return r.error;
    const lesson = pickLesson(r.student.id, d.dates, t.times, 'future', ctx);
    if (!lesson) return err(`Не нашёл урок ${who(r.student)}${d.dates.length ? ` ${relDay(d.dates[0].iso, today)}` : ''}.`);
    return {
      kind: 'action', title: remove ? 'Удалить урок' : 'Отмена урока',
      lines: [`${who(r.student)}: ${lessonLabel(lesson, today)}${remove ? '' : ' — не оплачивается'}`], warn: [],
      ops: [remove ? { del: ['lessons', lesson.id] } : { put: ['lessons', { ...lesson, status: 'cancelled' }] }], nav: { date: lesson.date },
    };
  },

  remove(norm, ctx, today) {
    return HANDLERS.cancel(norm, ctx, today, { remove: true });
  },

  missed(norm, ctx, today) {
    return markPast(norm, ctx, today, 'missed', 'Пропуск', ' — пропуск, оплачивается');
  },

  done(norm, ctx, today) {
    return markPast(norm, ctx, today, 'done', 'Урок проведён', ' — проведён');
  },

  payment(norm, ctx, today) {
    const r = studentOrError(norm, ctx);
    if (r.error) return r.error;
    const d = parseDates(norm, today, 'past');
    const a = amountFrom(d.rest, r.student, today);
    if (a?.count && !priceAt(r.student, today)) return err(`${who(r.student)}: цена урока не задана. Назовите сумму или сначала задайте цену («цена 1500»).`);
    if (!a || !a.amount) return err('Сколько оплачено? Скажите сумму или число занятий.');
    const p = { id: uid(), studentId: r.student.id, date: d.dates[0]?.iso || today, amount: a.amount, note: a.count ? `за ${lessonsWord(a.count)}` : '', createdAt: Date.now() };
    const after = studentStats(r.student, ctx.lessons, [...ctx.payments, p], ctx.now);
    return {
      kind: 'action', title: 'Оплата',
      lines: [`${who(r.student)}: ${formatRub(p.amount)}${a.count ? ` (${lessonsWord(a.count)})` : ''}, ${relDay(p.date, today)}`, `После оплаты: ${balanceText(after)}`],
      warn: [], ops: [{ put: ['payments', p] }],
    };
  },

  price(norm, ctx, today) {
    const r = studentOrError(norm, ctx);
    if (r.error) return r.error;
    const nums = [...norm.matchAll(/\s(\d+)(?=\s)/g)].map((x) => Number(x[1])).filter((n) => n >= 50);
    if (!nums.length) return err('Какая цена? Например: «цена для Маши 1800».');
    const price = Math.max(...nums);
    const old = priceAt(r.student, today);
    return {
      kind: 'action', title: 'Цена урока',
      lines: [`${who(r.student)}: ${formatRub(old)} → ${formatRub(price)} за урок`, 'С сегодняшнего дня; прошедшие уроки остаются по старой цене'],
      warn: [], ops: [{ put: ['students', withPrice(r.student, price, today)] }],
    };
  },

  series(norm, ctx, today) {
    const r = studentOrError(norm, ctx, { allowNew: true, after: /^(запиш\S*|добав\S*|постав\S*|назнач\S*|урок\S*|заняти\S*|для|с|у)$/ });
    if (r.error) return r.error;
    return makeSeries(norm, ctx, today, r, { title: 'Регулярные уроки' });
  },

  newStudent(norm, ctx, today) {
    const name = unknownName(norm, /^(ученик\S*|учениц\S*|студент\S*)$/);
    if (!name) return err('Как зовут ученика? Например: «новый ученик Петя, цена 2000».');
    const exists = ctx.students.find((s) => !s.archived && s.name.toLowerCase() === name.toLowerCase());
    if (exists) return err(`${name} уже есть в списке.`);
    const { duration, rest } = parseDuration(norm);
    const nums = [...rest.matchAll(/\s(\d+)(?=\s)/g)].map((x) => Number(x[1])).filter((n) => n >= 100);
    const price = nums.length ? Math.max(...nums) : ctx.settings.price;
    const student = {
      id: uid(), name, aliases: '', color: nextColor(ctx.students), duration: duration || ctx.settings.duration,
      prices: [{ from: '2000-01-01', price }], note: '', archived: false, createdAt: Date.now(),
    };
    const hasDays = parseDates(norm, today).dates.some((d) => d.wd !== undefined);
    if (hasDays && parseTimes(parseDates(rest, today).rest).times.length) {
      return makeSeries(norm, ctx, today, { student, isNew: true }, { title: 'Новый ученик' });
    }
    return {
      kind: 'action', title: 'Новый ученик',
      lines: [`${name}: ${formatRub(price)} за урок, ${student.duration} мин`], warn: [],
      ops: [{ put: ['students', student] }], newStudent: student,
    };
  },

  stop(norm, ctx, today) {
    // «отмени все уроки завтра» — это отмена дня, а не остановка расписания.
    if (parseDates(norm, today).dates.length) return HANDLERS[RX.remove.test(norm) ? 'remove' : 'cancel'](norm, ctx, today);
    const r = studentOrError(norm, ctx);
    if (r.error) return r.error;
    const now = ctx.now;
    const future = ctx.lessons.filter((l) => l.studentId === r.student.id && statusOf(l, now) === 'planned' && lessonStart(l) > now);
    const series = ctx.series.filter((s) => s.studentId === r.student.id && (!s.until || s.until >= today));
    if (!future.length && !series.length) return err(`У ${who(r.student)} нет будущих уроков.`);
    const ops = [
      ...series.map((s) => ({ put: ['series', { ...s, until: today }] })),
      ...future.map((l) => ({ del: ['lessons', l.id] })),
    ];
    return {
      kind: 'action', title: 'Убрать будущие уроки',
      lines: [`${who(r.student)}: удалить ${lessonsWord(future.length)} впереди${series.length ? ', остановить расписание' : ''}`, 'Прошедшие уроки и оплаты сохранятся'],
      warn: [], ops,
    };
  },
};

function markPast(norm, ctx, today, status, title, suffix) {
  const r = studentOrError(norm, ctx);
  if (r.error) return r.error;
  const d = parseDates(norm, today, 'past');
  const t = parseTimes(d.rest);
  const lesson = pickLesson(r.student.id, d.dates, t.times, 'past', ctx);
  if (!lesson) return err(`Не нашёл урок ${who(r.student)}${d.dates.length ? ` ${relDay(d.dates[0].iso, today)}` : ''}.`);
  return {
    kind: 'action', title, lines: [`${who(r.student)}: ${lessonLabel(lesson, today)}${suffix}`], warn: [],
    ops: [{ put: ['lessons', { ...lesson, status }] }], nav: { date: lesson.date },
  };
}

function makeSeries(norm, ctx, today, r, { title }) {
  const { duration, rest: r1 } = parseDuration(norm);
  const { dates, rest: r2 } = parseDates(r1, today);
  const days = [...new Set(dates.filter((d) => d.wd !== undefined).map((d) => d.wd))].sort();
  const { times } = parseTimes(r2);
  if (!days.length) return err('По каким дням? Например: «каждый вторник и четверг в 17».');
  if (!times.length) return err('Во сколько? Например: «по средам в 16:30».');
  const dur = duration || r.student.duration || ctx.settings.duration;
  const series = { id: uid(), studentId: r.student.id, days, start: fmtTime(times[0].min), duration: dur, from: today, until: null, generatedUntil: null };
  // Уроки на сегодня, время которых прошло, не создаём.
  const ext = extendSeries(series, today);
  const lessons = ext.lessons.filter((l) => lessonStart(l) > ctx.now);
  const ops = [{ put: ['series', ext.series] }, ...lessons.map((l) => ({ put: ['lessons', l] }))];
  if (r.isNew) ops.unshift({ put: ['students', r.student] });
  const warn = [];
  for (const l of lessons.slice(0, 14)) warn.push(...conflictWarn(l, ctx).map((w) => `${relDay(l.date, today)}: ${w}`));
  return {
    kind: 'action', title,
    lines: [
      ...(r.isNew ? [`${r.student.name}: ${formatRub(priceAt(r.student, today))} за урок`] : []),
      `${who(r.student)}: ${days.map((d) => WD_SHORT[d].toLowerCase()).join(', ')} в ${series.start}, ${dur} мин`,
      `Создам ${lessonsWord(lessons.length)} на ${Math.round(70 / 7)} недель вперёд, дальше — автоматически`,
    ],
    warn: warn.slice(0, 3), ops, newStudent: r.isNew ? r.student : null, nav: lessons[0] ? { date: lessons[0].date } : null,
  };
}

/* ---------- Текст с картинки → команды ---------- */

/** Чистим распознанный скриншот переписки: строка статуса, время отправки, галочки. */
export function cleanOcrText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l
      .replace(/\s*[✓✔√]+\s*$/u, '')
      // время отправки в конце пузыря: «Спасибо 10:05», «…на 18:00? 19:31». Время после «в/на/к/до…» — часть фразы, его оставляем.
      .replace(/(^|\s)(?<!(?:^|\s)(?:в|во|на|к|ко|до|с|со|около|после|часов)\s)\d{1,2}:\d{2}\s*[/\\vV✓✔√]{0,3}\s*$/iu, '')
      .trim())
    // строка статуса телефона и пустые обрывки: в них нет слов из 3+ русских букв
    .filter((l) => l && /[а-яё]{3,}/i.test(l) && !/^\d{1,2}:\d{2}\s.{0,20}$/.test(l) || /[а-яё]{3,}.*[а-яё]{3,}/i.test(l))
    .join('\n');
}

/** Делим на фразы: по концу предложения и по пустым строкам; короткие обрывки строк склеиваем. */
function chunks(text) {
  return text
    .replace(/\n{2,}/g, ' ¶ ')
    .replace(/([^.!?¶ ])\n/g, '$1 ')
    .split(/(?<=[.!?])\s+|\s*¶\s*|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

/**
 * Ищет в тексте команды. Если во фразе нет имени, берём имя из предыдущих фраз.
 * Результат: [{text, result}] только с понятыми действиями/ответами, без повторов.
 */
export function findCommands(text, ctx) {
  const clean = cleanOcrText(text);
  const out = [];
  const seen = new Set();
  let lastName = null;
  const push = (t, r) => {
    const key = r.kind === 'action' ? JSON.stringify(r.ops.map((o) => (o.put ? [o.put[0], o.put[1].id, o.put[1].date, o.put[1].start, o.put[1].status, o.put[1].amount] : o.del))) : r.text;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: t, result: r });
  };
  const list = chunks(clean);
  const today = toISO(ctx.now);
  for (let i = 0; i < list.length; i++) {
    let c = list[i];
    const norm = normalize(c);
    const found = findStudents(norm, ctx.students);
    // «Маша заболела. В понедельник не придём» — день во второй фразе: склеиваем.
    const next = list[i + 1];
    if (next && detectIntent(norm) && !parseDates(norm, today).dates.length && !parseTimes(norm).times.length
      && !findStudents(normalize(next), ctx.students).length
      && (parseDates(normalize(next), today).dates.length || parseTimes(normalize(next)).times.length)) {
      c = `${c} ${next}`;
      i++;
    }
    let phrase = c;
    if (found.length) lastName = found[0].student.name;
    else if (lastName) phrase = `${lastName} ${c}`;
    if (!detectIntent(normalize(phrase))) continue;
    const r = interpret(phrase, ctx);
    if (r.kind === 'error' || (r.kind === 'action' && r.newStudent && !found.length)) continue;
    push(c, r);
  }
  return { clean, items: out };
}

/* ---------- Скриншот расписания/календаря → уроки ---------- */

const MON_RE = /(\d{1,2})\s+(янв|фев|мар|апр|ма[яй]|июн|июл|авг|сен|окт|ноя|дек)[а-я]*\.?(?:\s+(\d{4}))?/i;
const MON_KEYS = ['янв', 'фев', 'мар', 'апр', 'ма', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const RANGE_RE = /(\d{1,2})[:.](\d{2})\s*[—–-]+\s*(\d{1,2})[:.](\d{2})/;
const NOT_TITLE = /^(сегодня|завтра|вчера|январ|феврал|март|апрел|май|мая|июн|июл|август|сентябр|октябр|ноябр|декабр|понедельник|вторник|сред|четверг|пятниц|суббот|воскресен|расписание|все|календар|входящие)/i;

const lineText = (l) => (typeof l === 'string' ? l : l.text || '');

/**
 * Ищет на скриншоте календаря/расписания уроки: «16:00 … Тимофей», «Саша © 17:00 — 18:00».
 * lines — строки OCR (с box, если есть: время начала тогда считается по положению на экране) или просто строки текста.
 * Возвращает [{text, result, on, exists}] в том же виде, что findCommands.
 */
export function findSchedule(lines, ctx, fallbackDate, forceDate) {
  const all = lines.map(lineText).join('\n');
  const today = toISO(ctx.now);
  // Дата из заголовка «Пятница — 13 нояб. 2026 г.»
  let date = null;
  const dm = all.match(MON_RE);
  if (dm) {
    const mon = MON_KEYS.findIndex((k) => dm[2].toLowerCase().startsWith(k));
    const d = new Date(dm[3] ? Number(dm[3]) : ctx.now.getFullYear(), mon, Number(dm[1]));
    if (d.getMonth() === mon) date = toISO(d);
  }
  if (forceDate) date = forceDate;
  if (!date) {
    const wd = parseDates(normalize(all.split('\n').find((l) => WD_RE.test(` ${l.toLowerCase()} `)) || ''), today).dates[0];
    date = wd?.iso || fallbackDate || today;
  }

  // Сетка часов по меткам «16:00» слева (только если есть координаты).
  const grid = lines.filter((l) => l.box && /^\d{1,2}:00$/.test(lineText(l).trim())).map((l) => ({ y: (l.box.y0 + l.box.y1) / 2, h: Number(lineText(l).split(':')[0]) }));
  let pxPerHour = 0;
  if (grid.length >= 2) {
    const a = grid[0];
    const b = grid[grid.length - 1];
    if (b.h !== a.h) pxPerHour = (b.y - a.y) / (b.h - a.h);
  }
  const timeAtY = (y) => {
    if (!pxPerHour) return null;
    const hours = grid[0].h + (y - grid[0].y) / pxPerHour;
    return Math.max(0, Math.round(hours * 2) * 30); // по верху заголовка, с точностью до получаса
  };

  const items = [];
  let lastHour = null;
  let pending = null;
  const sorted = lines.some((l) => l.box) ? [...lines].sort((p, q) => p.box.y0 - q.box.y0 || p.box.x0 - q.box.x0) : lines;
  for (const l of sorted) {
    const raw = lineText(l).trim();
    if (!raw) continue;
    const hourOnly = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (hourOnly) { lastHour = Number(hourOnly[1]) * 60 + Number(hourOnly[2]); continue; }
    const range = raw.match(RANGE_RE);
    const title = raw.replace(RANGE_RE, ' ').replace(/^[^A-Za-zА-Яа-яЁё]+/, '').replace(/[^A-Za-zА-Яа-яЁё'’\s-]+$/, '').trim();
    if (/^[©@®]/.test(raw) || !title || title.length < 3 || NOT_TITLE.test(title) || MON_RE.test(raw)) {
      // Строка только со временем «© 17:00 — 18:00» — уточняет предыдущее событие.
      if (range && pending && !pending.ranged) {
        pending.start = Number(range[1]) * 60 + Number(range[2]);
        pending.end = Number(range[3]) * 60 + Number(range[4]);
        pending.ranged = true;
      }
      continue;
    }
    const inline = raw.match(/(\d{1,2}):(\d{2})/);
    let start = null;
    let end = null;
    if (range) { start = Number(range[1]) * 60 + Number(range[2]); end = Number(range[3]) * 60 + Number(range[4]); }
    else if (inline && !l.box) start = Number(inline[1]) * 60 + Number(inline[2]);
    else if (l.box) start = timeAtY(l.box.y0) ?? lastHour;
    else start = lastHour;
    pending = { title, start, end, ranged: Boolean(range) };
    items.push(pending);
  }

  const out = [];
  const when = (t) => `${dayTitle(date)} в ${t}`;
  for (const it of items) {
    if (it.start === null) continue;
    const found = findStudents(normalize(it.title.replace(/['’`]\S*/g, ' ')), ctx.students)[0]; // «Diana's class» → Diana
    const startT = fromMin(it.start);
    if (found) {
      const s = found.student;
      const duration = it.end > it.start ? it.end - it.start : s.duration || ctx.settings.duration;
      // Тот же урок, если время совпадает с точностью до 20 минут (по картинке время оценивается примерно).
      const same = ctx.lessons.find((x) => x.studentId === s.id && x.date === date && x.status !== 'cancelled'
        && Math.abs(toMin(x.start) - it.start) <= (it.ranged ? 0 : 20));
      const lesson = { id: uid(), studentId: s.id, date, start: startT, duration, status: 'planned', price: null, seriesId: null, note: '' };
      if (same) {
        // Отмечать не нужно, но если в приложении его всё-таки нет — можно добавить галочкой.
        out.push({ text: it.title, exists: true, on: false, result: { kind: 'action', title: 'Уже есть в календаре', lines: [`${s.name}: ${when(same.start)}`], warn: [], ops: [{ put: ['lessons', lesson] }], nav: { date } } });
        continue;
      }
      // Есть урок этого ученика в тот же день, но в другое время — значит, перенос.
      const other = ctx.lessons.find((x) => x.studentId === s.id && x.date === date && x.status !== 'cancelled');
      const result = other
        ? { kind: 'action', title: 'Другое время?', lines: [`${s.name}: ${dayTitle(date)}, ${other.start} → ${startT}`], warn: conflictWarn({ ...other, start: startT, duration }, ctx, [other.id]), ops: [{ put: ['lessons', { ...other, start: startT, duration }] }], nav: { date } }
        : { kind: 'action', title: 'Новый урок', lines: [`${s.name}: ${when(startT)}, ${duration} мин`], warn: conflictWarn(lesson, ctx), ops: [{ put: ['lessons', lesson] }], nav: { date } };
      out.push({ text: it.title, on: !other, result }); // перенос по картинке — только если отметить вручную
    } else if (/^[А-ЯЁ][а-яё]{2,}(\s+[А-ЯЁа-яё][а-яё]{2,}){0,2}$/.test(it.title) && it.start >= 6 * 60) {
      const student = {
        id: uid(), kind: 'student', name: it.title, aliases: '', color: nextColor(ctx.students), duration: ctx.settings.duration,
        prices: [{ from: '2000-01-01', price: 0 }], note: '', archived: false, createdAt: Date.now(),
      };
      const duration = it.end > it.start ? it.end - it.start : ctx.settings.duration;
      const lesson = { id: uid(), studentId: student.id, date, start: startT, duration, status: 'planned', price: null, seriesId: null, note: '' };
      out.push({
        text: it.title, on: false,
        result: { kind: 'action', title: 'Новый ученик?', lines: [`«${it.title}»: ${when(startT)}, ${duration} мин`, 'Нет в списке учеников — отметьте, если это урок'], warn: [], ops: [{ put: ['students', student] }, { put: ['lessons', lesson] }], nav: { date } },
      });
    }
  }
  return { date, items: out };
}

export const EXAMPLES = [
  'Перенеси Машу с четверга на пятницу в 17',
  'Петя завтра на час позже',
  'Запиши Аню на субботу в 11:30 на 90 минут',
  'Отмени урок Маши в пятницу',
  'Маша оплатила 4 занятия',
  'Петя перевёл 6000',
  'Цена для Маши 1800',
  'Новый ученик Костя, цена 2000',
  'Костя каждый вторник и четверг в 18',
  'Петя вчера не пришёл',
  'Сколько должна Маша?',
  'Отмени все уроки завтра',
];

/* ---------- Распознавание речи (если браузер умеет) ---------- */

export const speechSupported = () => Boolean(globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition);

export function listen({ onText, onEnd, onError }) {
  const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  const rec = new SR();
  rec.lang = 'ru-RU';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    onText((finalText + interim).trim(), false);
  };
  rec.onerror = (e) => onError?.(e.error);
  rec.onend = () => onEnd?.(finalText.trim());
  rec.start();
  return rec;
}

export { plural };
