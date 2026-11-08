/**
 * One-time setup. Run setup() once from the Apps Script editor (or via clasp)
 * after the first deployment. Safe to re-run: it never deletes data.
 */
function setup() {
  if (prop_('OWNER_EMAIL')) requireOwner_();
  if (!prop_('SPREADSHEET_ID')) {
    const ss = SpreadsheetApp.create('Meeting Booking DB');
    initSheet_(ss, 'Meetings', MEETING_COLS);
    initSheet_(ss, 'Bookings', BOOKING_COLS);
    const blank = ss.getSheetByName('Sheet1') || ss.getSheetByName('시트1');
    if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);
    setProp_('SPREADSHEET_ID', ss.getId());
  }
  if (!prop_('OWNER_EMAIL')) setProp_('OWNER_EMAIL', Session.getEffectiveUser().getEmail());
  if (!prop_('HOST_NAME')) setProp_('HOST_NAME', DEFAULT_HOST_NAME);
  if (!prop_('BOOK_URL')) setProp_('BOOK_URL', DEFAULT_BOOK_URL);

  if (!getMeetings_().length) saveMeeting_(sampleMeeting_());
  studentCalendarId_();
  installTriggers_();

  console.log('Spreadsheet: ' + db_().getUrl());
  getMeetings_().forEach(function (m) {
    console.log('Meeting "' + m.name + '": ' + bookUrl_() + '?m=' + m.id);
  });
}

function initSheet_(ss, name, cols) {
  const sh = ss.insertSheet(name);
  sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
  sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  sh.setFrozenRows(1);
}

const PERIODIC_MINUTES = 10;

function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('periodicJob').timeBased().everyMinutes(PERIODIC_MINUTES).create();
  ScriptApp.newTrigger('onCalendarChange').forUserCalendar(ownerEmail_()).onEventUpdated().create();
  setProp_('PERIODIC_MINUTES', String(PERIODIC_MINUTES));
}

/** 12 hex chars from a secure random UUID (48 bits; links are unguessable). */
function newMeetingId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

/** Mirrors the current Calendly "미팅 예약" event. Hours are placeholders. */
function sampleMeeting_() {
  return {
    id: newMeetingId_(),
    name: '미팅 예약',
    description: '예약시 이름은 한글로 입력하세요\n미팅에서 논의하고 싶은 내용을 정리한 문서가 있으면 메일로 보내주세요',
    duration: 30,
    location: '다산경제관 32308호',
    color: '3',
    mode: 'recurring',
    weekly: { wed: [['14:00', '17:00']], thu: [['14:00', '17:00']] },
    overrides: {},
    dates: {},
    rangeDays: 60,
    minNoticeHours: 12,
    bufferBefore: 0,
    bufferAfter: 0,
    reminderHours: 0,
    addToStudentCalendar: true,
    paused: false,
    questions: [
      { key: 'name', label: '이름', type: 'text', required: true, help: '한글로 입력하세요' }
    ],
    confirmationMessage: '미팅에서 논의하고 싶은 내용을 정리한 문서가 있으면 메일로 보내주세요.',
    templates: {}
  };
}
