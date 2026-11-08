/**
 * Spreadsheet-backed storage.
 *   Meetings sheet: one meeting type per row, stored as JSON.
 *   Bookings sheet: one booking per row.
 * All cells are plain text ('@' format) so ISO timestamps are never
 * auto-converted and student input starting with "=" is never a formula.
 *
 * Concurrency rule: every write to Bookings/Meetings happens while holding the
 * script lock, on a row that was (re-)read inside that same lock.
 */
const MEETING_COLS = ['id', 'json', 'updatedAt'];
const BOOKING_COLS = [
  'id', 'token', 'meetingId', 'start', 'end', 'email', 'name', 'answers',
  'status', 'eventId', 'createdAt', 'updatedAt', 'cancelReason', 'cancelledBy',
  'reminderSent', 'conflictNote', 'history', 'studentEventId', 'pendingMail'
];
const MEETINGS_CACHE_KEY = 'meetings:v1';

let SS_ = null;
function db_() {
  if (SS_) return SS_;
  const id = prop_('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID not set. Run setup() first.');
  SS_ = SpreadsheetApp.openById(id);
  return SS_;
}

function sheet_(name) {
  const sh = db_().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet: ' + name);
  return sh;
}

function rowToObj_(row, cols, rowNum) {
  const o = { _row: rowNum };
  cols.forEach(function (c, j) { o[c] = row[j] === '' || row[j] == null ? '' : String(row[j]); });
  return o;
}

function readRows_(name, cols) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, cols.length).getValues().map(function (row, i) {
    return rowToObj_(row, cols, i + 2);
  });
}

function writeRow_(name, cols, rowNum, obj) {
  const sh = sheet_(name);
  const values = [cols.map(function (c) { return obj[c] == null ? '' : String(obj[c]); })];
  const row = rowNum || sh.getLastRow() + 1;
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 500); // sheets start with ~1000 rows
  const range = sh.getRange(row, 1, 1, cols.length);
  if (!rowNum) range.setNumberFormat('@'); // new rows may lie beyond the pre-formatted area
  range.setValues(values);
  return row;
}

/* ---------- Meetings ---------- */

function getMeetings_() {
  return readRows_('Meetings', MEETING_COLS)
    .filter(function (r) { return r.id && r.json; })
    .map(function (r) {
      const m = JSON.parse(r.json);
      m.id = r.id;
      m._row = r._row;
      return m;
    });
}

/** Fresh read with _row (use for writes and the admin page). */
function getMeeting_(id) {
  if (!id) return null;
  return getMeetings_().filter(function (m) { return m.id === id; })[0] || null;
}

/** Cached read (10 min, invalidated on save/delete) for the public API. */
function getMeetingCached_(id) {
  if (!id) return null;
  let list = null;
  const raw = cache_().get(MEETINGS_CACHE_KEY);
  if (raw) {
    try { list = JSON.parse(raw); } catch (e) { list = null; }
  }
  if (!list) {
    list = getMeetings_().map(function (m) { delete m._row; return m; });
    try { cache_().put(MEETINGS_CACHE_KEY, JSON.stringify(list), 600); } catch (e) { /* too large: skip */ }
  }
  return list.filter(function (m) { return m.id === id; })[0] || null;
}

function invalidateMeetings_() {
  cache_().remove(MEETINGS_CACHE_KEY);
}

function saveMeeting_(m) {
  const copy = Object.assign({}, m);
  const row = copy._row;
  delete copy._row;
  writeRow_('Meetings', MEETING_COLS, row, {
    id: copy.id,
    json: JSON.stringify(copy),
    updatedAt: new Date().toISOString()
  });
  invalidateMeetings_();
}

function deleteMeeting_(id) {
  const m = getMeeting_(id);
  if (m) sheet_('Meetings').deleteRow(m._row);
  invalidateMeetings_();
}

/* ---------- Bookings ---------- */

function getBookings_(filterFn) {
  const rows = readRows_('Bookings', BOOKING_COLS);
  return filterFn ? rows.filter(filterFn) : rows;
}

/** Finds one booking by its token without reading the whole sheet. */
function getBookingByToken_(token) {
  token = String(token || '');
  if (!/^[0-9a-f]{40}$/.test(token)) return null;
  const sh = sheet_('Bookings');
  const last = sh.getLastRow();
  if (last < 2) return null;
  const cell = sh.getRange(2, 2, last - 1, 1).createTextFinder(token).matchEntireCell(true).findNext();
  if (!cell) return null;
  const r = cell.getRow();
  return rowToObj_(sh.getRange(r, 1, 1, BOOKING_COLS.length).getValues()[0], BOOKING_COLS, r);
}

/** Adds header cells for columns introduced after the sheet was created. */
function ensureHeader_(name, cols) {
  const flag = 'HDR_' + name;
  if (prop_(flag) === String(cols.length)) return;   // already checked for this schema
  const sh = sheet_(name);
  const width = Math.max(sh.getLastColumn(), 1);
  const have = sh.getRange(1, 1, 1, width).getValues()[0];
  if (!(have.length >= cols.length && have[cols.length - 1] === cols[cols.length - 1])) {
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  }
  setProp_(flag, String(cols.length));
}

function addBooking_(b) {
  ensureHeader_('Bookings', BOOKING_COLS);
  b._row = writeRow_('Bookings', BOOKING_COLS, null, b);
  return b;
}

function updateBooking_(b, patch) {
  Object.assign(b, patch, { updatedAt: new Date().toISOString() });
  writeRow_('Bookings', BOOKING_COLS, b._row, b);
  return b;
}
