'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');

const PARTS = [
  { id: 'chest', name: '胸', color: '#e5484d' },
  { id: 'back', name: '背中', color: '#3e7bfa' },
  { id: 'shoulder', name: '肩', color: '#f0a020' },
  { id: 'arm', name: '腕', color: '#8e4ec6' },
  { id: 'leg', name: '脚', color: '#30a46c' },
  { id: 'abs', name: '腹', color: '#12a5a5' },
  { id: 'cardio', name: '有酸素', color: '#d6409f' },
];
const PART = Object.fromEntries(PARTS.map(p => [p.id, p]));
const partOf = id => PART[id] || { id, name: '?', color: '#999' };
const CACHE_PREFIX = 'workout-log-v'; // sw.js と同じ
const KINDS = { weight: '重さ×回数', reps: '回数のみ', time: '時間（秒）', cardio: '時間・距離' };
const WD = '日月火水木金土';

/* ---------- 共通 ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const today = () => ymd(new Date());
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(parseYmd(s)) === s;
const fmtDate = s => { const d = parseYmd(s); return `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`; };
const fmtShort = s => { const d = parseYmd(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
const num = v => {
  const s = String(v ?? '').normalize('NFKC').trim();
  if (!s) return '';
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : '';
};
// データの大きさ（UTF-8でのバイト数）と表示用の単位
const jsonBytes = v => (Array.isArray(v) && !v.length ? 0 : new Blob([JSON.stringify(v)]).size);
const fmtSize = b => (b === 0 ? "0KB" : b < 1024 * 1024 ? `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)}KB` : `${(b / 1024 / 1024).toFixed(1)}MB`);
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

function setHeader(title, actions = '') {
  $('#title').textContent = title;
  $('#actions').innerHTML = actions;
}
function setTab(name) {
  $$('.tabbar a').forEach(a => a.classList.toggle('on', a.dataset.tab === name));
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------- セット ---------- */
const blankSet = kind => ({ weight: { w: '', r: '' }, reps: { r: '' }, time: { s: '' }, cardio: { min: '', km: '' } }[kind] || { w: '', r: '' });
const isFilled = s => Object.values(s).some(v => v !== '' && v != null);
function setText(kind, s) {
  const v = x => (x === '' || x == null ? '-' : x);
  if (kind === 'weight') return `${v(s.w)}kg×${v(s.r)}回`;
  if (kind === 'reps') return `${v(s.r)}回`;
  if (kind === 'time') return `${v(s.s)}秒`;
  return [s.min !== '' ? `${s.min}分` : '', s.km !== '' ? `${s.km}km` : ''].filter(Boolean).join(' ') || '-';
}
// 同じ内容が続くセットはまとめる：「60kg×10回（3セット）」
function setsSummary(e) {
  const texts = (e.sets || []).filter(isFilled).map(s => setText(e.kind, s));
  const out = [];
  for (const t of texts) {
    const last = out[out.length - 1];
    if (last && last.t === t) last.k++;
    else out.push({ t, k: 1 });
  }
  return out.map(({ t, k }) => (k > 1 ? `${t}（${k}セット）` : t)).join('、') || '（未入力）';
}
const volume = e => (e.kind === 'weight' ? (e.sets || []).reduce((a, s) => a + (Number(s.w) || 0) * (Number(s.r) || 0), 0) : 0);

/* ---------- 保存待ちの記録（入力中は少し待ってまとめて保存） ---------- */
const pending = new Map();
let saveTimer;
function queueSave(store, rec, key) {
  pending.set(`${store}:${key}`, { store, rec });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaves, 400);
}
async function flushSaves() {
  clearTimeout(saveTimer);
  const jobs = [...pending.values()];
  pending.clear();
  await Promise.all(jobs.map(({ store, rec }) => (rec === null ? Promise.resolve() : DB.put(store, rec))));
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSaves(); });

/* ---------- カレンダー ---------- */
const cal = { y: null, m: null, sel: null };

async function renderCalendar() {
  setTab('cal');
  setHeader('カレンダー');
  const t = today();
  if (cal.y === null) { const d = new Date(); cal.y = d.getFullYear(); cal.m = d.getMonth(); cal.sel = t; }
  const [entries, days] = await Promise.all([DB.all('entries'), DB.all('days')]);
  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const memoOf = Object.fromEntries(days.map(d => [d.date, d.memo]));
  const partsOn = date => PARTS.filter(p => (byDate.get(date) || []).some(e => e.part === p.id));

  const { y, m } = cal;
  const firstWd = new Date(y, m, 1).getDay();
  const nDays = new Date(y, m + 1, 0).getDate();
  let cells = '<span class="cal-cell empty"></span>'.repeat(firstWd);
  for (let d = 1; d <= nDays; d++) {
    const ds = `${y}-${pad(m + 1)}-${pad(d)}`;
    const ps = partsOn(ds);
    const wd = (firstWd + d - 1) % 7;
    const cls = ['cal-cell', ds === t && 'today', ds === cal.sel && 'sel', ds > t && 'future', ps.length && 'done', wd === 0 && 'sun', wd === 6 && 'sat'].filter(Boolean).join(' ');
    cells += `<button class="${cls}" data-date="${ds}" aria-label="${m + 1}月${d}日${ps.length ? '：' + ps.map(p => p.name).join('・') : ''}">
      <span class="n">${d}</span><span class="dots">${ps.map(p => `<i style="background:${p.color}"></i>`).join('')}</span></button>`;
  }

  // 集計：この月の日数 / 今週（日〜土）の日数 / 連続日数（今日か昨日から遡る）
  const prefix = `${y}-${pad(m + 1)}-`;
  const monthCount = [...byDate.keys()].filter(k => k.startsWith(prefix)).length;
  const sunday = addDays(t, -parseYmd(t).getDay());
  let weekCount = 0;
  for (let i = 0; i < 7; i++) { const ds = addDays(sunday, i); if (ds <= t && byDate.has(ds)) weekCount++; }
  let streak = 0;
  for (let cur = byDate.has(t) ? t : addDays(t, -1); byDate.has(cur); cur = addDays(cur, -1)) streak++;

  view.innerHTML = `
    <div class="stats">
      <div><b>${monthCount}</b><span>${m + 1}月の日数</span></div>
      <div><b>${weekCount}</b><span>今週</span></div>
      <div><b>${streak}</b><span>連続</span></div>
    </div>
    <div class="cal">
      <div class="cal-head">
        <button class="icon-btn" id="prevM" aria-label="前の月">‹</button>
        <strong>${y}年${m + 1}月</strong>
        <button class="icon-btn" id="nextM" aria-label="次の月">›</button>
        <button class="text-btn" id="thisM">今日</button>
      </div>
      <div class="cal-grid wd">${[...WD].map((w, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}</div>
      <div class="cal-grid" id="grid">${cells}</div>
      <div class="legend">${PARTS.map(p => `<span><i style="background:${p.color}"></i>${p.name}</span>`).join('')}</div>
    </div>
    <section class="day-detail" id="detail"></section>`;

  const drawDetail = () => {
    const ds = cal.sel;
    const list = (byDate.get(ds) || []).slice().sort(byOrder);
    const memo = memoOf[ds];
    $('#detail').innerHTML = `
      <div class="dd-head">
        <h3>${fmtDate(ds)}</h3>
        <a class="btn primary small" href="#/day/${ds}">${list.length || memo ? '編集' : '記録する'}</a>
      </div>
      ${list.length ? `<ul class="sum-list">${list.map(e => `
        <li><i class="dot" style="background:${partOf(e.part).color}"></i>
          <div><div class="ex-name">${esc(e.name)}</div><div class="muted small">${esc(setsSummary(e))}</div></div></li>`).join('')}</ul>`
        : '<p class="muted">この日の記録はありません</p>'}
      ${memo ? `<p class="memo">${esc(memo)}</p>` : ''}`;
  };
  drawDetail();

  $('#grid').addEventListener('click', e => {
    const b = e.target.closest('.cal-cell[data-date]');
    if (!b) return;
    cal.sel = b.dataset.date;
    $$('.cal-cell.sel').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
    drawDetail();
  });
  const move = delta => {
    cal.m += delta;
    if (cal.m < 0) { cal.m = 11; cal.y--; }
    if (cal.m > 11) { cal.m = 0; cal.y++; }
    renderCalendar();
  };
  $('#prevM').addEventListener('click', () => move(-1));
  $('#nextM').addEventListener('click', () => move(1));
  $('#thisM').addEventListener('click', () => { cal.y = null; renderCalendar(); });
}

/* ---------- 1日の記録 ---------- */
function setRow(kind, s, i) {
  const f = (cls, val, mode, unit) =>
    `<input class="${cls}" inputmode="${mode}" value="${esc(val)}" placeholder="0" aria-label="${unit}"><span class="u">${unit}</span>`;
  let inner;
  if (kind === 'weight') inner = f('w', s.w, 'decimal', 'kg') + '<span class="x">×</span>' + f('r', s.r, 'numeric', '回');
  else if (kind === 'reps') inner = f('r', s.r, 'numeric', '回');
  else if (kind === 'time') inner = f('s', s.s, 'numeric', '秒');
  else inner = f('min', s.min, 'decimal', '分') + f('km', s.km, 'decimal', 'km');
  return `<div class="set"><span class="no">${i + 1}</span>${inner}<button type="button" class="icon-btn del-set" aria-label="${i + 1}セット目を削除">×</button></div>`;
}

function entryCard(e, prev) {
  const p = partOf(e.part);
  const vol = volume(e);
  return `
    <div class="entry" data-id="${esc(e.id)}" style="--part:${p.color}">
      <div class="entry-head">
        <span class="ptag">${esc(p.name)}</span>
        <strong>${esc(e.name)}</strong>
        <button type="button" class="text-btn danger del-entry">削除</button>
      </div>
      <div class="sets">${(e.sets || []).map((s, i) => setRow(e.kind, s, i)).join('')}</div>
      <div class="entry-foot">
        <button type="button" class="btn secondary small add-set">＋ セット</button>
        <span class="vol muted small">${vol ? `合計 ${vol.toLocaleString()}kg` : ''}</span>
      </div>
      ${prev ? `<p class="prev muted small">前回 ${fmtShort(prev.date)}：${esc(setsSummary(prev))}</p>` : ''}
    </div>`;
}

// 指定日より前で、いちばん新しい同じ種目の記録
async function prevOf(exerciseId, date) {
  const list = await DB.byIndex('entries', 'exerciseId', exerciseId);
  return list.filter(e => e.date < date).sort((a, b) => b.date.localeCompare(a.date) || b.order - a.order)[0] || null;
}

const pick = { part: 'chest' };

async function renderDay(date) {
  const t = today();
  if (date === 'today') date = t;
  if (!isYmd(date)) { location.replace('#/day/today'); return; }
  setTab(date === t ? 'day' : '');
  setHeader('記録', date !== t ? '<a class="text-btn" href="#/day/today">今日へ</a>' : '');

  const entries = (await DB.byIndex('entries', 'date', date)).sort(byOrder);
  const prevMap = new Map(await Promise.all(entries.map(async e => [e.id, await prevOf(e.exerciseId, date)])));
  const dayRec = await DB.get('days', date);
  const map = new Map(entries.map(e => [e.id, e]));

  view.innerHTML = `
    <div class="day-nav">
      <a class="icon-btn" href="#/day/${addDays(date, -1)}" aria-label="前の日">‹</a>
      <div class="day-title">${fmtDate(date)}${date === t ? '<span class="today-badge">今日</span>' : ''}</div>
      <a class="icon-btn" href="#/day/${addDays(date, 1)}" aria-label="次の日">›</a>
    </div>
    <div id="entries">${entries.map(e => entryCard(e, prevMap.get(e.id))).join('')}</div>
    ${entries.length ? '' : '<p class="empty" id="emptyMsg">まだ記録がありません。<br>下のボタンから種目を追加しましょう。</p>'}
    <button class="btn primary wide" id="addEx">＋ 種目を追加</button>
    <label class="field memo-field"><span>メモ</span>
      <textarea id="memo" rows="2" placeholder="体調・気づいたことなど">${esc(dayRec?.memo)}</textarea>
    </label>`;

  const box = $('#entries');
  const readCard = card => {
    const e = map.get(card.dataset.id);
    e.sets = $$('.set', card).map(row => Object.fromEntries($$('input', row).map(inp => [inp.className, num(inp.value)])));
    return e;
  };
  const refreshCard = (card, focusLast) => {
    const e = map.get(card.dataset.id);
    const tmp = document.createElement('div');
    tmp.innerHTML = entryCard(e, prevMap.get(e.id));
    const fresh = tmp.firstElementChild;
    card.replaceWith(fresh);
    if (focusLast) $$('.set', fresh).at(-1)?.querySelector('input')?.focus();
  };

  box.addEventListener('input', ev => {
    const card = ev.target.closest('.entry');
    if (!card) return;
    const e = readCard(card);
    const vol = volume(e);
    $('.vol', card).textContent = vol ? `合計 ${vol.toLocaleString()}kg` : '';
    queueSave('entries', e, e.id);
  });
  box.addEventListener('click', async ev => {
    const card = ev.target.closest('.entry');
    if (!card) return;
    const e = map.get(card.dataset.id);
    if (ev.target.closest('.add-set')) {
      readCard(card);
      const last = e.sets.at(-1);
      e.sets.push(last ? { ...last } : blankSet(e.kind));
      refreshCard(card, true);
      queueSave('entries', e, e.id);
    } else if (ev.target.closest('.del-set')) {
      readCard(card);
      const i = $$('.set', card).indexOf(ev.target.closest('.set'));
      e.sets.splice(i, 1);
      refreshCard(card);
      queueSave('entries', e, e.id);
    } else if (ev.target.closest('.del-entry')) {
      if (!confirm(`「${e.name}」の記録を削除しますか？`)) return;
      pending.delete(`entries:${e.id}`);
      await DB.del('entries', e.id);
      map.delete(e.id);
      card.remove();
      toast('削除しました');
    }
  });

  $('#memo').addEventListener('input', ev => {
    queueSave('days', { date, memo: ev.target.value }, date);
  });

  $('#addEx').addEventListener('click', () => openPicker(date, async ex => {
    const prev = await prevOf(ex.id, date);
    // 形式を変えた種目では前回の値を入れない（入れる欄が違うため）
    const usePrev = prev && prev.kind === ex.kind;
    const e = {
      id: uid(), date, exerciseId: ex.id, part: ex.part, name: ex.name, kind: ex.kind,
      sets: usePrev ? prev.sets.filter(isFilled).map(s => ({ ...s })) : [blankSet(ex.kind)],
      order: Date.now(),
    };
    if (!e.sets.length) e.sets = [blankSet(ex.kind)];
    await DB.put('entries', e);
    map.set(e.id, e);
    prevMap.set(e.id, prev);
    $('#emptyMsg')?.remove();
    box.insertAdjacentHTML('beforeend', entryCard(e, prev));
    box.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
}

/* ---------- 種目の選択シート ---------- */
async function openPicker(date, onPick) {
  const [exercises, entries] = await Promise.all([DB.all('exercises'), DB.all('entries')]);
  const lastDone = {};
  for (const e of entries) if (e.date <= date && (!lastDone[e.exerciseId] || e.date > lastDone[e.exerciseId])) lastDone[e.exerciseId] = e.date;
  const doneToday = new Set(entries.filter(e => e.date === date).map(e => e.exerciseId));

  const sheet = document.createElement('div');
  sheet.className = 'sheet-backdrop';
  sheet.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="種目を選ぶ">
      <div class="sheet-head"><strong>種目を選ぶ</strong><button type="button" class="icon-btn close" aria-label="閉じる">×</button></div>
      <div class="chips" id="pickParts">${PARTS.map(p => `<button type="button" class="chip" data-part="${p.id}" style="--part:${p.color}">${p.name}</button>`).join('')}</div>
      <ul class="ex-list" id="pickList"></ul>
      <form class="new-ex" id="pickNew" autocomplete="off">
        <input name="name" placeholder="新しい種目名">
        <select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <button class="btn secondary small" type="submit">追加</button>
      </form>
    </div>`;
  document.body.append(sheet);
  document.body.classList.add('no-scroll');
  const close = () => { sheet.remove(); document.body.classList.remove('no-scroll'); };

  const draw = () => {
    $$('#pickParts .chip', sheet).forEach(c => c.classList.toggle('on', c.dataset.part === pick.part));
    const list = exercises.filter(x => x.part === pick.part).sort(byOrder);
    $('#pickList', sheet).innerHTML = list.map(x => `
      <li><button type="button" data-id="${esc(x.id)}">
        <span>${esc(x.name)}${doneToday.has(x.id) ? '<span class="badge">追加済み</span>' : ''}</span>
        <span class="muted small">${lastDone[x.id] ? `前回 ${fmtShort(lastDone[x.id])}` : ''}</span>
      </button></li>`).join('') || '<li class="muted small pad">この部位の種目はまだありません</li>';
    $('#pickNew [name=kind]', sheet).value = pick.part === 'cardio' ? 'cardio' : 'weight';
  };
  draw();

  sheet.addEventListener('click', async ev => {
    if (ev.target === sheet || ev.target.closest('.close')) { close(); return; }
    const chip = ev.target.closest('.chip');
    if (chip) { pick.part = chip.dataset.part; draw(); return; }
    const item = ev.target.closest('#pickList button[data-id]');
    if (item) {
      const ex = exercises.find(x => x.id === item.dataset.id);
      close();
      await onPick(ex);
    }
  });
  $('#pickNew', sheet).addEventListener('submit', async ev => {
    ev.preventDefault();
    const name = ev.target.name.value.trim();
    if (!name) { toast('種目名を入力してください'); return; }
    let ex = exercises.find(x => x.part === pick.part && x.name === name);
    if (!ex) {
      ex = { id: uid(), part: pick.part, name, kind: ev.target.kind.value, order: Date.now() };
      await DB.put('exercises', ex);
    }
    close();
    await onPick(ex);
  });
}

/* ---------- 集計 ---------- */
const stats = { mode: 'week', anchor: null };
const startOfWeek = s => addDays(s, -parseYmd(s).getDay()); // 日曜始まり
function periodOf(mode, anchor) {
  if (mode === 'week') { const start = startOfWeek(anchor); return { start, end: addDays(start, 6) }; }
  const d = parseYmd(anchor);
  return { start: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), end: ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
}
function shiftPeriod(mode, anchor, n) {
  if (mode === 'week') return addDays(startOfWeek(anchor), 7 * n);
  const d = parseYmd(anchor);
  return ymd(new Date(d.getFullYear(), d.getMonth() + n, 1));
}
const periodLabel = (mode, p) => {
  const d = parseYmd(p.start);
  return mode === 'week' ? `${fmtShort(p.start)}〜${fmtShort(p.end)}` : `${d.getFullYear()}年${d.getMonth() + 1}月`;
};
const fmtNum = n => String(Math.round(n * 10) / 10);
// 回数の合計：重さ×回数・回数のみの種目が対象。時間の種目は合計秒数を出す
const repsOf = e => (e.kind === 'weight' || e.kind === 'reps' ? (e.sets || []).reduce((a, s) => a + (Number(s.r) || 0), 0) : 0);
const secOf = e => (e.kind === 'time' ? (e.sets || []).reduce((a, s) => a + (Number(s.s) || 0), 0) : 0);
const fmtSec = v => { v = Math.round(v); const m = Math.floor(v / 60), s = v % 60; return m ? `${m}分${s ? `${s}秒` : ''}` : `${s}秒`; };
// 形式を変えた種目は別物として集計する（数字の意味が違うため）
const exKey = e => `${e.exerciseId || e.name}|${e.kind}`;

function summarize(list) {
  const out = { days: new Set(list.map(e => e.date)).size, parts: {}, ex: new Map(), cardio: { n: 0, min: 0, km: 0 } };
  for (const e of list) {
    const filled = (e.sets || []).filter(isFilled);
    out.parts[e.part] = (out.parts[e.part] || 0) + filled.length;
    const k = exKey(e);
    let x = out.ex.get(k);
    if (!x) { x = { key: k, name: e.name, part: e.part, kind: e.kind, dates: new Set(), sets: 0, reps: 0, sec: 0, min: 0, km: 0 }; out.ex.set(k, x); }
    x.dates.add(e.date);
    x.sets += filled.length;
    x.reps += repsOf(e);
    x.sec += secOf(e);
    if (e.part === 'cardio') out.cardio.n++;
    if (e.kind === 'cardio') {
      for (const s of filled) {
        const m = Number(s.min) || 0, km = Number(s.km) || 0;
        x.min += m; x.km += km; out.cardio.min += m; out.cardio.km += km;
      }
    }
  }
  return out;
}

async function renderStats() {
  setTab('stats');
  setHeader('集計');
  const t = today();
  if (!stats.anchor) stats.anchor = t;
  const all = await DB.all('entries');
  const inRange = p => all.filter(e => e.date >= p.start && e.date <= p.end);
  const { mode } = stats;
  const cur = periodOf(mode, stats.anchor);
  const prev = periodOf(mode, shiftPeriod(mode, stats.anchor, -1));
  const S = summarize(inRange(cur));
  const prevDays = new Set(inRange(prev).map(e => e.date)).size;
  const prevName = mode === 'week' ? '前の週' : '前の月';
  const sign = n => (n > 0 ? `+${n}` : n < 0 ? `${n}` : '±0');
  const exList = [...S.ex.values()].sort((a, b) => b.sets - a.sets || b.dates.size - a.dates.size);
  const maxPart = Math.max(1, ...PARTS.map(p => S.parts[p.id] || 0));
  const isNextFuture = shiftPeriod(mode, stats.anchor, 1) > t;

  view.innerHTML = `
    <div class="seg" id="modeSeg" role="group" aria-label="集計の期間">
      <button type="button" data-mode="week" class="${mode === 'week' ? 'on' : ''}">週</button>
      <button type="button" data-mode="month" class="${mode === 'month' ? 'on' : ''}">月</button>
    </div>
    <div class="period-nav">
      <button class="icon-btn" id="prevP" aria-label="前の期間">‹</button>
      <strong>${periodLabel(mode, cur)}</strong>
      <button class="icon-btn" id="nextP" aria-label="次の期間" ${isNextFuture ? 'disabled' : ''}>›</button>
    </div>
    <div class="stats one">
      <div><b>${S.days}<small>日</small></b><span>実施日数</span><em>${prevName} ${sign(S.days - prevDays)}日</em></div>
    </div>

    <section class="box sum-box">
      <h3>部位ごと（セット数）</h3>
      <ul class="part-bars">${PARTS.map(p => {
        const v = S.parts[p.id] || 0;
        return `<li><span class="pl">${p.name}</span>
          <span class="track"><i style="width:${v ? Math.max(3, v / maxPart * 100) : 0}%;background:${p.color}"></i></span>
          <span class="pv">${v}</span></li>`;
      }).join('')}</ul>
    </section>

    <section class="box sum-box">
      <h3>種目ごと</h3>
      ${exList.length ? `<ul class="ex-sum">${exList.map(x => {
        const extra = x.kind === 'cardio'
          ? [x.min ? `${fmtNum(x.min)}分` : '', x.km ? `${fmtNum(x.km)}km` : ''].filter(Boolean).join(' ')
          : x.reps ? `${x.reps.toLocaleString()}回` : x.sec ? `合計${fmtSec(x.sec)}` : '';
        return `<li><i class="dot" style="background:${partOf(x.part).color}"></i>
          <span class="nm">${esc(x.name)}</span>
          <span class="nums">${x.dates.size}日・${x.sets}セット${extra ? `・${extra}` : ''}</span></li>`;
      }).join('')}</ul>` : '<p class="muted">この期間の記録はありません</p>'}
    </section>

    <section class="box sum-box">
      <h3>有酸素</h3>
      <p class="cardio-sum">${S.cardio.n
        ? `${S.cardio.n}回${S.cardio.min ? `・${fmtNum(S.cardio.min)}分` : ''}${S.cardio.km ? `・${fmtNum(S.cardio.km)}km` : ''}`
        : '<span class="muted">この期間の記録はありません</span>'}</p>
    </section>`;

  $('#modeSeg').addEventListener('click', ev => {
    const b = ev.target.closest('[data-mode]');
    if (!b || b.dataset.mode === stats.mode) return;
    stats.mode = b.dataset.mode;
    renderStats();
  });
  $('#prevP').addEventListener('click', () => { stats.anchor = shiftPeriod(mode, stats.anchor, -1); renderStats(); });
  $('#nextP').addEventListener('click', () => { if (isNextFuture) return; stats.anchor = shiftPeriod(mode, stats.anchor, 1); renderStats(); });
}

/* ---------- 設定 ---------- */
async function exportData() {
  const [exercises, entries, days] = await Promise.all([DB.all('exercises'), DB.all('entries'), DB.all('days')]);
  const json = JSON.stringify({ app: 'workout-log', version: 1, exportedAt: new Date().toISOString(), exercises, entries, days });
  const name = `workout-${today()}.json`;
  const file = new File([json], name, { type: 'application/json' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: '筋トレ記録のバックアップ' }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function importData(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { throw new Error('JSONファイルとして読み込めませんでした'); }
  if (!data || data.app !== 'workout-log') throw new Error('筋トレ記録のバックアップファイルではありません');
  const arr = x => (Array.isArray(x) ? x : []);
  let n = 0;
  for (const x of arr(data.exercises)) {
    if (x && x.id && x.name && x.part) { await DB.put('exercises', { kind: 'weight', order: Date.now(), ...x }); }
  }
  for (const x of arr(data.entries)) {
    if (x && x.id && isYmd(String(x.date)) && x.name) { await DB.put('entries', { sets: [], order: Date.now(), ...x, sets: arr(x.sets) }); n++; }
  }
  for (const x of arr(data.days)) {
    if (x && isYmd(String(x.date))) await DB.put('days', { date: x.date, memo: String(x.memo ?? '') });
  }
  return n;
}

// バージョンは sw.js が作るキャッシュの名前（workout-log-v<番号>）から読み取る
async function appVersion() {
  try {
    const nums = (await caches.keys()).filter(k => k.startsWith(CACHE_PREFIX)).map(k => Number(k.slice(CACHE_PREFIX.length))).filter(Number.isFinite);
    return nums.length ? String(Math.max(...nums)) : '-';
  } catch { return '-'; }
}

async function renderSettings() {
  setTab('settings');
  setHeader('設定');
  const ver = await appVersion();
  const [exercises, entries, days] = await Promise.all([DB.all('exercises'), DB.all('entries'), DB.all('days')]);
  exercises.sort(byOrder);
  const dates = new Set(entries.map(e => e.date));
  // 使用容量：保存しているデータ（JSON換算）の大きさを合計する
  const totalBytes = jsonBytes(exercises) + jsonBytes(entries) + jsonBytes(days);
  const memoDays = days.filter(d => String(d.memo ?? '').trim()).length;
  view.innerHTML = `
    <section class="settings">
      <div class="box">
        <h3>種目の管理</h3>
        <form class="add-ex" id="addExForm" autocomplete="off">
          <select name="part" aria-label="部位">${PARTS.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}</select>
          <input name="name" placeholder="種目名" aria-label="種目名">
          <select name="kind" aria-label="記録の形式">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <button class="btn primary small" type="submit">追加</button>
        </form>
        <div id="exGroups">${PARTS.map(p => {
          const list = exercises.filter(x => x.part === p.id);
          return `<details>
            <summary><i class="dot" style="background:${p.color}"></i>${p.name}<span class="muted small">（${list.length}）</span></summary>
            <ul class="ex-manage">${list.map(x => `
              <li data-id="${esc(x.id)}"><span class="nm">${esc(x.name)}<small class="muted">${KINDS[x.kind] || ''}</small></span>
                <button type="button" class="text-btn rename">名前変更</button>
                <button type="button" class="text-btn kind-btn">形式変更</button>
                <button type="button" class="text-btn danger remove">削除</button></li>`).join('') || '<li class="muted small">なし</li>'}</ul>
          </details>`;
        }).join('')}</div>
      </div>
      <div class="box">
        <h3>バックアップ</h3>
        <p class="usage">使用容量：約 ${fmtSize(totalBytes)}</p>
        <p class="muted small">（記録 ${entries.length}件 ／ メモ ${memoDays}日分 ／ 種目 ${exercises.length}件）</p>
        <p class="muted">記録した日数：${dates.size}日</p>
        <p class="muted">記録はこの端末の中だけに保存されています。ときどき書き出して、「ファイル」アプリ（iCloud Drive など）に保存しておくと安心です。</p>
        <button class="btn primary wide" id="export">バックアップを書き出す</button>
        <button class="btn secondary wide" id="importBtn">バックアップから読み込む</button>
        <input type="file" id="importFile" accept=".json,application/json" hidden>
      </div>
      <div class="box">
        <h3>アプリについて</h3>
        <p class="muted">バージョン ${esc(ver)}</p>
        <button class="btn secondary wide" id="checkUpdate">更新を確認</button>
      </div>
    </section>`;

  const partSel = $('#addExForm [name=part]');
  partSel.addEventListener('change', () => { $('#addExForm [name=kind]').value = partSel.value === 'cardio' ? 'cardio' : 'weight'; });
  $('#addExForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.target;
    const name = f.name.value.trim();
    if (!name) { toast('種目名を入力してください'); return; }
    if (exercises.some(x => x.part === f.part.value && x.name === name)) { toast('同じ名前の種目がすでにあります'); return; }
    await DB.put('exercises', { id: uid(), part: f.part.value, name, kind: f.kind.value, order: Date.now() });
    toast(`「${name}」を追加しました`);
    await rerender([f.part.value]);
  });
  // 一覧を最新の状態で描き直す（開いている部位とスクロール位置は保つ）
  const rerender = async (alsoOpen = []) => {
    const open = new Set([...$$('#exGroups details')].map((d, i) => (d.open ? PARTS[i].id : null)).filter(Boolean).concat(alsoOpen));
    const y = window.scrollY;
    await renderSettings();
    $$('#exGroups details').forEach((d, i) => { d.open = open.has(PARTS[i].id); });
    window.scrollTo(0, y);
  };
  $('#exGroups').addEventListener('change', async ev => {
    const sel = ev.target.closest('.kind-sel');
    if (!sel) return;
    const ex = exercises.find(x => x.id === sel.closest('li').dataset.id);
    ex.kind = sel.value;
    await DB.put('exercises', ex);
    toast(`「${ex.name}」を「${KINDS[ex.kind]}」に変更しました`);
    await rerender();
  });
  $('#exGroups').addEventListener('click', async ev => {
    const li = ev.target.closest('li[data-id]');
    if (!li) return;
    const ex = exercises.find(x => x.id === li.dataset.id);
    if (ev.target.closest('.rename')) {
      const name = prompt('新しい種目名', ex.name)?.trim();
      if (!name || name === ex.name) return;
      ex.name = name;
      await DB.put('exercises', ex);
      // 過去の記録の表示名もそろえる
      const related = await DB.byIndex('entries', 'exerciseId', ex.id);
      await Promise.all(related.map(e => DB.put('entries', { ...e, name })));
      $('.nm', li).firstChild.textContent = name;
      toast('名前を変更しました');
    } else if (ev.target.closest('.kind-btn')) {
      // 形式の選択欄を表示（選んだ時点で保存）
      if ($('.kind-sel', li)) return;
      li.insertAdjacentHTML('beforeend', `<select class="kind-sel" aria-label="記録の形式">${Object.entries(KINDS).map(([k, v]) =>
        `<option value="${k}" ${k === ex.kind ? 'selected' : ''}>${v}</option>`).join('')}</select>`);
      $('.kind-sel', li).focus();
    } else if (ev.target.closest('.remove')) {
      if (!confirm(`「${ex.name}」を種目の一覧から削除しますか？\n（これまでの記録は残ります）`)) return;
      await DB.del('exercises', ex.id);
      toast('削除しました');
      await rerender(); // 一覧を読み直すので、同じ名前で登録し直せる
    }
  });

  $('#checkUpdate').addEventListener('click', async () => {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) { toast('この環境では更新の確認ができません'); return; }
    try { await reg.update(); } catch { toast('確認できませんでした（オフラインかもしれません）'); return; }
    toast(reg.installing || reg.waiting ? '新しいバージョンを準備しています…' : '最新版です');
  });
  $('#export').addEventListener('click', () => exportData().catch(e => toast('書き出しに失敗しました: ' + e.message)));
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async ev => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const n = await importData(file);
      toast(`${n}件の記録を読み込みました`);
      renderSettings();
    } catch (err) {
      toast(err.message);
    }
  });
}

/* ---------- ルーティング ---------- */
async function route() {
  await flushSaves();
  const [, page = '', arg = ''] = (location.hash.slice(1) || '/').split('/');
  window.scrollTo(0, 0);
  try {
    if (!page) return await renderCalendar();
    if (page === 'day') return await renderDay(decodeURIComponent(arg || 'today'));
    if (page === 'settings') return await renderSettings();
    if (page === 'stats') return await renderStats();
    location.replace('#/');
  } catch (err) {
    console.error(err);
    view.innerHTML = `<p class="empty">エラーが発生しました：${esc(err.message)}</p>`;
  }
}
window.addEventListener('hashchange', route);
route();

/* ---------- 更新の確認とお知らせ ---------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) $('#updateBar').hidden = false;
  });
  $('#updateNow').addEventListener('click', async () => { await flushSaves(); location.reload(); });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(err => console.warn('SW登録失敗', err));
}
navigator.storage?.persist?.().catch(() => {});
