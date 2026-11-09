/**
 * Background jobs (installed by setup()):
 *   periodicJob      - every 10 min: pending work, calendar sync, reminders, conflict check
 *   onCalendarChange - when the primary calendar changes (throttled to once a
 *                      minute): calendar sync + conflict check
 *
 * Each run reads the sheet once and the calendar once (one Events.list over
 * all upcoming bookings). Sheet changes happen under the script lock; slow
 * work (emails, student calendar copies) is collected and done AFTER the lock
 * is released, so students' requests are never kept waiting.
 *
 * Deleting a booking's event in Google Calendar cancels the booking silently
 * (no email to anyone); the professor contacts the student directly.
 */

const REMINDER_QUOTA_RESERVE = 10; // keep this many daily mails for confirmations

function reminderDue_(m, startMs) {
  const h = Number(m.reminderHours) || 0;
  return h > 0 && startMs - Date.now() <= h * 60 * 60 * 1000;
}

function periodicJob() {
  // Interval changed in code -> reinstall triggers once (no manual setup() needed).
  if (prop_('PERIODIC_MINUTES') !== String(PERIODIC_MINUTES)) installTriggers_();
  runJob_(true);
}

function onCalendarChange() {
  // Our own inserts/patches also fire this trigger; once a minute is plenty
  // (availability itself reads the calendar live, this only syncs the sheet).
  if (cache_().get('calchg')) return;
  cache_().put('calchg', '1', 60);
  runJob_(false);
}

function runJob_(full) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  const outbox = { deliveries: [], reminders: [], mails: [] };
  try {
    const bookings = getBookings_();
    if (full) claimLeftovers_(bookings, outbox);

    const now = Date.now();
    const upcoming = bookings.filter(function (b) {
      return b.status === 'confirmed' && new Date(b.start).getTime() > now;
    });
    if (upcoming.length) {
      const meetings = {};
      getMeetings_().forEach(function (m) { meetings[m.id] = m; });
      const events = listEvents_(upcoming);              // primary calendar (owner events live here)
      syncDeletedEvents_(upcoming, events);
      const active = upcoming.filter(function (b) { return b.status === 'confirmed'; });
      if (full) queueReminders_(active, meetings, outbox);
      queueConflicts_(active, meetings, events.concat(listExtraEvents_(upcoming)), outbox);
    }
  } catch (e) {
    recordError_('자동 작업', e);
  } finally {
    lock.releaseLock();
  }
  if (full) {
    try { setProp_('LAST_JOB', String(Date.now())); } catch (e) { /* heartbeat only */ }   // see checkHeartbeat_
    try { checkQuota_(); } catch (e) { /* ignore */ }
  }

  // --- slow work, lock released ---
  outbox.deliveries.forEach(function (d) { deliverMail_(d.b, d.kinds); });
  outbox.reminders.forEach(function (r) {
    try {
      sendStudentMail_('reminder', r.m, r.b);
    } catch (e) {
      console.error('reminder failed for ' + r.b.id + ': ' + e);
      try { lockedUpdate_(r.b.token, function (fresh) { updateBooking_(fresh, { reminderSent: 'failed' }); }); } catch (e2) { /* ignore */ }
    }
  });
  outbox.mails.forEach(function (mail) {
    try { send_(mail.to, mail.subject, mail.body, mail.replyTo); } catch (e) { console.error('mail failed: ' + e); }
  });
}

/** All primary-calendar events (incl. deleted) from now to the last upcoming booking. */
function listEvents_(upcoming) {
  let maxEnd = 0;
  upcoming.forEach(function (b) { maxEnd = Math.max(maxEnd, new Date(b.end).getTime()); });
  const items = [];
  let pageToken;
  do {
    const res = Calendar.Events.list('primary', {
      timeMin: new Date().toISOString(),
      timeMax: new Date(maxEnd + 60 * MIN).toISOString(),
      singleEvents: true,
      showDeleted: true,
      maxResults: 2500,
      pageToken: pageToken
    });
    (res.items || []).forEach(function (ev) { items.push(ev); });
    pageToken = res.nextPageToken;
  } while (pageToken);
  return items;
}

/** Events of the extra busy calendars (for conflict warnings only). */
function listExtraEvents_(upcoming) {
  let maxEnd = 0;
  upcoming.forEach(function (b) { maxEnd = Math.max(maxEnd, new Date(b.end).getTime()); });
  const items = [];
  busyCalendarIds_().slice(1).forEach(function (calId) {
    try {
      let pageToken;
      do {
        const res = Calendar.Events.list(calId, {
          timeMin: new Date().toISOString(),
          timeMax: new Date(maxEnd + 60 * MIN).toISOString(),
          singleEvents: true,
          maxResults: 2500,
          pageToken: pageToken
        });
        (res.items || []).forEach(function (ev) { items.push(ev); });
        pageToken = res.nextPageToken;
      } while (pageToken);
    } catch (e) {
      // A deleted/unsubscribed or free-busy-only calendar is not a system fault: don't alert.
      if (isGoneError_(e) || /403|forbidden|notFound|not found|access/i.test(String(e && e.message))) {
        console.warn('extra calendar ' + calId + ' unreadable: ' + e);
      } else {
        recordError_('추가 캘린더 읽기', e);
      }
    }
  });
  return items;
}

/** Claims work the page never triggered via 'notify' (caller holds the lock). */
function claimLeftovers_(bookings, outbox) {
  const cutoff = Date.now() - 60 * 1000;
  bookings.filter(function (b) {
    return b.pendingMail && new Date(b.updatedAt).getTime() < cutoff;
  }).forEach(function (b) {
    try {
      outbox.deliveries.push({ b: b, kinds: claimPendingMail_(b) });
    } catch (e) {
      recordError_('밀린 메일', e);
    }
  });
}

/** Bookings whose owner event was deleted become 'cancelled' (no emails). */
function syncDeletedEvents_(upcoming, events) {
  const byId = {};
  events.forEach(function (ev) { byId[ev.id] = ev; });
  upcoming.forEach(function (b) {
    try {
      if (!b.eventId) return;
      const ev = byId[b.eventId];
      // Not in the listed range (e.g. moved far away by the professor): ask directly.
      if (ev ? ev.status === 'cancelled' : eventGone_(b.eventId)) cancelByCalendar_(b);
    } catch (e) {
      recordError_('캘린더 동기화', e);
    }
  });
}

function eventGone_(eventId) {
  try {
    return Calendar.Events.get('primary', eventId).status === 'cancelled';
  } catch (e) {
    return isGoneError_(e);
  }
}

function cancelByCalendar_(b) {
  deleteStudentEvent_(b);
  updateBooking_(b, { status: 'cancelled', cancelledBy: 'calendar', pendingMail: '' });
  rememberRecent_(b, true);
}

/** Single-booking version used by request handlers (caller holds the lock). */
function syncBooking_(b) {
  if (b && b.status === 'confirmed' && b.eventId && eventGone_(b.eventId)) cancelByCalendar_(b);
  return b;
}

/** Marks due reminders as sent (under the lock) and queues the mails. */
function queueReminders_(active, meetings, outbox) {
  let quota = MailApp.getRemainingDailyQuota();
  active.forEach(function (b) {
    const m = meetings[b.meetingId];
    if (!m || b.reminderSent || !reminderDue_(m, new Date(b.start).getTime())) return;
    if (quota <= REMINDER_QUOTA_RESERVE) return;   // try again next run (or tomorrow)
    quota--;
    try {
      updateBooking_(b, { reminderSent: new Date().toISOString() });
      outbox.reminders.push({ b: b, m: m });
    } catch (e) {
      recordError_('리마인더', e);
    }
  });
}

function eventRange_(ev) {
  if (ev.start && ev.start.date) {
    return { s: kst_(ev.start.date, '00:00').getTime(), e: kst_(ev.end.date, '00:00').getTime() };
  }
  return { s: new Date(ev.start.dateTime).getTime(), e: new Date(ev.end.dateTime).getTime() };
}

/**
 * Warn the professor (once per conflict) when another busy calendar event
 * overlaps a confirmed booking. Bookings are never cancelled by this check.
 */
function queueConflicts_(active, meetings, events, outbox) {
  const me = ownerEmail_().toLowerCase();
  const busy = events.filter(function (ev) {
    if (ev.status === 'cancelled' || ev.transparency === 'transparent' || !ev.start) return false;
    const self = (ev.attendees || []).filter(function (a) {
      return a.self || String(a.email).toLowerCase() === me;
    })[0];
    return !(self && self.responseStatus === 'declined');
  });

  active.forEach(function (b) {
    const m = meetings[b.meetingId];
    if (!m) return;
    try {
      const s = new Date(b.start).getTime(), e = new Date(b.end).getTime();
      const found = busy.filter(function (ev) {
        if (ev.id === b.eventId) return false;
        const r = eventRange_(ev);
        return r.s < e && r.e > s;
      }).map(function (ev) {
        return { key: ev.id, text: '겹치는 일정: ' + (ev.summary || '(제목 없음)') + ' ' + eventTimeLabel_(ev) };
      });

      const warned = b.conflictNote ? b.conflictNote.split(',') : [];
      const fresh = found.filter(function (f) { return warned.indexOf(f.key) === -1; });
      if (!fresh.length) return;

      const v = vars_(m, b);
      updateBooking_(b, { conflictNote: warned.concat(fresh.map(function (f) { return f.key; })).join(',') });
      outbox.mails.push({
        to: ownerEmail_(),
        replyTo: ownerEmail_(),
        subject: '[예약 충돌] ' + v.name + ' - ' + v.shortDate + ' ' + v.time,
        body: [
          '확정된 예약과 겹치는 일정이 있습니다. 예약은 자동으로 취소되지 않았습니다.',
          '',
          '- 미팅: ' + m.name,
          '- 일시: ' + v.date + ' ' + v.time,
          '- 학생: ' + v.name + ' <' + b.email + '>',
          ''
        ].concat(fresh.map(function (f) { return '- ' + f.text; }))
          .concat(['', '예약을 취소하려면 학생에게 연락한 뒤 구글 캘린더에서 예약 일정을 삭제하세요. (학생에게 자동 메일은 가지 않습니다)'])
          .join('\n')
      });
    } catch (err) {
      recordError_('충돌 확인', err);
    }
  });
}

function eventTimeLabel_(ev) {
  if (ev.start && ev.start.date) return '(종일)';
  return '(' + fmtTime_(ev.start.dateTime) + '-' + fmtTime_(ev.end.dateTime) + ')';
}
