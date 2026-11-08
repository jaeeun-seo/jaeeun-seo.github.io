/**
 * Templates and email sending.
 *
 * Template variables (usable in event title/description and all emails):
 *   {name} {email} {meeting} {date} {shortDate} {time} {start} {end} {duration}
 *   {location} {answers} {manageLink} {bookLink} {calendarLink} {host}
 *   {cancelReason} {previous} (old date/time, reschedule mails only)
 *   plus {<question key>} for every custom question (e.g. {studentId}).
 *
 * Student mails: confirm / reschedule / reminder / cancel (Subject + Body)
 * Owner mails:   ownerNew / ownerReschedule / ownerCancel (Subject + Body)
 * A meeting's `templates` overrides any key; an empty override means empty.
 */
const KOR_DOW = ['', '월', '화', '수', '목', '금', '토', '일'];

const DEFAULT_TEMPLATES = {
  // Professor's calendar event
  eventTitle: '미팅 ({name})',
  eventDescription: '이메일: {email}\n\n{answers}',
  // Student's calendar event
  studentEventTitle: '미팅 ({host})',
  studentEventDescription: '변경/취소: {manageLink}',

  confirmSubject: '[미팅 확정] {shortDate} {time}',
  confirmBody:
    '아래 일정으로 미팅이 예약되었습니다.\n\n' +
    '- 일시: {date} {time}\n- 장소: {location}\n\n' +
    '일정 변경이나 취소는 아래 링크에서 할 수 있습니다.\n{manageLink}\n\n' +
    '구글 캘린더에 자동으로 추가되지 않았다면 아래 링크로 추가하세요.\n{calendarLink}\n\n{host} 드림',
  rescheduleSubject: '[미팅 변경] {shortDate} {time}',
  rescheduleBody:
    '미팅 일정이 아래와 같이 변경되었습니다.\n\n' +
    '- 일시: {date} {time}\n- 장소: {location}\n\n' +
    '다시 변경하거나 취소하려면 아래 링크를 이용하세요.\n{manageLink}\n\n' +
    '구글 캘린더에 자동으로 반영되지 않았다면 아래 링크로 추가하세요.\n{calendarLink}\n\n{host} 드림',
  reminderSubject: '[미팅 알림] {shortDate} {time}',
  reminderBody:
    '예약하신 미팅을 알려드립니다.\n\n' +
    '- 일시: {date} {time}\n- 장소: {location}\n\n' +
    '일정 변경이나 취소는 아래 링크에서 할 수 있습니다.\n{manageLink}\n\n{host} 드림',
  cancelSubject: '[미팅 취소] {shortDate} {time}',
  cancelBody:
    '아래 미팅이 취소되었습니다.\n\n' +
    '- 미팅: {meeting}\n- 일시: {date} {time}\n{cancelReason}\n\n' +
    '다시 예약하려면 아래 링크를 이용하세요.\n{bookLink}\n\n{host} 드림',

  ownerNewSubject: '[새 예약] {name} - {shortDate} {time}',
  ownerNewBody: '',
  ownerRescheduleSubject: '[예약 변경] {name} - {shortDate} {time}',
  ownerRescheduleBody: '이전: {previous}',
  ownerCancelSubject: '[예약 취소] {name} - {shortDate} {time}',
  ownerCancelBody: '{cancelReason}'
};

function tpl_(m, key) {
  const t = m.templates || {};
  return Object.prototype.hasOwnProperty.call(t, key) && t[key] != null ? t[key] : DEFAULT_TEMPLATES[key];
}

function shortDate_(d) {
  d = new Date(d);
  return Utilities.formatDate(d, TZ, 'M월 d일') + ' (' + KOR_DOW[Number(Utilities.formatDate(d, TZ, 'u'))] + ')';
}

function korDate_(d) {
  d = new Date(d);
  return Utilities.formatDate(d, TZ, 'yyyy년 M월 d일') +
    ' (' + KOR_DOW[Number(Utilities.formatDate(d, TZ, 'u'))] + ')';
}

function parseAnswers_(b) {
  try { return b.answers ? JSON.parse(b.answers) : {}; } catch (e) { return {}; }
}

function vars_(m, b, extra) {
  const answers = parseAnswers_(b);
  const lines = (m.questions || [])
    .filter(function (q) { return answers[q.key]; })
    .map(function (q) { return q.label + ': ' + answers[q.key]; });
  const v = {
    name: b.name || b.email,
    email: b.email,
    meeting: m.name,
    date: korDate_(b.start),
    shortDate: shortDate_(b.start),
    start: fmtTime_(b.start),
    end: fmtTime_(b.end),
    time: fmtTime_(b.start) + '-' + fmtTime_(b.end),
    duration: m.duration + '분',
    location: m.location || '',
    answers: lines.join('\n'),
    manageLink: bookUrl_() + '?t=' + b.token,
    bookLink: bookUrl_() + '?m=' + m.id,
    host: hostName_(),
    cancelReason: b.cancelReason ? '- 사유: ' + b.cancelReason : ''
  };
  (m.questions || []).forEach(function (q) { if (q.key && !(q.key in v)) v[q.key] = ''; });
  Object.keys(answers).forEach(function (k) { if (!(k in v) || v[k] === '') v[k] = answers[k]; });
  Object.assign(v, extra || {});
  v.calendarLink = calendarLink_(m, b, render_(tpl_(m, 'studentEventTitle'), v));
  return v;
}

function utcStamp_(d) {
  return Utilities.formatDate(new Date(d), 'UTC', "yyyyMMdd'T'HHmmss'Z'");
}

/** "Add to Google Calendar" link for the student's own copy of the meeting. */
function calendarLink_(m, b, title) {
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    '&text=' + encodeURIComponent(title || m.name) +
    '&dates=' + utcStamp_(b.start) + '/' + utcStamp_(b.end) +
    '&location=' + encodeURIComponent(m.location || '') +
    '&details=' + encodeURIComponent('변경/취소: ' + bookUrl_() + '?t=' + b.token);
}

/** .ics file (METHOD:PUBLISH: "add to calendar", no RSVP back to anyone). */
function icsBlob_(m, b) {
  const v = vars_(m, b);
  const esc = function (s) { return String(s || '').replace(/([\\;,])/g, '\\$1').replace(/\r\n|\r|\n/g, '\\n'); };
  const text = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//jaeeun-seo.github.io//booking//KO', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:' + b.id + '@jaeeun-seo.github.io',
    'SEQUENCE:' + parseHistory_(b).length,
    'DTSTAMP:' + utcStamp_(new Date()),
    'DTSTART:' + utcStamp_(b.start),
    'DTEND:' + utcStamp_(b.end),
    'SUMMARY:' + esc(render_(tpl_(m, 'studentEventTitle'), v)),
    'LOCATION:' + esc(m.location),
    'DESCRIPTION:' + esc('변경/취소: ' + v.manageLink),
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
  return Utilities.newBlob(text, 'text/calendar', 'meeting.ics');
}

function render_(template, v) {
  return String(template || '')
    .replace(/\{([^{}\s]+)\}/g, function (all, k) {
      return Object.prototype.hasOwnProperty.call(v, k) ? v[k] : all;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/**
 * Plain text -> HTML. Only the system's own links (booking page, Google
 * Calendar) become clickable, so text typed by a student can never turn into
 * a phishing link in an email sent from the professor's account.
 */
function toHtml_(text) {
  const own = [bookUrl_(), 'https://calendar.google.com/'];
  const linked = escapeHtml_(text).replace(/(https?:\/\/[^\s<]+)/g, function (url) {
    const raw = url.replace(/&amp;/g, '&');
    if (!own.some(function (p) { return raw.indexOf(p) === 0; })) return url;
    const label = raw.indexOf('https://calendar.google.com/') === 0 ? 'Google 캘린더에 추가' : url;
    return '<a href="' + url + '">' + label + '</a>';
  });
  return '<div style="font-family:sans-serif;font-size:14px;line-height:1.6">' +
    linked.replace(/\n/g, '<br>') + '</div>';
}

function send_(to, subject, body, replyTo, attachments) {
  const msg = {
    to: to,
    subject: String(subject || '').replace(/[\r\n]+/g, ' ').slice(0, 200),
    body: body || ' ',
    name: hostName_(),
    replyTo: replyTo || ownerEmail_()
  };
  if (body) msg.htmlBody = toHtml_(body);
  if (attachments) msg.attachments = attachments;
  MailApp.sendEmail(msg);
}

/** kind: 'confirm' | 'reschedule' | 'reminder' | 'cancel' */
function sendStudentMail_(kind, m, b, extra) {
  extra = Object.assign({}, extra || {});
  // A reason the student typed is never echoed back in our name (only the owner sees it).
  if (b.cancelledBy === 'student') extra.cancelReason = '';
  const v = vars_(m, b, extra);
  const attach = kind === 'confirm' || kind === 'reschedule' ? [icsBlob_(m, b)] : null;
  send_(b.email, render_(tpl_(m, kind + 'Subject'), v), render_(tpl_(m, kind + 'Body'), v), null, attach);
  return true;
}

/** kind: 'New' | 'Reschedule' | 'Cancel'. Replies go straight to the student. */
function sendOwnerMail_(kind, m, b, extra) {
  const v = vars_(m, b, extra);
  send_(ownerEmail_(), render_(tpl_(m, 'owner' + kind + 'Subject'), v),
    render_(tpl_(m, 'owner' + kind + 'Body'), v), b.email);
}
