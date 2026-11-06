/**
 * Workout Tracker — Google Apps Script backend (bound to your Google Sheet).
 *
 * 1. Run setup() once from the Apps Script editor. It creates the tabs and
 *    prints your API token in the execution log.
 * 2. Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 *
 * Every request is a POST whose body is a JSON string:
 *   { "action": "getLog", "token": "...", ...params }
 * Responses: { ok: true, data: ... } or { ok: false, error: "..." }
 *
 * Don't reorder the columns in the tabs. The script reads them by position.
 */

const SCHEMA = {
  Log: ['date', 'workout_id', 'workout_name', 'exercise', 'set_number', 'weight_lbs', 'reps', 'notes'],
  Exercises: ['exercise', 'muscle_group', 'is_favorite'],
  Workouts: ['workout_id', 'workout_name', 'created_date'],
  Workout_Exercises: ['workout_id', 'order', 'exercise', 'target_sets', 'target_reps'],
};

// Favorite exercises. setup() adds any that are missing with is_favorite = TRUE.
// Format: ['Exercise name', 'Muscle group']
const SEED_FAVORITES = [
  // Pull
  ['Pull-up', 'Back'],
  ['Machine High Row', 'Back'],
  ['Cable Hammer Curl', 'Arms'],
  ['Incline Dumbbell Biceps Curl', 'Arms'],
  ['Lat Pull-down', 'Back'],
  ['Machine Pullover', 'Back'],
  // Push
  ['Incline Smith Machine Bench Press', 'Chest'],
  ['Bench Press', 'Chest'],
  ['Machine Chest Press', 'Chest'],
  ['Pec Deck Fly', 'Chest'],
  ['Triceps Press-down', 'Arms'],
  ['Machine Lateral Raise', 'Shoulders'],
  ['Dips', 'Chest'],
  // Legs
  ['45-degree Leg Press', 'Legs'],
  ['Leg Extensions', 'Legs'],
  ['Lying Leg Curl', 'Legs'],
  ['Hip Adduction Machine', 'Legs'],
];

const WRITE_ACTIONS = ['addSets', 'updateSet', 'deleteSet', 'addExercise', 'saveTemplate', 'deleteTemplate'];

const ACTIONS = {
  getLog: getLog_,
  addSets: addSets_,
  updateSet: updateSet_,
  deleteSet: deleteSet_,
  getExercises: getExercises_,
  addExercise: addExercise_,
  getTemplates: getTemplates_,
  saveTemplate: saveTemplate_,
  deleteTemplate: deleteTemplate_,
};

/* ---------------------------------------------------------------- setup */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SCHEMA).forEach(function (name) {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    const headers = SCHEMA[name];
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });

  // Keep dates as plain text (2026-11-05) so they read cleanly and never shift time zones.
  ss.getSheetByName('Log').getRange('A:A').setNumberFormat('@');
  ss.getSheetByName('Workouts').getRange('C:C').setNumberFormat('@');

  // Show is_favorite as checkboxes.
  const rule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  ss.getSheetByName('Exercises').getRange('C2:C').setDataValidation(rule);

  // Seed favorites (safe to re-run).
  const existing = {};
  readTable_('Exercises').forEach(function (r) { existing[norm_(r.exercise)] = r; });
  const ex = ss.getSheetByName('Exercises');
  const toAdd = [];
  SEED_FAVORITES.forEach(function (f) {
    const hit = existing[norm_(f[0])];
    if (hit) ex.getRange(hit._row, 3).setValue(true);
    else toAdd.push([safe_(f[0]), safe_(f[1] || ''), true]);
  });
  appendRows_('Exercises', toAdd);

  // Optional one-time import (LiftTrackImport.gs is private and not in the public repo).
  if (typeof importLiftTrack_ === 'function') importLiftTrack_();

  // Remove the empty default tab.
  const s1 = ss.getSheetByName('Sheet1');
  if (s1 && s1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s1);

  // API token (generated once, kept in Script Properties — never in the repo).
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('API_TOKEN');
  if (!token) {
    token = Utilities.getUuid();
    props.setProperty('API_TOKEN', token);
  }
  Logger.log('Setup done. Your API token is: ' + token);
}

/* ------------------------------------------------------------- web app */

function doGet() {
  return json_({ ok: true, message: 'Workout Tracker API is running.' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Bad request body' });
  }
  return json_(handle_(req));
}

function handle_(req) {
  const token = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!token || req.token !== token) return { ok: false, error: 'Unauthorized: check your API token' };
  const fn = ACTIONS[req.action];
  if (!fn) return { ok: false, error: 'Unknown action: ' + req.action };
  try {
    if (WRITE_ACTIONS.indexOf(req.action) === -1) return { ok: true, data: fn(req) };
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      // opId makes retries safe: if the phone lost the response and resends, we don't double-log.
      const cache = CacheService.getScriptCache();
      const key = req.opId ? 'op_' + req.opId : null;
      const seen = key && cache.get(key);
      if (seen) return { ok: true, data: JSON.parse(seen), duplicate: true };
      const data = fn(req);
      if (key) cache.put(key, JSON.stringify(data === undefined ? null : data), 21600);
      return { ok: true, data: data };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/* ------------------------------------------------------------- actions */

function getLog_() {
  return readTable_('Log').map(function (r) {
    return {
      date: String(r.date),
      workout_id: String(r.workout_id),
      workout_name: String(r.workout_name),
      exercise: String(r.exercise),
      set_number: Number(r.set_number) || 0,
      weight_lbs: Number(r.weight_lbs) || 0,
      reps: Number(r.reps) || 0,
      notes: r.notes == null ? '' : String(r.notes),
    };
  });
}

function addSets_(req) {
  const sets = req.sets;
  if (!Array.isArray(sets) || !sets.length) throw new Error('No sets to add');
  const rows = sets.map(function (s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.date))) throw new Error('Bad date: ' + s.date);
    if (!String(s.exercise || '').trim()) throw new Error('Missing exercise name');
    return [String(s.date), safe_(s.workout_id), safe_(s.workout_name), safe_(s.exercise),
      Number(s.set_number) || 0, Number(s.weight_lbs) || 0, Number(s.reps) || 0, safe_(s.notes)];
  });
  appendRows_('Log', rows);

  // Exercises typed in on the fly are added to the library automatically.
  const known = {};
  readTable_('Exercises').forEach(function (r) { known[norm_(r.exercise)] = true; });
  const newEx = [];
  sets.forEach(function (s) {
    const n = norm_(s.exercise);
    if (!known[n]) { known[n] = true; newEx.push([safe_(s.exercise), '', false]); }
  });
  appendRows_('Exercises', newEx);
  return { added: rows.length };
}

function updateSet_(req) {
  const hit = findSet_(req);
  const sh = sheet_('Log');
  const notes = req.notes === undefined ? hit.notes : req.notes;
  sh.getRange(hit._row, 6, 1, 3).setValues([[Number(req.weight_lbs) || 0, Number(req.reps) || 0, safe_(notes)]]);
  return { updated: 1 };
}

function deleteSet_(req) {
  const hit = findSet_(req);
  sheet_('Log').deleteRow(hit._row);
  return { deleted: 1 };
}

function getExercises_() {
  return readTable_('Exercises').map(function (r) {
    return {
      exercise: String(r.exercise),
      muscle_group: String(r.muscle_group || ''),
      is_favorite: r.is_favorite === true || String(r.is_favorite).toUpperCase() === 'TRUE',
    };
  });
}

function addExercise_(req) {
  const name = String(req.exercise || '').trim();
  if (!name) throw new Error('Missing exercise name');
  const hit = readTable_('Exercises').filter(function (r) { return norm_(r.exercise) === norm_(name); })[0];
  if (hit) return { exercise: String(hit.exercise), existed: true };
  appendRows_('Exercises', [[safe_(name), safe_(req.muscle_group || ''), !!req.is_favorite]]);
  return { exercise: name, existed: false };
}

function getTemplates_() {
  const items = readTable_('Workout_Exercises');
  return readTable_('Workouts').map(function (w) {
    const id = String(w.workout_id);
    return {
      workout_id: id,
      workout_name: String(w.workout_name),
      created_date: String(w.created_date),
      exercises: items
        .filter(function (i) { return String(i.workout_id) === id; })
        .sort(function (a, b) { return Number(a.order) - Number(b.order); })
        .map(function (i) {
          return {
            order: Number(i.order),
            exercise: String(i.exercise),
            target_sets: i.target_sets === '' ? '' : Number(i.target_sets),
            target_reps: i.target_reps === '' ? '' : Number(i.target_reps),
          };
        }),
    };
  });
}

function saveTemplate_(req) {
  const name = String(req.workout_name || '').trim();
  if (!name) throw new Error('Template needs a name');
  const id = String(req.workout_id || ('t_' + Utilities.getUuid().slice(0, 8)));
  const existing = readTable_('Workouts').filter(function (w) { return String(w.workout_id) === id; })[0];
  if (existing) {
    sheet_('Workouts').getRange(existing._row, 2).setValue(safe_(name));
  } else {
    appendRows_('Workouts', [[safe_(id), safe_(name), String(req.created_date || today_())]]);
  }
  deleteRowsWhere_('Workout_Exercises', function (r) { return String(r.workout_id) === id; });
  appendRows_('Workout_Exercises', (req.exercises || []).map(function (e, i) {
    return [safe_(id), i + 1, safe_(e.exercise), Number(e.target_sets) || '', Number(e.target_reps) || ''];
  }));
  return { workout_id: id };
}

function deleteTemplate_(req) {
  const id = String(req.workout_id || '');
  if (!id) throw new Error('Missing workout_id');
  deleteRowsWhere_('Workout_Exercises', function (r) { return String(r.workout_id) === id; });
  deleteRowsWhere_('Workouts', function (r) { return String(r.workout_id) === id; });
  return { deleted: id };
}

/* ------------------------------------------------------------- helpers */

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '". Run setup() first.');
  return sh;
}

function readTable_(name) {
  const sh = sheet_(name);
  const headers = SCHEMA[name];
  const last = sh.getLastRow();
  if (last < 2) return [];
  const tz = Session.getScriptTimeZone();
  return sh.getRange(2, 1, last - 1, headers.length).getValues()
    .map(function (row, i) {
      const o = { _row: i + 2 };
      headers.forEach(function (h, c) {
        let v = row[c];
        if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
        o[h] = v;
      });
      return o;
    })
    .filter(function (o) { return headers.some(function (h) { return o[h] !== '' && o[h] != null; }); });
}

function appendRows_(name, rows) {
  if (!rows.length) return;
  const sh = sheet_(name);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function deleteRowsWhere_(name, pred) {
  const sh = sheet_(name);
  readTable_(name).filter(pred).map(function (r) { return r._row; })
    .sort(function (a, b) { return b - a; })
    .forEach(function (row) { sh.deleteRow(row); });
}

function findSet_(req) {
  const hit = readTable_('Log').filter(function (r) {
    return String(r.workout_id) === String(req.workout_id) &&
      String(r.exercise) === String(req.exercise) &&
      Number(r.set_number) === Number(req.set_number);
  })[0];
  if (!hit) throw new Error('Set not found');
  return hit;
}

// Stop Sheets from treating text like "=..." as a formula.
function safe_(v) {
  const s = v == null ? '' : String(v).trim();
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function norm_(s) { return String(s || '').trim().toLowerCase(); }

function today_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
