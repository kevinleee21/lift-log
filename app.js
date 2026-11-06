'use strict';

/* =====================================================================
 * CONFIG: change trend thresholds and logging defaults here.
 * GAIN_PCT / DECLINE_PCT can also be changed in the app under Settings.
 * ===================================================================== */
const CONFIG = {
  GAIN_PCT: 2,          // change above +2%  → Gaining
  DECLINE_PCT: -2,      // change below -2%  → Declining (anything between = Maintaining)
  WINDOW: 3,            // average of last 3 sessions vs the 3 before that
  MIN_SESSIONS: 4,      // fewer sessions than this → "Not enough data yet"
  WEIGHT_STEPS: [5, 2.5],
  RECENT_COUNT: 5,
  SYNC_EVERY_MS: 30000, // retry the offline queue this often while sets are pending
};

const MUSCLE_GROUPS = ['Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Core', 'Full body', 'Cardio', 'Other'];
const LOG_COLUMNS = ['date', 'workout_id', 'workout_name', 'exercise', 'set_number', 'weight_lbs', 'reps', 'notes'];

/* ------------------------------------------------------------ storage */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('localStorage', e); } },
};
const K = { settings: 'wt_settings', cache: 'wt_cache', queue: 'wt_queue', active: 'wt_active' };

let settings = Object.assign({ url: '', token: '', gainPct: CONFIG.GAIN_PCT, declinePct: CONFIG.DECLINE_PCT }, LS.get(K.settings, {}));
let server = LS.get(K.cache, { log: [], exercises: [], templates: [], syncedAt: null });
let queue = LS.get(K.queue, []);
let active = LS.get(K.active, null);
let data = null;                       // server data + pending (unsynced) changes
const sync$ = { busy: false, again: false, error: null };
let tplDraft = null;                   // template being edited
let pickerCb = null;

const saveActive = () => LS.set(K.active, active);

/* ------------------------------------------------------------- utils */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s ?? '').trim().toLowerCase();
const clone = (o) => JSON.parse(JSON.stringify(o));
const fmtW = (w) => (w === '' || w == null ? '' : String(Math.round(Number(w) * 100) / 100));
const uid = (p) => p + '_' + Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDate(s, withYear) {
  const [y, m, d] = String(s).split('-').map(Number);
  if (!y) return esc(s);
  const dt = new Date(y, m - 1, d);
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (withYear || y !== new Date().getFullYear()) opts.year = 'numeric';
  return dt.toLocaleDateString(undefined, opts);
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2400);
}
const isFav = (e) => e.is_favorite === true || String(e.is_favorite).toUpperCase() === 'TRUE';

const ICON = {
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  flat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h14M13 7l5 5-5 5"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18" cy="12" r="1.8"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
  lift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 7v10M3 9.5v5M18 7v10M21 9.5v5M6 12h12"/></svg>',
  hist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};

/* =====================================================================
 * Data: server cache + pending queue (offline-first)
 * ===================================================================== */
function applyOp(d, op) {
  const sameSet = (r) => r.workout_id === op.workout_id && r.exercise === op.exercise && Number(r.set_number) === Number(op.set_number);
  const ensureEx = (name, group = '', fav = false) => {
    if (!d.exercises.some((e) => norm(e.exercise) === norm(name))) d.exercises.push({ exercise: name, muscle_group: group, is_favorite: fav });
  };
  switch (op.action) {
    case 'addSets': op.sets.forEach((s) => { d.log.push({ ...s }); ensureEx(s.exercise); }); break;
    case 'updateSet': { const r = d.log.find(sameSet); if (r) Object.assign(r, { weight_lbs: op.weight_lbs, reps: op.reps, notes: op.notes }); break; }
    case 'deleteSet': d.log = d.log.filter((r) => !sameSet(r)); break;
    case 'addExercise': ensureEx(op.exercise, op.muscle_group, !!op.is_favorite); break;
    case 'saveTemplate': {
      const t = { workout_id: op.workout_id, workout_name: op.workout_name, created_date: op.created_date, exercises: op.exercises.map((e, i) => ({ order: i + 1, ...e })) };
      const i = d.templates.findIndex((x) => x.workout_id === op.workout_id);
      if (i >= 0) { t.created_date = d.templates[i].created_date; d.templates[i] = t; } else d.templates.push(t);
      break;
    }
    case 'deleteTemplate': d.templates = d.templates.filter((t) => t.workout_id !== op.workout_id); break;
  }
}
function recompute() {
  data = clone(server);
  queue.forEach((op) => applyOp(data, op));
}
function enqueue(action, payload) {
  const op = { opId: uid('op'), action, ...payload };
  queue.push(op);
  LS.set(K.queue, queue);
  recompute();
  sync({ pull: false });
}

class ApiError extends Error { constructor(msg, kind) { super(msg); this.kind = kind; } }
async function api(action, payload = {}) {
  let res;
  try {
    res = await fetch(settings.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // text/plain avoids a CORS preflight
      body: JSON.stringify({ ...payload, action, token: settings.token }),
      redirect: 'follow',
    });
  } catch { throw new ApiError('No connection', 'net'); }
  let j;
  try { j = await res.json(); } catch { throw new ApiError('Unexpected response. Check the Apps Script URL and that access is set to "Anyone".', 'config'); }
  if (!j.ok) throw new ApiError(j.error || 'Request failed', /unauthor/i.test(j.error) ? 'config' : 'api');
  return j.data;
}

async function sync({ pull = true } = {}) {
  if (!settings.url || !settings.token) { renderPill(); return; }
  if (sync$.busy) { sync$.again = true; return; }
  sync$.busy = true; renderPill();
  try {
    while (queue.length) {
      const op = queue[0];
      try { await api(op.action, op); }
      catch (e) {
        if (e.kind !== 'api') throw e;
        // The server rejected this change (e.g. set already deleted). Drop it so the queue isn't stuck.
        console.warn('Dropped change', op, e);
        toast(`A change couldn't be saved: ${e.message}`);
      }
      queue.shift();
      LS.set(K.queue, queue);
      pull = true;
    }
    if (pull) {
      const [log, exercises, templates] = await Promise.all([api('getLog'), api('getExercises'), api('getTemplates')]);
      server = { log, exercises, templates, syncedAt: Date.now() };
      LS.set(K.cache, server);
    }
    sync$.error = null;
  } catch (e) {
    sync$.error = e.kind === 'net' ? 'offline' : e.message;
  } finally {
    sync$.busy = false;
    recompute();
    softRender();
    if (sync$.again) { sync$.again = false; sync(); }
  }
}

/* =====================================================================
 * Derived data: sessions, pre-fill, e1RM, trends
 * ===================================================================== */
function e1rm(w, r) {
  w = Number(w); r = Number(r);
  if (!(w > 0) || !(r > 0)) return 0;
  return r === 1 ? w : w * (1 + r / 30);
}

// Sets from the most recent workout that included this exercise.
function lastSession(name) {
  const n = norm(name);
  for (let i = data.log.length - 1; i >= 0; i--) {
    const r = data.log[i];
    if (norm(r.exercise) === n) {
      return data.log.filter((x) => x.workout_id === r.workout_id && norm(x.exercise) === n)
        .sort((a, b) => a.set_number - b.set_number);
    }
  }
  return [];
}

// One entry per workout date: the best e1RM of that day.
function sessionsFor(name) {
  const n = norm(name), byDate = new Map();
  data.log.forEach((r) => {
    if (norm(r.exercise) !== n) return;
    const v = e1rm(r.weight_lbs, r.reps);
    if (v > 0 && v > (byDate.get(r.date) || 0)) byDate.set(r.date, v);
  });
  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, best]) => ({ date, best }));
}

function classify(pct) {
  if (pct == null) return 'nodata';
  if (pct > Number(settings.gainPct)) return 'gain';
  if (pct < Number(settings.declinePct)) return 'decline';
  return 'hold';
}
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;

function trendFor(name) {
  const s = sessionsFor(name), n = s.length, W = CONFIG.WINDOW;
  const out = { name, sessions: s, current: n ? s[n - 1].best : 0, pct: null, status: 'nodata' };
  if (n < CONFIG.MIN_SESSIONS) return out;
  const last = avg(s.slice(n - W).map((x) => x.best));
  const prev = avg(s.slice(Math.max(0, n - 2 * W), n - W).map((x) => x.best));
  out.pct = ((last - prev) / prev) * 100;
  out.status = classify(out.pct);
  return out;
}

function overallTrend() {
  const favs = data.exercises.filter(isFav).map((e) => trendFor(e.exercise));
  const withData = favs.filter((t) => t.pct != null);
  const pct = withData.length ? avg(withData.map((t) => t.pct)) : null;
  return { favs, withData, pct, status: classify(pct) };
}

function workoutsList() {
  const m = new Map();
  data.log.forEach((r, i) => {
    let w = m.get(r.workout_id);
    if (!w) { w = { id: r.workout_id, name: r.workout_name, date: r.date, sets: [], idx: i }; m.set(r.workout_id, w); }
    w.sets.push(r); w.idx = i;
  });
  return [...m.values()].sort((a, b) => b.date.localeCompare(a.date) || b.idx - a.idx);
}
const exerciseOrder = (sets) => [...new Set(sets.map((s) => s.exercise))];

/* =====================================================================
 * Rendering
 * ===================================================================== */
const STATUS = {
  gain: { label: 'Gaining', icon: 'up', cls: 's-gain' },
  hold: { label: 'Maintaining', icon: 'flat', cls: 's-hold' },
  decline: { label: 'Declining', icon: 'down', cls: 's-decline' },
  nodata: { label: 'Not enough data yet', icon: 'flat', cls: 's-nodata' },
};
const fmtPct = (p) => (p == null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`);

function route() {
  const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'home', arg: rest.length ? decodeURIComponent(rest.join('/')) : null };
}

function render() {
  const r = route();
  const views = { home: viewHome, workout: viewWorkout, history: viewHistory, w: viewWorkoutDetail, ex: viewExercise, template: viewTemplate, settings: viewSettings };
  const fn = views[r.name] || viewHome;
  $('#app').innerHTML = fn(r.arg);
  if (r.name === 'ex') drawChart(r.arg);
  renderTabs(r.name);
  renderPill();
}
// Re-render after background sync, but never while you're typing in a workout or editor.
function softRender() {
  const r = route().name;
  const typing = document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if (r === 'workout' || r === 'template' || $('#backdrop').classList.contains('open') || typing) renderPill();
  else render();
}

function renderTabs(cur) {
  const map = { home: 'home', workout: 'workout', history: 'history', w: 'history', ex: 'history', template: 'home', settings: 'settings' };
  const on = map[cur] || 'home';
  const tab = (id, label, icon, extra = '') => `<a href="#${id}" class="${on === id ? 'on' : ''}">${ICON[icon]}${label}${extra}</a>`;
  $('#tabs').innerHTML = tab('home', 'Home', 'home') +
    (active ? tab('workout', 'Workout', 'lift', '<span class="dot"></span>') : '') +
    tab('history', 'History', 'hist') + tab('settings', 'Settings', 'gear');
}

function renderPill() {
  const p = $('#sync-pill');
  p.classList.remove('warn');
  if (!settings.url || !settings.token) { p.textContent = 'Not connected'; p.classList.add('warn'); return; }
  if (sync$.busy) { p.textContent = 'Syncing…'; return; }
  if (sync$.error && sync$.error !== 'offline') { p.textContent = 'Sync error'; p.classList.add('warn'); return; }
  if (queue.length) { p.textContent = `${queue.length} change${queue.length > 1 ? 's' : ''} pending${sync$.error === 'offline' ? ' · offline' : ''}`; return; }
  if (sync$.error === 'offline') { p.textContent = 'Offline'; return; }
  p.textContent = 'Synced ✓';
}

/* ---------------------------------------------------------------- home */
function viewHome() {
  let h = '';
  if (!settings.url || !settings.token) {
    h += `<div class="card"><b>Connect your Google Sheet</b><p class="muted small">Paste your Apps Script URL and API token in Settings to start syncing.</p><a class="btn primary" href="#settings">Open Settings</a></div>`;
  }
  if (active) {
    const done = active.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done).length, 0);
    h += `<a class="card li" href="#workout" style="text-decoration:none;color:inherit"><div class="grow"><div class="title">Workout in progress: ${esc(active.name)}</div><div class="sub">${done} set${done === 1 ? '' : 's'} logged · tap to resume</div></div><span class="icon-btn">›</span></a>`;
  }

  const o = overallTrend(), st = STATUS[o.status];
  h += `<div class="card ${st.cls}"><div class="trend"><div class="arrow">${ICON[st.icon]}</div><div class="grow">
      <div class="status">${st.label}</div>
      <div class="muted small">${o.pct == null
        ? (o.favs.length ? `Log ${CONFIG.MIN_SESSIONS}+ sessions of a favorite exercise to see your trend.` : 'Mark favorite exercises (is_favorite in the Exercises tab) to see your trend.')
        : `${fmtPct(o.pct)} avg e1RM, last ${CONFIG.WINDOW} sessions vs ${CONFIG.WINDOW} before · ${o.withData.length} favorite${o.withData.length > 1 ? 's' : ''}`}</div>
      ${o.status === 'hold' ? '<div class="small muted">Holding strength. That’s a win on a cut.</div>' : ''}
    </div></div></div>`;

  if (o.favs.length) {
    h += `<div class="list">${o.favs.sort((a, b) => (b.pct ?? -1e9) - (a.pct ?? -1e9)).map((t) => {
      const s = STATUS[t.status];
      return `<a class="li" href="#ex/${encodeURIComponent(t.name)}" style="color:inherit;text-decoration:none">
        <div class="mini-arrow ${s.cls}">${ICON[s.icon]}</div>
        <div class="grow"><div class="title">${esc(t.name)}</div><div class="sub">${t.current ? `e1RM ${Math.round(t.current)} lb` : 'No sets yet'}${t.status === 'nodata' ? ` · not enough data yet (${t.sessions.length}/${CONFIG.MIN_SESSIONS})` : ''}</div></div>
        <div class="pct ${s.cls}">${fmtPct(t.pct)}</div></a>`;
    }).join('')}</div>`;
  }

  h += `<button class="btn primary" data-act="startEmpty">Start empty workout</button>`;

  h += `<h2>Start from saved workout</h2>`;
  const tpls = [...data.templates].sort((a, b) => a.workout_name.localeCompare(b.workout_name));
  h += `<div class="list">${tpls.length ? tpls.map((t) => `<div class="li">
      <button class="grow" style="text-align:left;min-height:44px" data-act="startTpl" data-id="${esc(t.workout_id)}">
        <div class="title">${esc(t.workout_name)}</div>
        <div class="sub">${esc(t.exercises.map((e) => e.exercise).join(' · ') || 'No exercises')}</div></button>
      <a class="icon-btn" href="#template/${encodeURIComponent(t.workout_id)}" aria-label="Edit template">✎</a></div>`).join('')
    : '<div class="empty">No saved workouts yet. Use “Save as template” during or after a workout.</div>'}</div>`;

  h += `<h2>Recent workouts</h2>`;
  const ws = workoutsList().slice(0, CONFIG.RECENT_COUNT);
  h += `<div class="list">${ws.length ? ws.map(workoutLi).join('') : '<div class="empty">No workouts logged yet.</div>'}</div>`;
  return h;
}
function workoutLi(w) {
  const exs = exerciseOrder(w.sets);
  return `<a class="li" href="#w/${encodeURIComponent(w.id)}" style="color:inherit;text-decoration:none"><div class="grow">
    <div class="title">${esc(w.name)}</div><div class="sub">${fmtDate(w.date)} · ${w.sets.length} sets · ${esc(exs.join(', '))}</div></div><span class="muted">›</span></a>`;
}

/* ------------------------------------------------------- active workout */
function makeExercise(name, targetSets, targetReps) {
  const last = lastSession(name);
  const n = Number(targetSets) || last.length || 1;
  const sets = Array.from({ length: n }, (_, i) => {
    const src = last[i] || last[last.length - 1];
    return { w: src ? fmtW(src.weight_lbs) : '', r: src ? String(src.reps) : (targetReps ? String(targetReps) : ''), done: false, note: '' };
  });
  return { name, step: CONFIG.WEIGHT_STEPS[0], sets };
}

function startWorkout(tpl) {
  if (active && !confirm(`Discard the workout in progress (${active.name})?`)) return;
  active = {
    id: uid('w'), date: today(), name: tpl ? tpl.workout_name : 'Workout', template_id: tpl ? tpl.workout_id : null,
    exercises: tpl ? [...tpl.exercises].sort((a, b) => a.order - b.order).map((e) => makeExercise(e.exercise, e.target_sets, e.target_reps)) : [],
  };
  saveActive();
  location.hash = '#workout';
  render();
}

function viewWorkout() {
  if (!active) return `<h1>No workout in progress</h1><button class="btn primary" data-act="startEmpty">Start empty workout</button><a class="btn" href="#home">Choose a saved workout</a>`;
  const done = active.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done).length, 0);
  let h = `<input class="wk-name" data-f="wkname" value="${esc(active.name)}" aria-label="Workout name">
    <div class="muted small" style="margin-bottom:12px">${fmtDate(active.date)} · ${done} set${done === 1 ? '' : 's'} done</div>`;
  active.exercises.forEach((ex, ei) => {
    const last = lastSession(ex.name);
    h += `<section class="card"><div class="ex-head">
        <a class="name" href="#ex/${encodeURIComponent(ex.name)}" style="color:inherit;text-decoration:none">${esc(ex.name)}</a>
        <button class="chip" data-act="step" data-ei="${ei}" aria-label="Weight step">±${ex.step}</button>
        <button class="icon-btn" data-act="exMenu" data-ei="${ei}" aria-label="Exercise options">${ICON.dots}</button></div>
      <div class="last muted">${last.length ? `Last (${fmtDate(last[0].date)}): ${last.map((s) => `${fmtW(s.weight_lbs)}×${s.reps}`).join(', ')}` : 'First time, no previous sets'}</div>
      <div class="set-row head"><span>Set</span><span>lb</span><span>Reps</span><span></span><span></span></div>
      ${ex.sets.map((s, si) => `<div class="set-row ${s.done ? 'done' : ''}" data-ei="${ei}" data-si="${si}">
        <button class="set-n ${s.note ? 'has-note' : ''}" data-act="setNote" aria-label="Note for set ${si + 1}">${si + 1}</button>
        <div class="stepper"><button data-act="dec" aria-label="Less weight">−</button>
          <input data-f="w" inputmode="decimal" enterkeyhint="next" value="${esc(s.w)}" placeholder="0" aria-label="Weight">
          <button data-act="inc" aria-label="More weight">+</button></div>
        <input class="reps" data-f="r" inputmode="numeric" pattern="[0-9]*" enterkeyhint="done" value="${esc(s.r)}" placeholder="0" aria-label="Reps">
        <button class="check" data-act="done" aria-label="Mark set done">${ICON.check}</button>
        <button class="del" data-act="delSet" aria-label="Delete set">✕</button></div>`).join('')}
      <button class="add-set" data-act="addSet" data-ei="${ei}">+ Add set</button></section>`;
  });
  h += `<button class="btn" data-act="pickForWorkout">+ Add exercise</button>
    <div class="row" style="margin-top:16px"><button class="btn" data-act="saveTplFromWorkout">Save as template</button><button class="btn primary" data-act="finish">Finish workout</button></div>
    <button class="btn danger" style="margin-top:8px" data-act="discard">Discard workout</button>`;
  return h;
}

function rowCtx(el) {
  const row = el.closest('.set-row');
  const ei = Number(row.dataset.ei), si = Number(row.dataset.si);
  return { row, ex: active.exercises[ei], set: active.exercises[ei].sets[si], ei, si };
}

// Changing a set's weight/reps also updates the following unchecked sets that had the same value.
function setField(ctx, field, value) {
  const old = ctx.set[field];
  ctx.set[field] = value;
  ctx.ex.sets.slice(ctx.si + 1).forEach((s, k) => {
    if (!s.done && s[field] === old) {
      s[field] = value;
      const inp = document.querySelector(`.set-row[data-ei="${ctx.ei}"][data-si="${ctx.si + 1 + k}"] [data-f="${field}"]`);
      if (inp) inp.value = value;
    }
  });
  saveActive();
}

function finishWorkout() {
  const sets = [];
  let unchecked = 0;
  active.exercises.forEach((ex) => {
    let n = 0;
    ex.sets.forEach((s) => {
      if (!s.done) { unchecked++; return; }
      sets.push({ date: active.date, workout_id: active.id, workout_name: active.name.trim() || 'Workout', exercise: ex.name,
        set_number: ++n, weight_lbs: Number(s.w) || 0, reps: Number(s.r) || 0, notes: s.note || '' });
    });
  });
  if (!sets.length) { toast('Check off at least one set (✓) first.'); return; }
  if (!confirm(`Finish and save ${sets.length} set${sets.length > 1 ? 's' : ''}?${unchecked ? `\n${unchecked} unchecked set${unchecked > 1 ? 's' : ''} won't be saved.` : ''}`)) return;
  const wasTemplate = !!active.template_id;
  const finished = active;
  enqueue('addSets', { sets });
  active = null; saveActive();
  if (!wasTemplate && confirm('Save this workout as a template for next time?')) saveTemplateFrom(finished);
  location.hash = '#home';
  render();
  toast(queue.length && sync$.error === 'offline' ? 'Saved offline. Will sync when you’re back online.' : 'Workout saved ✓');
}

function saveTemplateFrom(wk) {
  const name = (prompt('Template name', wk.name) || '').trim();
  if (!name) return;
  const existing = data.templates.find((t) => norm(t.workout_name) === norm(name));
  if (existing && !confirm(`Replace the saved workout “${existing.workout_name}”?`)) return;
  const id = existing ? existing.workout_id : uid('t');
  enqueue('saveTemplate', {
    workout_id: id, workout_name: name, created_date: existing ? existing.created_date : today(),
    exercises: wk.exercises.map((ex) => ({ exercise: ex.name, target_sets: ex.sets.length, target_reps: Number(ex.sets[0]?.r) || '' })),
  });
  if (active === wk) { active.template_id = id; saveActive(); }
  toast(`Saved “${name}” ✓`);
}

/* ------------------------------------------------------ exercise picker */
function openPicker(cb, q = '') {
  pickerCb = cb;
  openSheet(`<h3>Add exercise</h3>
    <input class="input" id="pick-q" placeholder="Search or type a new exercise" autocomplete="off" value="${esc(q)}">
    <div id="pick-list" style="margin-top:10px"></div>`);
  renderPickList();
}
function renderPickList() {
  const q = norm($('#pick-q').value);
  const all = [...data.exercises].sort((a, b) => (isFav(b) - isFav(a)) || a.exercise.localeCompare(b.exercise));
  const hits = q ? all.filter((e) => norm(e.exercise).includes(q) || norm(e.muscle_group).includes(q)) : all;
  const exact = all.some((e) => norm(e.exercise) === q);
  const raw = $('#pick-q').value.trim();
  let h = '';
  if (q && !exact) {
    h += `<div class="card"><b>Create “${esc(raw)}”</b><div class="muted small">Pick a muscle group:</div><div class="chips">
      ${MUSCLE_GROUPS.map((g) => `<button class="chip" data-act="createEx" data-g="${esc(g)}">${g}</button>`).join('')}</div></div>`;
  }
  h += `<div class="list">${hits.length ? hits.map((e) => `<button class="li" data-act="pickEx" data-name="${esc(e.exercise)}">
      <div class="grow"><div class="title">${isFav(e) ? '★ ' : ''}${esc(e.exercise)}</div><div class="sub">${esc(e.muscle_group || '')}</div></div></button>`).join('')
    : `<div class="empty">${q ? 'No matches' : 'No exercises yet. Type a name above.'}</div>`}</div>`;
  $('#pick-list').innerHTML = h;
}

/* ------------------------------------------------------------- history */
let histTab = 'workouts';
function viewHistory() {
  let h = `<h1>History</h1><div class="seg"><button class="${histTab === 'workouts' ? 'on' : ''}" data-act="histTab" data-t="workouts">Workouts</button><button class="${histTab === 'exercises' ? 'on' : ''}" data-act="histTab" data-t="exercises">Exercises</button></div>`;
  if (histTab === 'workouts') {
    const ws = workoutsList();
    h += `<div class="list">${ws.length ? ws.map(workoutLi).join('') : '<div class="empty">No workouts logged yet.</div>'}</div>`;
  } else {
    const lastDate = new Map(), count = new Map();
    data.log.forEach((r) => {
      if (!lastDate.has(r.exercise) || r.date > lastDate.get(r.exercise)) lastDate.set(r.exercise, r.date);
    });
    [...lastDate.keys()].forEach((n) => count.set(n, sessionsFor(n).length || new Set(data.log.filter((r) => r.exercise === n).map((r) => r.date)).size));
    const names = [...lastDate.keys()].sort((a, b) => lastDate.get(b).localeCompare(lastDate.get(a)));
    h += `<div class="list">${names.length ? names.map((n) => `<a class="li" href="#ex/${encodeURIComponent(n)}" style="color:inherit;text-decoration:none"><div class="grow"><div class="title">${esc(n)}</div>
      <div class="sub">${count.get(n)} session${count.get(n) > 1 ? 's' : ''} · last ${fmtDate(lastDate.get(n))}</div></div><span class="muted">›</span></a>`).join('') : '<div class="empty">No exercises logged yet.</div>'}</div>`;
  }
  return h;
}

function viewWorkoutDetail(id) {
  const w = workoutsList().find((x) => x.id === id);
  if (!w) return `<h1>Workout not found</h1><a class="btn" href="#history">Back to history</a>`;
  let h = `<a href="#history" class="muted small" style="text-decoration:none">‹ History</a><h1 style="margin-bottom:2px">${esc(w.name)}</h1><div class="muted" style="margin-bottom:12px">${fmtDate(w.date, true)} · ${w.sets.length} sets</div>`;
  exerciseOrder(w.sets).forEach((name) => {
    const sets = w.sets.filter((s) => s.exercise === name).sort((a, b) => a.set_number - b.set_number);
    h += `<h2><a href="#ex/${encodeURIComponent(name)}" style="color:inherit">${esc(name)}</a></h2><div class="list">${sets.map((s) => `
      <button class="set-line" data-act="editSet" data-w="${esc(s.workout_id)}" data-e="${esc(s.exercise)}" data-n="${s.set_number}">
        <span><b>Set ${s.set_number}</b> · ${fmtW(s.weight_lbs)} lb × ${s.reps}${s.notes ? `<br><span class="muted small">${esc(s.notes)}</span>` : ''}</span>
        <span class="muted small">e1RM ${Math.round(e1rm(s.weight_lbs, s.reps))} ✎</span></button>`).join('')}</div>`;
  });
  return h;
}

function viewExercise(name) {
  // Chronological (by date, then the order it was logged) so PRs are judged against earlier days.
  const rows = data.log.filter((r) => norm(r.exercise) === norm(name))
    .map((r, i) => [r, i]).sort((a, b) => a[0].date.localeCompare(b[0].date) || a[1] - b[1]).map((x) => x[0]);
  const t = trendFor(name), st = STATUS[t.status];
  let h = `<a href="javascript:history.back()" class="muted small" style="text-decoration:none">‹ Back</a><h1>${esc(name)}</h1>`;
  if (!rows.length) return h + '<div class="card empty">No sets logged yet.</div>';

  // PRs: a set whose e1RM beats every earlier set (in log order).
  let bestSoFar = 0, best = null;
  const prSet = new Set();
  rows.forEach((r) => {
    const v = e1rm(r.weight_lbs, r.reps);
    if (v > bestSoFar) { bestSoFar = v; prSet.add(r); best = r; }
  });
  h += `<div class="stats">
    <div class="stat"><b class="${st.cls}">${fmtPct(t.pct)}</b><span>${st.label === 'Not enough data yet' ? `Need ${CONFIG.MIN_SESSIONS} sessions` : st.label}</span></div>
    <div class="stat"><b>${t.current ? Math.round(t.current) : '—'}</b><span>Latest e1RM</span></div>
    <div class="stat"><b>${best ? Math.round(e1rm(best.weight_lbs, best.reps)) : '—'}</b><span>Best e1RM</span></div></div>`;
  if (best) h += `<div class="card best"><span class="pr">🏆 BEST SET</span><div><b>${fmtW(best.weight_lbs)} lb × ${best.reps}</b> · ${fmtDate(best.date, true)}</div></div>`;
  h += `<div class="card"><div class="muted small" style="margin-bottom:6px">Best e1RM per session</div>${t.sessions.length > 1 ? '<canvas class="chart" id="chart"></canvas>' : '<div class="empty">Log 2+ sessions to see a chart.</div>'}</div>`;

  const byWorkout = new Map();
  rows.forEach((r) => { if (!byWorkout.has(r.workout_id)) byWorkout.set(r.workout_id, []); byWorkout.get(r.workout_id).push(r); });
  const groups = [...byWorkout.values()].reverse();
  h += `<h2>All sets</h2>` + groups.map((sets) => `<div class="list"><a class="li" href="#w/${encodeURIComponent(sets[0].workout_id)}" style="min-height:44px;color:inherit;text-decoration:none"><div class="grow"><div class="title small">${fmtDate(sets[0].date, true)}</div><div class="sub">${esc(sets[0].workout_name)}</div></div></a>
    ${sets.sort((a, b) => a.set_number - b.set_number).map((s) => `<div class="set-line ${s === best ? 'best' : ''}"><span>Set ${s.set_number} · <b>${fmtW(s.weight_lbs)} × ${s.reps}</b>${s.notes ? ` <span class="muted small">· ${esc(s.notes)}</span>` : ''}</span>
      <span>${prSet.has(s) ? '<span class="pr">PR </span>' : ''}<span class="muted small">${Math.round(e1rm(s.weight_lbs, s.reps))}</span></span></div>`).join('')}</div>`).join('');
  return h;
}

function drawChart(name) {
  const c = $('#chart');
  if (!c) return;
  const pts = sessionsFor(name);
  const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr; c.height = H * dpr;
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim(), muted = css.getPropertyValue('--muted').trim(), grid = css.getPropertyValue('--border').trim();
  const vals = pts.map((p) => p.best);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.15, 5); lo -= pad; hi += pad;
  const L = 36, R = 8, T = 8, B = 22;
  const x = (i) => L + (pts.length === 1 ? 0 : (i * (W - L - R)) / (pts.length - 1));
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  g.font = '11px -apple-system, sans-serif'; g.fillStyle = muted; g.strokeStyle = grid; g.lineWidth = 1;
  [hi - pad, (hi + lo) / 2, lo + pad].forEach((v) => {
    g.beginPath(); g.moveTo(L, y(v)); g.lineTo(W - R, y(v)); g.stroke();
    g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(Math.round(v), L - 6, y(v));
  });
  g.textBaseline = 'top';
  g.textAlign = 'left'; g.fillText(pts[0].date.slice(5), L, H - B + 6);
  g.textAlign = 'right'; g.fillText(pts[pts.length - 1].date.slice(5), W - R, H - B + 6);
  g.strokeStyle = accent; g.lineWidth = 2.5; g.lineJoin = 'round'; g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(x(i), y(p.best)) : g.moveTo(x(i), y(p.best))));
  g.stroke();
  g.fillStyle = accent;
  pts.forEach((p, i) => { g.beginPath(); g.arc(x(i), y(p.best), i === pts.length - 1 ? 4.5 : 3, 0, Math.PI * 2); g.fill(); });
}

/* ------------------------------------------------------ template editor */
function viewTemplate(id) {
  if (!tplDraft || tplDraft.workout_id !== id) {
    const t = data.templates.find((x) => x.workout_id === id);
    if (!t) return `<h1>Saved workout not found</h1><a class="btn" href="#home">Home</a>`;
    tplDraft = clone(t);
  }
  const d = tplDraft;
  return `<a href="#home" class="muted small" style="text-decoration:none" data-act="tplCancel">‹ Cancel</a><h1>Edit saved workout</h1>
    <label class="field"><span>Name</span><input class="input" data-f="tplname" value="${esc(d.workout_name)}"></label>
    <div class="card" style="padding:4px 14px">
      <div class="tpl-row muted small" style="border:0;padding-bottom:0"><span>Exercise</span><span style="text-align:center">Sets</span><span style="text-align:center">Reps</span><span></span></div>
      ${d.exercises.map((e, i) => `<div class="tpl-row" data-i="${i}"><b>${esc(e.exercise)}</b>
        <input class="input" data-f="tsets" inputmode="numeric" value="${esc(e.target_sets)}">
        <input class="input" data-f="treps" inputmode="numeric" value="${esc(e.target_reps)}">
        <span class="tools"><button data-act="tplUp" aria-label="Move up">↑</button><button data-act="tplDown" aria-label="Move down">↓</button><button data-act="tplDel" aria-label="Remove">✕</button></span></div>`).join('') || '<div class="empty">No exercises</div>'}
    </div>
    <button class="btn" data-act="tplAddEx">+ Add exercise</button>
    <button class="btn primary" data-act="tplSave" style="margin-top:16px">Save changes</button>
    <button class="btn danger" data-act="tplDelete">Delete saved workout</button>`;
}

/* ------------------------------------------------------------- settings */
function viewSettings() {
  const last = server.syncedAt ? new Date(server.syncedAt).toLocaleString() : 'never';
  return `<h1>Settings</h1>
    <h2>Connection</h2>
    <label class="field"><span>Apps Script web app URL</span><input class="input" id="s-url" value="${esc(settings.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
    <label class="field"><span>API token</span><input class="input" id="s-token" type="password" value="${esc(settings.token)}" placeholder="Paste from Apps Script log" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
    <button class="btn primary" data-act="saveConn">Save &amp; test connection</button>
    <p class="muted small">Last synced: ${esc(last)} · ${queue.length} change${queue.length === 1 ? '' : 's'} waiting to sync${sync$.error && sync$.error !== 'offline' ? `<br><span class="s-decline">Error: ${esc(sync$.error)}</span>` : ''}</p>
    <button class="btn" data-act="syncNow">Sync now</button>
    <h2>Strength trend thresholds</h2>
    <div class="row"><label class="field" style="flex:1"><span>Gaining above (%)</span><input class="input" id="s-gain" inputmode="decimal" value="${esc(settings.gainPct)}"></label>
    <label class="field" style="flex:1"><span>Declining below (%)</span><input class="input" id="s-decl" inputmode="decimal" value="${esc(settings.declinePct)}"></label></div>
    <button class="btn" data-act="saveThresh">Save thresholds</button>
    <h2>Export</h2>
    <button class="btn" data-act="exportCsv">Download Log as CSV</button>
    <p class="muted small">${data.log.length} sets in your log.</p>`;
}

function exportCsv() {
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [LOG_COLUMNS.join(','), ...data.log.map((r) => LOG_COLUMNS.map((c) => cell(r[c])).join(','))].join('\n');
  const name = `workout-log-${today()}.csv`;
  const file = new File([csv], name, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch(() => {});
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ------------------------------------------------------------- sheet */
function openSheet(html) { $('#sheet').innerHTML = html; $('#backdrop').classList.add('open'); }
function closeSheet() { $('#backdrop').classList.remove('open'); $('#sheet').innerHTML = ''; pickerCb = null; }

/* =====================================================================
 * Actions (event delegation via data-act)
 * ===================================================================== */
const ACT = {
  syncNow: () => { sync(); },
  startEmpty: () => startWorkout(null),
  startTpl: (el) => startWorkout(data.templates.find((t) => t.workout_id === el.dataset.id)),
  discard: () => { if (confirm('Discard this workout? Nothing will be saved.')) { active = null; saveActive(); location.hash = '#home'; render(); } },
  finish: finishWorkout,
  saveTplFromWorkout: () => { if (!active.exercises.length) return toast('Add an exercise first.'); saveTemplateFrom(active); },
  step: (el) => {
    const ex = active.exercises[el.dataset.ei];
    const steps = CONFIG.WEIGHT_STEPS;
    ex.step = steps[(steps.indexOf(ex.step) + 1) % steps.length];
    el.textContent = `±${ex.step}`; saveActive();
  },
  inc: (el) => bump(el, 1),
  dec: (el) => bump(el, -1),
  done: (el) => {
    const c = rowCtx(el);
    if (!c.set.done) {
      if (c.set.w === '') { c.row.querySelector('[data-f="w"]').focus(); return toast('Enter a weight (0 for bodyweight)'); }
      if (!(Number(c.set.r) > 0)) { c.row.querySelector('[data-f="r"]').focus(); return toast('Enter reps'); }
    }
    c.set.done = !c.set.done;
    if (document.activeElement) document.activeElement.blur();
    saveActive(); render();
  },
  addSet: (el) => {
    const ex = active.exercises[el.dataset.ei];
    const prev = ex.sets[ex.sets.length - 1];
    ex.sets.push({ w: prev ? prev.w : '', r: prev ? prev.r : '', done: false, note: '' });
    saveActive(); render();
  },
  delSet: (el) => {
    const c = rowCtx(el);
    if (c.set.done && !confirm(`Delete set ${c.si + 1}?`)) return;
    c.ex.sets.splice(c.si, 1);
    saveActive(); render();
  },
  setNote: (el) => {
    const c = rowCtx(el);
    const v = prompt(`Note for ${c.ex.name}, set ${c.si + 1}`, c.set.note || '');
    if (v === null) return;
    c.set.note = v.trim(); saveActive(); render();
  },
  exMenu: (el) => {
    const ei = Number(el.dataset.ei), ex = active.exercises[ei];
    openSheet(`<h3>${esc(ex.name)}</h3>
      ${ei > 0 ? `<button class="btn" data-act="exMove" data-ei="${ei}" data-d="-1">Move up</button>` : ''}
      ${ei < active.exercises.length - 1 ? `<button class="btn" data-act="exMove" data-ei="${ei}" data-d="1">Move down</button>` : ''}
      <button class="btn danger" data-act="exRemove" data-ei="${ei}">Remove exercise</button>
      <button class="btn" data-act="closeSheet">Cancel</button>`);
  },
  exMove: (el) => {
    const i = Number(el.dataset.ei), j = i + Number(el.dataset.d), a = active.exercises;
    [a[i], a[j]] = [a[j], a[i]]; saveActive(); closeSheet(); render();
  },
  exRemove: (el) => {
    const ex = active.exercises[el.dataset.ei];
    if (ex.sets.some((s) => s.done) && !confirm(`Remove ${ex.name} and its logged sets?`)) return;
    active.exercises.splice(el.dataset.ei, 1); saveActive(); closeSheet(); render();
  },
  closeSheet,
  pickForWorkout: () => openPicker((name) => {
    active.exercises.push(makeExercise(name));
    saveActive(); render();
    setTimeout(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }), 50);
  }),
  pickEx: (el) => { const cb = pickerCb; closeSheet(); cb && cb(el.dataset.name); },
  createEx: (el) => {
    const name = $('#pick-q').value.trim().replace(/\s+/g, ' ');
    if (!name) return;
    enqueue('addExercise', { exercise: name, muscle_group: el.dataset.g, is_favorite: false });
    const cb = pickerCb; closeSheet(); cb && cb(name);
  },
  histTab: (el) => { histTab = el.dataset.t; render(); },
  editSet: (el) => {
    const s = data.log.find((r) => r.workout_id === el.dataset.w && r.exercise === el.dataset.e && Number(r.set_number) === Number(el.dataset.n));
    if (!s) return;
    openSheet(`<h3>${esc(s.exercise)}, set ${s.set_number}</h3>
      <div class="row"><label class="field" style="flex:1"><span>Weight (lb)</span><input class="input" id="es-w" inputmode="decimal" value="${fmtW(s.weight_lbs)}"></label>
      <label class="field" style="flex:1"><span>Reps</span><input class="input" id="es-r" inputmode="numeric" value="${s.reps}"></label></div>
      <label class="field"><span>Notes</span><input class="input" id="es-n" value="${esc(s.notes)}"></label>
      <button class="btn primary" data-act="saveSet" data-w="${esc(s.workout_id)}" data-e="${esc(s.exercise)}" data-n="${s.set_number}">Save</button>
      <button class="btn danger" data-act="deleteSet" data-w="${esc(s.workout_id)}" data-e="${esc(s.exercise)}" data-n="${s.set_number}">Delete set</button>
      <button class="btn" data-act="closeSheet">Cancel</button>`);
  },
  saveSet: (el) => {
    const r = Number($('#es-r').value);
    if (!(r > 0)) return toast('Reps must be at least 1');
    enqueue('updateSet', { workout_id: el.dataset.w, exercise: el.dataset.e, set_number: Number(el.dataset.n),
      weight_lbs: Number($('#es-w').value) || 0, reps: r, notes: $('#es-n').value.trim() });
    closeSheet(); render(); toast('Set updated');
  },
  deleteSet: (el) => {
    if (!confirm('Delete this set from your log?')) return;
    enqueue('deleteSet', { workout_id: el.dataset.w, exercise: el.dataset.e, set_number: Number(el.dataset.n) });
    closeSheet(); render(); toast('Set deleted');
  },
  tplCancel: () => { tplDraft = null; },
  tplUp: (el) => tplMove(el, -1),
  tplDown: (el) => tplMove(el, 1),
  tplDel: (el) => { tplDraft.exercises.splice(el.closest('.tpl-row').dataset.i, 1); render(); },
  tplAddEx: () => openPicker((name) => { tplDraft.exercises.push({ exercise: name, target_sets: 3, target_reps: '' }); render(); }),
  tplSave: () => {
    const d = tplDraft;
    if (!d.workout_name.trim()) return toast('Give it a name');
    enqueue('saveTemplate', { workout_id: d.workout_id, workout_name: d.workout_name.trim(), created_date: d.created_date,
      exercises: d.exercises.map((e) => ({ exercise: e.exercise, target_sets: Number(e.target_sets) || '', target_reps: Number(e.target_reps) || '' })) });
    tplDraft = null; location.hash = '#home'; toast('Saved ✓');
  },
  tplDelete: () => {
    if (!confirm(`Delete “${tplDraft.workout_name}”? Your logged workouts stay.`)) return;
    enqueue('deleteTemplate', { workout_id: tplDraft.workout_id });
    tplDraft = null; location.hash = '#home'; toast('Deleted');
  },
  saveConn: async () => {
    settings.url = $('#s-url').value.trim();
    settings.token = $('#s-token').value.trim();
    LS.set(K.settings, settings);
    if (!settings.url || !settings.token) return toast('Enter both the URL and token');
    try { await api('getExercises'); toast('Connected ✓'); sync$.error = null; sync(); }
    catch (e) { toast(e.message); renderPill(); }
  },
  saveThresh: () => {
    const g = Number($('#s-gain').value), d = Number($('#s-decl').value);
    if (!isFinite(g) || !isFinite(d) || d > g) return toast('Declining must be ≤ Gaining');
    settings.gainPct = g; settings.declinePct = d; LS.set(K.settings, settings); toast('Thresholds saved');
  },
  exportCsv,
};

function bump(el, dir) {
  const c = rowCtx(el);
  const v = Math.max(0, Math.round(((Number(c.set.w) || 0) + dir * c.ex.step) * 100) / 100);
  const inp = c.row.querySelector('[data-f="w"]');
  inp.value = String(v);
  setField(c, 'w', String(v));
}
function tplMove(el, d) {
  const i = Number(el.closest('.tpl-row').dataset.i), j = i + d, a = tplDraft.exercises;
  if (j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]]; render();
}

document.addEventListener('click', (e) => {
  if (e.target === $('#backdrop')) return closeSheet();
  const el = e.target.closest('[data-act]');
  if (!el || !ACT[el.dataset.act]) return;
  ACT[el.dataset.act](el, e);
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'pick-q') return renderPickList();
  const f = el.dataset.f;
  if (!f) return;
  if (f === 'wkname') { active.name = el.value; saveActive(); }
  else if (f === 'w' || f === 'r') setField(rowCtx(el), f, el.value.replace(',', '.').trim());
  else if (f === 'tplname') tplDraft.workout_name = el.value;
  else if (f === 'tsets' || f === 'treps') tplDraft.exercises[el.closest('.tpl-row').dataset.i][f === 'tsets' ? 'target_sets' : 'target_reps'] = el.value;
});
// Select the number when tapping into a weight/reps box so typing replaces it.
document.addEventListener('focusin', (e) => { if (e.target.matches('.stepper input, .reps')) setTimeout(() => e.target.select(), 0); });

window.addEventListener('hashchange', () => { if (route().name !== 'template') tplDraft = null; render(); window.scrollTo(0, 0); });
window.addEventListener('online', () => sync());
window.addEventListener('offline', () => { sync$.error = 'offline'; renderPill(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
setInterval(() => { if (queue.length && !sync$.busy) sync({ pull: false }); }, CONFIG.SYNC_EVERY_MS);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));

recompute();
render();
sync();
