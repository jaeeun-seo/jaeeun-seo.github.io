/**
 * Availability engine. All dates are 'yyyy-MM-dd' strings in Korea time,
 * all window times are 'HH:mm' strings.
 *
 * Meeting availability fields:
 *   mode: 'recurring' | 'dates'
 *   weekly:    { mon: [['14:00','17:00']], thu: [...], ... }   (recurring)
 *   overrides: { '2026-11-12': [['10:00','12:00']], '2026-11-19': [] }  (recurring; [] = day off)
 *   startDate / endDate: optional bounds for recurring
 *   rangeDays: how far ahead recurring meetings open (default 60)
 *   dates:     { '2026-11-03': [['10:00','17:00']], ... }       (dates mode)
 *   duration, minNoticeHours, bufferBefore, bufferAfter
 */
const DOW_KEYS = ['', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MIN = 60 * 1000;

function kst_(dateStr, hhmm) {
  return new Date(dateStr + 'T' + (hhmm || '00:00') + ':00+09:00');
}
function fmtDate_(d) { return Utilities.formatDate(new Date(d), TZ, 'yyyy-MM-dd'); }
function fmtTime_(d) { return Utilities.formatDate(new Date(d), TZ, 'HH:mm'); }
function todayStr_() { return fmtDate_(new Date()); }
function addDays_(dateStr, n) {
  return fmtDate_(kst_(dateStr, '12:00').getTime() + n * 24 * 60 * MIN);
}
function dowKey_(dateStr) {
  return DOW_KEYS[Number(Utilities.formatDate(kst_(dateStr, '12:00'), TZ, 'u'))];
}

function windowsFor_(m, dateStr) {
  if (m.mode === 'dates') return (m.dates || {})[dateStr] || [];
  const overrides = m.overrides || {};
  if (Object.prototype.hasOwnProperty.call(overrides, dateStr)) return overrides[dateStr];
  if (m.startDate && dateStr < m.startDate) return [];
  if (m.endDate && dateStr > m.endDate) return [];
  return (m.weekly || {})[dowKey_(dateStr)] || [];
}

/** Last date students may see for this meeting. */
function horizon_(m) {
  if (m.mode === 'dates') {
    const keys = Object.keys(m.dates || {}).sort();
    return keys.length ? keys[keys.length - 1] : todayStr_();
  }
  const rolling = addDays_(todayStr_(), Number(m.rangeDays) || DEFAULT_RANGE_DAYS);
  return m.endDate && m.endDate < rolling ? m.endDate : rolling;
}

/** First date with any configured availability (for the initial calendar month). */
function firstOpenDate_(m) {
  const today = todayStr_();
  if (m.mode === 'dates') {
    const keys = Object.keys(m.dates || {}).filter(function (d) { return d >= today; }).sort();
    return keys[0] || today;
  }
  return m.startDate && m.startDate > today ? m.startDate : today;
}

/**
 * Busy intervals [{s,e}] in ms: Google Calendar free/busy for the primary
 * calendar (respects "Free"/"Busy", so free and default all-day events are
 * ignored, busy all-day events block).
 *
 * The calendar is the source of truth: deleting a booking's event frees the
 * slot. Bookings written in the last few minutes are also counted (kept in
 * the script cache, no sheet read), to cover the short delay before a new
 * event appears in free/busy.
 */
const RECENT_BOOKING_MS = 5 * 60 * 1000;
const RECENT_KEY = 'recent:v1';

function recentBookings_() {
  let list = [];
  try { list = JSON.parse(cache_().get(RECENT_KEY) || '[]'); } catch (e) { list = []; }
  const cutoff = Date.now() - RECENT_BOOKING_MS;
  return list.filter(function (r) { return r.at > cutoff; });
}

/** Call inside the script lock after a booking is created/moved/cancelled. */
function rememberRecent_(b, remove) {
  const list = recentBookings_().filter(function (r) { return r.id !== b.id; });
  if (!remove) {
    list.push({ id: b.id, s: new Date(b.start).getTime(), e: new Date(b.end).getTime(), at: Date.now() });
  }
  cache_().put(RECENT_KEY, JSON.stringify(list), 900);
}

/** Removes [iv.s, iv.e) from every busy block (handles merged free/busy blocks). */
function subtractInterval_(busy, iv) {
  const out = [];
  busy.forEach(function (b) {
    if (b.e <= iv.s || b.s >= iv.e) { out.push(b); return; }
    if (b.s < iv.s) out.push({ s: b.s, e: iv.s });
    if (b.e > iv.e) out.push({ s: iv.e, e: b.e });
  });
  return out;
}

function getBusy_(fromMs, toMs, opts) {
  opts = opts || {};
  const res = Calendar.Freebusy.query({
    timeMin: new Date(fromMs).toISOString(),
    timeMax: new Date(toMs).toISOString(),
    timeZone: TZ,
    items: [{ id: 'primary' }]
  });
  const cals = res.calendars || {};
  const primary = cals.primary || cals[Object.keys(cals)[0]] || { busy: [] };
  const busy = (primary.busy || []).map(function (b) {
    return { s: new Date(b.start).getTime(), e: new Date(b.end).getTime() };
  });

  // The booking being rescheduled must not block itself (free/busy may have
  // merged it with an adjacent event, so cut its interval out).
  const own = opts.ignoreInterval ? subtractInterval_(busy, opts.ignoreInterval) : busy;

  recentBookings_().forEach(function (r) {
    if (r.id !== opts.ignoreBookingId && r.e > fromMs && r.s < toMs) own.push({ s: r.s, e: r.e });
  });
  return own;
}

function overlaps_(s, e, busy) {
  for (let i = 0; i < busy.length; i++) {
    if (busy[i].s < e && busy[i].e > s) return true;
  }
  return false;
}

/**
 * Available start times grouped by date:
 *   { '2026-11-11': ['14:00', '14:30'], ... }  (dates with no slots omitted)
 */
function computeSlots_(m, fromDate, toDate, opts) {
  if (m.paused) return {};
  const today = todayStr_();
  const last = horizon_(m);
  if (fromDate < today) fromDate = today;
  if (toDate > last) toDate = last;
  if (fromDate > toDate) return {};

  const dur = Number(m.duration) * MIN;
  const step = dur;   // slots start back to back
  const before = (Number(m.bufferBefore) || 0) * MIN;
  const after = (Number(m.bufferAfter) || 0) * MIN;
  const pad = Math.max(before, after);
  const earliest = Date.now() + (Number(m.minNoticeHours) || 0) * 60 * MIN;

  const busy = getBusy_(
    kst_(fromDate, '00:00').getTime() - 24 * 60 * MIN,
    kst_(toDate, '23:59').getTime() + 24 * 60 * MIN,
    opts
  );

  const out = {};
  for (let d = fromDate; d <= toDate; d = addDays_(d, 1)) {
    const times = [];
    windowsFor_(m, d).forEach(function (w) {
      const end = kst_(d, w[1]).getTime();
      for (let t = kst_(d, w[0]).getTime(); t + dur <= end; t += step) {
        if (t < earliest) continue;
        // Busy blocks don't carry their own buffer, so pad both sides with the larger one.
        if (overlaps_(t - pad, t + dur + pad, busy)) continue;
        times.push(fmtTime_(t));
      }
    });
    if (times.length) out[d] = times;
  }
  return out;
}

function isSlotAvailable_(m, dateStr, time, opts) {
  const slots = computeSlots_(m, dateStr, dateStr, opts);
  return (slots[dateStr] || []).indexOf(time) !== -1;
}
