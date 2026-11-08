/**
 * Global settings. Per-deployment values live in Script Properties
 * (Project Settings > Script properties) and are created by setup().
 *
 *   SPREADSHEET_ID  - database spreadsheet (auto-created by setup)
 *   OWNER_EMAIL     - professor's address (notifications, admin login)
 *   HOST_NAME       - name shown on booking pages / email sender name
 *   BOOK_URL        - public booking page URL on GitHub Pages
 *   STUDENT_CAL_ID  - hidden secondary calendar for student copies
 */
const TZ = 'Asia/Seoul';
const DEFAULT_BOOK_URL = 'https://jaeeun-seo.github.io/book/';
const DEFAULT_HOST_NAME = '서재은';
const DEFAULT_RANGE_DAYS = 60; // how far ahead recurring meetings are bookable

const MAX_RESCHEDULES = 5;            // per booking

// All script properties are read once per execution.
let PROPS_ = null;
function props_() {
  if (!PROPS_) PROPS_ = PropertiesService.getScriptProperties().getProperties();
  return PROPS_;
}
function prop_(key) {
  return props_()[key] || null;
}
function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
  props_()[key] = value;
}
function ownerEmail_() {
  return prop_('OWNER_EMAIL') || Session.getEffectiveUser().getEmail();
}
function hostName_() {
  return prop_('HOST_NAME') || DEFAULT_HOST_NAME;
}
function bookUrl_() {
  return prop_('BOOK_URL') || DEFAULT_BOOK_URL;
}
function cache_() {
  return CacheService.getScriptCache();
}
