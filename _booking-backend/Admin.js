/**
 * Admin page (served by the owner-only deployment) and the server functions
 * it calls through google.script.run. Every function re-checks that the
 * caller is the owner, so nothing here is usable from the public deployment.
 */

function isOwner_() {
  const me = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  return !!me && me === ownerEmail_().toLowerCase();
}

function requireOwner_() {
  if (!isOwner_()) throw new Error('권한이 없습니다.');
}

function adminPage_() {
  return HtmlService.createHtmlOutputFromFile('AdminPage')
    .setTitle('미팅 예약 관리')
    .setFaviconUrl('https://jaeeun-seo.github.io/assets/booking/icon-admin.png')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

const DOW_ALL = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------- read ---------- */

function adminLoad() {
  requireOwner_();
  return {
    meetings: getMeetings_().map(function (m) { delete m._row; return m; }),
    defaults: DEFAULT_TEMPLATES,
    bookUrl: bookUrl_(),
    host: hostName_(),
    owner: ownerEmail_(),
    sheetUrl: db_().getUrl(),
    holidays: upcomingHolidays_(180),
    lastJob: Number(prop_('LAST_JOB') || 0),
    calendars: listCalendars_(),
    mailQuota: MailApp.getRemainingDailyQuota()
  };
}

function adminBookings() {
  requireOwner_();
  const names = {};
  getMeetings_().forEach(function (m) { names[m.id] = m.name; });
  return getBookings_().map(function (b) {
    return {
      id: b.id,
      meetingId: b.meetingId,
      meeting: names[b.meetingId] || '(삭제된 미팅)',
      start: b.start,
      end: b.end,
      date: fmtDate_(b.start),
      dateLabel: shortDate_(b.start),
      time: fmtTime_(b.start) + '-' + fmtTime_(b.end),
      name: b.name,
      email: b.email,
      answers: parseAnswers_(b),
      status: b.status,
      cancelledBy: b.cancelledBy,
      cancelReason: b.cancelReason,
      createdAt: b.createdAt
    };
  }).sort(function (a, b) { return a.start < b.start ? -1 : 1; });
}

/** Public holidays from today through the next `days` days: [{date, label, name}]. */
function upcomingHolidays_(days) {
  const today = todayStr_(), last = addDays_(today, days);
  const out = [];
  [today.slice(0, 4), last.slice(0, 4)].filter(function (y, i, a) { return a.indexOf(y) === i; }).forEach(function (y) {
    const map = holidaysOfYear_(y);
    Object.keys(map).sort().forEach(function (d) {
      if (d >= today && d <= last) out.push({ date: d, label: shortDate_(kst_(d, '12:00')), name: map[d] });
    });
  });
  return out;
}

/* ---------- write ---------- */

function adminSaveMeeting(input) {
  requireOwner_();
  const m = cleanMeeting_(input);
  return withLock_(function () {
    const existing = m.id ? getMeeting_(m.id) : null;
    if (existing) m._row = existing._row;
    else m.id = newMeetingId_();
    saveMeeting_(m);
    delete m._row;
    return m;
  });
}

function adminDuplicateMeeting(id) {
  requireOwner_();
  return withLock_(function () {
    const src = getMeeting_(id);
    if (!src) throw new Error('미팅을 찾을 수 없습니다.');
    const copy = JSON.parse(JSON.stringify(src));
    delete copy._row;
    copy.id = newMeetingId_();
    copy.name = src.name + ' (복사본)';
    copy.paused = true;
    saveMeeting_(copy);
    return copy;
  });
}

function adminSetPaused(id, paused) {
  requireOwner_();
  withLock_(function () {
    const m = getMeeting_(id);
    if (!m) throw new Error('미팅을 찾을 수 없습니다.');
    m.paused = !!paused;
    saveMeeting_(m);
  });
  return true;
}

/** Refuses while the meeting still has upcoming bookings (their links would break). */
function adminDeleteMeeting(id) {
  requireOwner_();
  withLock_(function () {
    const now = Date.now();
    const n = getBookings_(function (b) {
      return b.meetingId === id && b.status === 'confirmed' && new Date(b.end).getTime() > now;
    }).map(syncBooking_)   // ones already deleted in Google Calendar don't count
      .filter(function (b) { return b.status === 'confirmed'; }).length;
    if (n) {
      throw new Error('예정된 예약이 ' + n + '건 있어서 삭제할 수 없습니다. 대신 일시정지하거나, ' +
        '구글 캘린더에서 해당 예약들을 지운 뒤 삭제하세요.');
    }
    deleteMeeting_(id);
  });
  return true;
}

/** The owner's calendars (except the hidden student-copy calendar), with busy-check flags. */
function listCalendars_() {
  const chosen = busyCalendarIds_();
  const studentCal = prop_('STUDENT_CAL_ID');
  return CalendarApp.getAllCalendars()
    .filter(function (c) { return c.getId() !== studentCal; })
    .map(function (c) {
      const primary = c.isMyPrimaryCalendar();
      return { id: c.getId(), name: c.getName(), primary: primary, busy: primary || chosen.indexOf(c.getId()) !== -1 };
    })
    .sort(function (a, b) { return (b.primary - a.primary) || a.name.localeCompare(b.name); });
}

function adminSaveSettings(s) {
  requireOwner_();
  const host = String((s && s.host) || '').trim().slice(0, 50);
  if (!host) throw new Error('이름을 입력해 주세요.');
  setProp_('HOST_NAME', host);
  if (s && s.busyCalendars) {
    const valid = listCalendars_().filter(function (c) { return !c.primary; }).map(function (c) { return c.id; });
    const ids = s.busyCalendars.filter(function (id) { return valid.indexOf(id) !== -1; });
    setProp_('BUSY_CAL_IDS', ids.join(','));
  }
  return true;
}

/* ---------- validation ---------- */

function str_(v, max) { return String(v == null ? '' : v).slice(0, max || 5000); }
function num_(v, min, max, def) {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const DOW_LABEL_ = { mon: '월요일', tue: '화요일', wed: '수요일', thu: '목요일', fri: '금요일', sat: '토요일', sun: '일요일' };

function cleanWindows_(list, label) {
  label = DOW_LABEL_[label] || label;
  const out = (list || []).map(function (w) {
    const s = String(w[0] || ''), e = String(w[1] || '');
    if (!TIME_RE.test(s) || !TIME_RE.test(e)) throw new Error(label + ': 시간 형식이 잘못되었습니다. (예: 09:30)');
    if (s >= e) throw new Error(label + ': 끝나는 시간이 시작 시간보다 늦어야 합니다. (' + s + '-' + e + ')');
    return [s, e];
  }).sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
  for (let i = 1; i < out.length; i++) {
    if (out[i][0] < out[i - 1][1]) {
      throw new Error(label + ': 시간대가 겹칩니다. (' + out[i - 1].join('-') + ', ' + out[i].join('-') + ')');
    }
  }
  return out;
}

function cleanDateMap_(map, allowEmpty) {
  const out = {};
  Object.keys(map || {}).forEach(function (d) {
    if (!DATE_RE.test(d)) throw new Error('날짜 형식이 잘못되었습니다: ' + d);
    const w = cleanWindows_(map[d], d);
    if (w.length || allowEmpty) out[d] = w;
  });
  return out;
}

function cleanMeeting_(x) {
  x = x || {};
  const name = str_(x.name, 100).trim();
  if (!name) throw new Error('미팅 이름을 입력해 주세요.');

  const weekly = {};
  DOW_ALL.forEach(function (k) {
    const w = cleanWindows_((x.weekly || {})[k], k);
    if (w.length) weekly[k] = w;
  });

  const keys = {};
  const questions = (x.questions || []).map(function (q, i) {
    const key = str_(q.key, 30).trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error((i + 1) + '번 질문의 변수명은 영문으로 시작하는 영문/숫자여야 합니다.');
    if (keys[key] || (key !== 'name' && key in DEFAULT_VARS_)) throw new Error('질문 변수명이 겹칩니다: ' + key);
    keys[key] = true;
    const label = str_(q.label, 100).trim();
    if (!label) throw new Error((i + 1) + '번 질문의 제목을 입력해 주세요.');
    return {
      key: key, label: label,
      type: q.type === 'textarea' ? 'textarea' : 'text',
      required: !!q.required,
      help: str_(q.help, 300).trim()
    };
  });

  const templates = {};
  Object.keys(DEFAULT_TEMPLATES).forEach(function (k) {
    if (x.templates && Object.prototype.hasOwnProperty.call(x.templates, k) && x.templates[k] != null) {
      const v = str_(x.templates[k], 5000);
      if (v !== DEFAULT_TEMPLATES[k]) templates[k] = v;
    }
  });

  const color = String(x.color || '');
  const m = {
    id: str_(x.id, 20),
    name: name,
    description: str_(x.description, 3000),
    duration: num_(x.duration, 5, 480, 30),
    location: str_(x.location, 200).trim(),
    color: /^([1-9]|1[01])$/.test(color) ? color : '',
    mode: x.mode === 'dates' ? 'dates' : 'recurring',
    weekly: weekly,
    overrides: cleanDateMap_(x.overrides, true),
    dates: cleanDateMap_(x.dates, false),
    startDate: DATE_RE.test(x.startDate || '') ? x.startDate : '',
    endDate: DATE_RE.test(x.endDate || '') ? x.endDate : '',
    rangeDays: num_(x.rangeDays, 1, 365, DEFAULT_RANGE_DAYS),
    minNoticeHours: num_(x.minNoticeHours, 0, 24 * 60, 0),
    bufferBefore: num_(x.bufferBefore, 0, 240, 0),
    bufferAfter: num_(x.bufferAfter, 0, 240, 0),
    reminderHours: num_(x.reminderHours, 0, 24 * 14, 0),
    addToStudentCalendar: x.addToStudentCalendar !== false,
    skipHolidays: x.skipHolidays !== false,
    paused: !!x.paused,
    questions: questions,
    confirmationMessage: str_(x.confirmationMessage, 2000),
    templates: templates
  };
  if (m.startDate && m.endDate && m.startDate > m.endDate) throw new Error('운영 기간의 시작일이 종료일보다 늦습니다.');
  return m;
}

/** Built-in template variable names (questions may not reuse them). */
const DEFAULT_VARS_ = {
  name: 0, email: 0, meeting: 0, date: 0, shortDate: 0, start: 0, end: 0, time: 0,
  duration: 0, location: 0, answers: 0, manageLink: 0, calendarLink: 0, bookLink: 0,
  host: 0, cancelReason: 0, previous: 0
};
