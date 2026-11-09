/**
 * Public booking actions: init/meeting info, slots, book, cancel, reschedule,
 * notify (deferred work).
 *
 * Rule: anything that writes a booking re-reads it and re-checks it INSIDE the
 * script lock, so concurrent requests and background jobs never overwrite
 * each other with stale data.
 */
// Plain ASCII addresses only (no display names, quotes, commas or angle brackets).
const EMAIL_RE = /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const MAX_ANSWER_LEN = 2000;

function apiError_(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

/** Meeting info safe to show students (no availability internals). */
function publicMeeting_(m) {
  return {
    id: m.id,
    name: m.name,
    description: m.description || '',
    duration: Number(m.duration),
    location: m.location || '',
    questions: (m.questions || []).map(function (q) {
      return { key: q.key, label: q.label, type: q.type || 'text', required: !!q.required, help: q.help || '' };
    }),
    host: hostName_(),
    paused: !!m.paused,
    firstDate: firstOpenDate_(m),
    lastDate: horizon_(m)
  };
}

function publicBooking_(b, m) {
  const history = parseHistory_(b);
  return {
    status: b.status,
    date: fmtDate_(b.start),
    start: fmtTime_(b.start),
    end: fmtTime_(b.end),
    dateLabel: korDate_(b.start),
    name: b.name,
    email: b.email,
    past: new Date(b.start).getTime() < Date.now(),
    canReschedule: history.length < MAX_RESCHEDULES,
    meeting: publicMeeting_(m)
  };
}

function parseHistory_(b) {
  try { return b.history ? JSON.parse(b.history) : []; } catch (e) { return []; }
}

function requireMeeting_(id) {
  const m = getMeetingCached_(id);
  if (!m) throw apiError_('NOT_FOUND', '존재하지 않는 미팅 링크입니다.');
  return m;
}

/** yyyy-MM-dd that is a real calendar date (rejects 2026-02-31 etc.). */
function requireDate_(s) {
  s = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || fmtDate_(kst_(s, '12:00')) !== s) {
    throw apiError_('BAD_REQUEST', '날짜 형식이 잘못되었습니다.');
  }
  return s;
}

function requireTime_(s) {
  s = String(s || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw apiError_('BAD_REQUEST', '시간 형식이 잘못되었습니다.');
  return s;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw apiError_('BUSY', '요청이 많습니다. 잠시 후 다시 시도해 주세요.');
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- read actions ---------- */

/** Meeting info + the first ~2 months of slots in one round trip. */
function apiInit_(p) {
  const m = requireMeeting_(p.m);
  const pm = publicMeeting_(m);
  const from = pm.firstDate;
  const to = addDays_(from, 61) < pm.lastDate ? addDays_(from, 61) : pm.lastDate;
  return { meeting: pm, slots: computeSlots_(m, from, to), slotsFrom: from, slotsTo: to };
}

function apiSlots_(p) {
  const m = requireMeeting_(p.m);
  const from = requireDate_(p.from);
  const to = requireDate_(p.to);
  if (kst_(to).getTime() - kst_(from).getTime() > 62 * 24 * 60 * MIN) {
    throw apiError_('BAD_REQUEST', '조회 기간이 너무 깁니다.');
  }
  const opts = {};
  if (p.t) {
    const b = getBookingByToken_(p.t);
    if (b && b.meetingId === m.id && b.status === 'confirmed') {
      opts.ignoreBookingId = b.id;
      opts.ignoreInterval = { s: new Date(b.start).getTime(), e: new Date(b.end).getTime() };
      opts.exclude = { date: fmtDate_(b.start), time: fmtTime_(b.start) }; // can't "move" to the same slot
    }
  }
  const slots = computeSlots_(m, from, to, opts);
  if (opts.exclude && slots[opts.exclude.date]) {
    slots[opts.exclude.date] = slots[opts.exclude.date].filter(function (t) { return t !== opts.exclude.time; });
    if (!slots[opts.exclude.date].length) delete slots[opts.exclude.date];
  }
  return { slots: slots };
}

/** Manage page. Only takes the lock when the calendar says the event is gone. */
function apiBooking_(p) {
  let b = getBookingByToken_(p.t);
  if (!b) throw apiError_('NOT_FOUND', '예약을 찾을 수 없습니다.');
  if (b.status === 'confirmed' && new Date(b.start).getTime() > Date.now() && b.eventId && eventGone_(b.eventId)) {
    b = withLock_(function () { return syncBooking_(getBookingByToken_(p.t)); });
  }
  const m = getMeetingCached_(b.meetingId);
  if (!m) throw apiError_('NOT_FOUND', '미팅이 삭제되었습니다.');
  return { booking: publicBooking_(b, m) };
}

/* ---------- write actions ---------- */

// Control and invisible formatting characters (bidi overrides, zero-width...).
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤﻿]/g;
const MAX_NAME_LEN = 20;

function cleanAnswers_(m, raw) {
  raw = raw || {};
  const out = {};
  (m.questions || []).forEach(function (q) {
    let v = String(raw[q.key] == null ? '' : raw[q.key]).replace(INVISIBLE_RE, '').trim();
    if (q.type === 'textarea') v = v.slice(0, MAX_ANSWER_LEN);
    else v = v.replace(/[\r\n\t]+/g, ' ').slice(0, q.key === 'name' ? MAX_NAME_LEN : 200).trim();
    if (q.required && !v) throw apiError_('BAD_REQUEST', '"' + q.label + '" 항목을 입력해 주세요.');
    if (v) out[q.key] = v;
  });
  return out;
}

function mergeKinds_(existing, add) {
  const out = String(existing || '').split(',').filter(String);
  add.split(',').forEach(function (k) { if (k && out.indexOf(k) === -1) out.push(k); });
  return out.join(',');
}

function apiBook_(p) {
  const m = requireMeeting_(p.m);
  if (m.paused) throw apiError_('PAUSED', '현재 예약을 받지 않는 미팅입니다.');
  const date = requireDate_(p.date);
  const time = requireTime_(p.time);
  const email = String(p.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) throw apiError_('BAD_REQUEST', '이메일 주소를 확인해 주세요.');
  const answers = cleanAnswers_(m, p.answers);

  const b = withLock_(function () {
    if (!isSlotAvailable_(m, date, time)) {
      throw apiError_('SLOT_TAKEN', '방금 다른 사람이 예약했거나 예약할 수 없는 시간입니다. 다른 시간을 선택해 주세요.');
    }
    const start = kst_(date, time);
    const end = new Date(start.getTime() + Number(m.duration) * MIN);
    const now = new Date().toISOString();
    const booking = {
      id: Utilities.getUuid(),
      token: Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8),
      meetingId: m.id,
      start: start.toISOString(),
      end: end.toISOString(),
      email: email,
      name: answers.name || '',
      answers: JSON.stringify(answers),
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
      // Booked inside the reminder window -> no separate reminder needed.
      reminderSent: reminderDue_(m, start.getTime()) ? 'skipped' : '',
      // The student's calendar copy and all emails are done by 'notify'.
      pendingMail: (wantsStudentEvent_(m) ? 'studentEvent,' : '') + 'confirm,ownerNew'
    };
    booking.eventId = Calendar.Events.insert(ownerEventResource_(m, booking), 'primary', { sendUpdates: 'none' }).id;
    try {
      addBooking_(booking);
    } catch (e) {
      removeEvent_('primary', booking.eventId); // don't leave a slot-blocking orphan
      throw e;
    }
    rememberRecent_(booking);
    return booking;
  });

  return {
    booking: publicBooking_(b, m),
    confirmationMessage: m.confirmationMessage || '',
    token: b.token,
    calendar: calendarInfo_(m, b)
  };
}

/** Data for the "add to calendar" buttons on the confirmation screen. */
function calendarInfo_(m, b) {
  const v = vars_(m, b);
  return {
    google: v.calendarLink,
    title: render_(tpl_(m, 'studentEventTitle'), v),
    location: m.location || '',
    start: b.start,
    end: b.end,
    uid: b.id,
    manageLink: v.manageLink
  };
}

/* ---------- deferred work ----------
 * Write actions record what they still owe in booking.pendingMail
 * ('studentEvent', student mails, owner mails) and return immediately. The
 * page then calls 'notify'; periodicJob picks up anything left over.
 * Delivery runs WITHOUT the script lock; its few sheet writes take the lock.
 */

/** Clears and returns the pending kinds. Caller must hold the script lock. */
function claimPendingMail_(b) {
  const kinds = String(b.pendingMail || '').split(',').filter(String);
  if (kinds.length) updateBooking_(b, { pendingMail: '' });
  return kinds;
}

function lockedUpdate_(token, fn) {
  return withLock_(function () {
    const fresh = getBookingByToken_(token);
    return fresh ? fn(fresh) : null;
  });
}

/** Performs claimed work; anything not done (error, quota) is put back for the next run. */
function deliverMail_(b, kinds) {
  if (!kinds.length) return;
  const m = getMeetingCached_(b.meetingId);
  if (!m) return;
  const todo = kinds.slice();
  try {
    if (todo.indexOf('studentEvent') !== -1) {
      if (b.status === 'confirmed' && !b.studentEventId) {
        const id = insertStudentEvent_(studentEventResource_(m, b));
        if (id) {
          lockedUpdate_(b.token, function (fresh) {
            // Cancelled, rescheduled or already given a student event meanwhile -> ours is surplus.
            if (fresh.status !== 'confirmed' || fresh.studentEventId || fresh.start !== b.start) {
              removeEvent_(prop_('STUDENT_CAL_ID'), id);
              return;
            }
            updateBooking_(fresh, { studentEventId: id });
          });
        }
      }
      todo.splice(todo.indexOf('studentEvent'), 1);
    }

    const history = parseHistory_(b);
    const previous = (history[history.length - 1] || {}).label || '';
    while (todo.length) {
      const k = todo[0];
      if (MailApp.getRemainingDailyQuota() < 1) break;   // keep the rest for later
      try {
        if (k === 'ownerNew') sendOwnerMail_('New', m, b);
        else if (k === 'ownerCancel') sendOwnerMail_('Cancel', m, b);
        else if (k === 'ownerReschedule') sendOwnerMail_('Reschedule', m, b, { previous: previous });
        else sendStudentMail_(k, m, b, { previous: previous });
      } catch (e) {
        console.error('mail ' + k + ' failed: ' + e);   // bad address etc.: don't retry forever
      }
      todo.shift();
    }
  } catch (e) {
    recordError_('메일·학생 일정', e);
  }
  if (todo.length) {
    try {
      lockedUpdate_(b.token, function (fresh) {
        updateBooking_(fresh, { pendingMail: mergeKinds_(fresh.pendingMail, todo.join(',')) });
      });
    } catch (e) {
      recordError_('메일 재대기', e);
    }
  }
}

function apiNotify_(p) {
  const b = getBookingByToken_(p.t);
  if (!b || !b.pendingMail) return {};
  let fresh = null, kinds = [];
  withLock_(function () {
    fresh = getBookingByToken_(p.t);
    kinds = fresh ? claimPendingMail_(fresh) : [];
  });
  if (fresh) deliverMail_(fresh, kinds);
  return {};
}

/** Re-reads and validates a booking. Call inside the script lock. */
function loadActiveBooking_(token) {
  const b = getBookingByToken_(token);
  if (!b) throw apiError_('NOT_FOUND', '예약을 찾을 수 없습니다.');
  syncBooking_(b);
  if (b.status !== 'confirmed') throw apiError_('NOT_ACTIVE', '이미 취소된 예약입니다.');
  if (new Date(b.start).getTime() < Date.now()) throw apiError_('PAST', '이미 지난 미팅입니다.');
  return b;
}

function apiCancel_(p) {
  let m = null;
  const b = withLock_(function () {
    const b = loadActiveBooking_(p.t);
    m = requireMeeting_(b.meetingId);
    deleteBookingEvents_(b);
    updateBooking_(b, {
      status: 'cancelled',
      cancelReason: String(p.reason || '').replace(INVISIBLE_RE, '').trim().slice(0, 500),
      cancelledBy: 'student',
      pendingMail: mergeKinds_(b.pendingMail, 'cancel,ownerCancel')
        .split(',').filter(function (k) { return k !== 'studentEvent'; }).join(',')
    });
    rememberRecent_(b, true);
    return b;
  });
  return { booking: publicBooking_(b, m) };
}

function apiReschedule_(p) {
  const date = requireDate_(p.date);
  const time = requireTime_(p.time);
  let m = null;

  const b = withLock_(function () {
    const b = loadActiveBooking_(p.t);
    m = getMeetingCached_(b.meetingId);
    if (!m) throw apiError_('NOT_FOUND', '미팅이 삭제되었습니다.');
    if (m.paused) throw apiError_('PAUSED', '현재 이 미팅은 일정 변경을 받지 않습니다.');
    const history = parseHistory_(b);
    if (history.length >= MAX_RESCHEDULES) {
      throw apiError_('LIMIT', '일정 변경은 최대 ' + MAX_RESCHEDULES + '번까지 할 수 있습니다. 취소 후 다시 예약해 주세요.');
    }
    if (fmtDate_(b.start) === date && fmtTime_(b.start) === time) {
      throw apiError_('SAME', '지금 예약과 같은 시간입니다. 다른 시간을 선택해 주세요.');
    }
    const opts = {
      ignoreBookingId: b.id,
      ignoreInterval: { s: new Date(b.start).getTime(), e: new Date(b.end).getTime() }
    };
    if (!isSlotAvailable_(m, date, time, opts)) {
      throw apiError_('SLOT_TAKEN', '예약할 수 없는 시간입니다. 다른 시간을 선택해 주세요.');
    }
    const start = kst_(date, time);
    const end = new Date(start.getTime() + Number(m.duration) * MIN);
    const moved = Object.assign({}, b, { start: start.toISOString(), end: end.toISOString() });
    const ids = moveBookingEvents_(m, moved);   // calendar first; throws -> sheet untouched
    history.push({ from: b.start, label: shortDate_(b.start) + ' ' + fmtTime_(b.start) + '-' + fmtTime_(b.end), at: new Date().toISOString() });
    updateBooking_(b, {
      start: moved.start,
      end: moved.end,
      eventId: ids.eventId,
      studentEventId: ids.studentEventId,
      reminderSent: reminderDue_(m, start.getTime()) ? 'skipped' : '',
      conflictNote: '',
      history: JSON.stringify(history),
      pendingMail: mergeKinds_(b.pendingMail, 'reschedule,ownerReschedule')
    });
    rememberRecent_(b);
    return b;
  });

  return { booking: publicBooking_(b, m) };
}

/* ---------- Google Calendar ----------
 * Each booking has two events so the professor and the student can see
 * different titles:
 *   owner event   - primary calendar, owner title, no guests. Source of truth
 *                   for availability; deleting it cancels the booking.
 *   student event - hidden secondary calendar ("<host> 미팅"), student title,
 *                   student added as an already-accepted guest so it appears in
 *                   their Google Calendar. Google never emails (sendUpdates: none).
 */

function isGoneError_(e) {
  return /not found|deleted|404|410/i.test(String(e && e.message));
}

/** Stored id is trusted; pass verify=true (after a failure) to re-check/recreate. */
function studentCalendarId_(verify) {
  const id = prop_('STUDENT_CAL_ID');
  if (id && (!verify || CalendarApp.getCalendarById(id))) return id;
  const cal = CalendarApp.createCalendar(hostName_() + ' 미팅', {
    summary: '미팅 예약 시스템이 학생 캘린더용 일정을 자동으로 관리합니다. 직접 수정하지 마세요.',
    timeZone: TZ,
    selected: false
  });
  setProp_('STUDENT_CAL_ID', cal.getId());
  return cal.getId();
}

function baseEvent_(b, m) {
  return {
    location: m.location || '',
    start: { dateTime: b.start, timeZone: TZ },
    end: { dateTime: b.end, timeZone: TZ },
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    extendedProperties: { private: { bookingId: b.id, meetingId: m.id } }
  };
}

function ownerEventResource_(m, b) {
  const v = vars_(m, b);
  const r = Object.assign(baseEvent_(b, m), {
    summary: render_(tpl_(m, 'eventTitle'), v),
    description: render_(tpl_(m, 'eventDescription'), v),
    transparency: 'opaque'
  });
  if (m.color) r.colorId = String(m.color);
  return r;
}

function studentEventResource_(m, b) {
  const v = vars_(m, b);
  return Object.assign(baseEvent_(b, m), {
    summary: render_(tpl_(m, 'studentEventTitle'), v),
    description: render_(tpl_(m, 'studentEventDescription'), v),
    transparency: 'transparent',
    attendees: [{ email: b.email, responseStatus: 'accepted' }]
  });
}

function wantsStudentEvent_(m) { return m.addToStudentCalendar !== false; }

/** Inserts into the student calendar; on failure re-checks/recreates the calendar once. */
function insertStudentEvent_(resource) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return Calendar.Events.insert(resource, studentCalendarId_(attempt > 0), { sendUpdates: 'none' }).id;
    } catch (e) {
      if (attempt > 0) recordError_('학생 캘린더 일정', e); // booking still valid; email has a calendar link
    }
  }
  return '';
}

/**
 * Moves both events to b.start/b.end; returns the (possibly new) event ids.
 * The owner event is only re-created if it was deleted; any other calendar
 * error is thrown so the caller leaves the booking unchanged.
 */
function moveBookingEvents_(m, b) {
  const out = { eventId: b.eventId, studentEventId: b.studentEventId || '' };
  const own = ownerEventResource_(m, b);
  try {
    Calendar.Events.patch({ start: own.start, end: own.end, summary: own.summary, description: own.description },
      'primary', b.eventId, { sendUpdates: 'none' });
  } catch (e) {
    if (!isGoneError_(e)) throw e;
    out.eventId = Calendar.Events.insert(own, 'primary', { sendUpdates: 'none' }).id;
  }

  if (!wantsStudentEvent_(m)) {
    if (out.studentEventId) removeEvent_(prop_('STUDENT_CAL_ID'), out.studentEventId);
    out.studentEventId = '';
    return out;
  }
  const st = studentEventResource_(m, b);
  if (out.studentEventId) {
    try {
      Calendar.Events.patch({ start: st.start, end: st.end, summary: st.summary, description: st.description },
        studentCalendarId_(), out.studentEventId, { sendUpdates: 'none' });
      return out;
    } catch (e) {
      if (!isGoneError_(e)) { console.error('student event move failed: ' + e); return out; }
    }
  }
  out.studentEventId = insertStudentEvent_(st);
  return out;
}

function removeEvent_(calId, eventId) {
  if (!calId || !eventId) return;
  try {
    Calendar.Events.remove(calId, eventId, { sendUpdates: 'none' });
  } catch (e) {
    // Already deleted - nothing to do.
  }
}

function deleteStudentEvent_(b) {
  if (b.studentEventId) removeEvent_(prop_('STUDENT_CAL_ID'), b.studentEventId);
}

function deleteBookingEvents_(b) {
  removeEvent_('primary', b.eventId);
  deleteStudentEvent_(b);
}
