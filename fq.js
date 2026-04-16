(function (w, d, undefined) {
  'use strict';

  // ─── Config ────────────────────────────────────────────────────────────────
  var INGEST_URL = 'https://api.veinanalytics.com/e';
  var PROJECT_KEY = w._fq_key || 'pk_test_abc123xyz';
  var COOKIE_NAME = '_fq_id';
  var COOKIE_TTL  = 365;   // days
  var SESSION_KEY = '_fq_sid';
  var SESSION_TTL = 30 * 60 * 1000; // 30 minutes in ms
  var BATCH_INTERVAL = 2000;         // flush queue every 2s
  var MAX_BATCH = 10;

  // ─── Stage classifier ──────────────────────────────────────────────────────
  var STAGE_MAP = {
    page_view:        'awareness',
    blog_read:        'awareness',
    ad_click:         'awareness',
    organic_landing:  'awareness',
    social_click:     'awareness',
    pricing_view:     'consideration',
    demo_watch:       'consideration',
    docs_visit:       'consideration',
    comparison_view:  'consideration',
    feature_tour:     'consideration',
    signup_start:     'conversion',
    signup_complete:  'conversion',
    trial_activate:   'conversion',
    payment_complete: 'conversion',
    onboard_finish:   'conversion',
    feature_used:     'retention',
    report_viewed:    'retention',
    invite_sent:      'retention',
    renewal:          'retention',
    return_visit:     'retention',
  };

  function classifyStage(eventName) {
    return STAGE_MAP[eventName] || null;
  }

  // ─── Cookie helpers ────────────────────────────────────────────────────────
  function getCookie(name) {
    var match = d.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function setCookie(name, value, days) {
    var expires = new Date(Date.now() + days * 864e5).toUTCString();
    d.cookie = name + '=' + encodeURIComponent(value)
      + '; expires=' + expires
      + '; path=/; SameSite=Lax';
  }

  // ─── UUID (RFC4122 v4, no crypto dependency) ───────────────────────────────
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // ─── Anonymous ID ──────────────────────────────────────────────────────────
  function getOrCreateAnonId() {
    var id = getCookie(COOKIE_NAME);
    if (!id) {
      id = uuid();
      setCookie(COOKIE_NAME, id, COOKIE_TTL);
    }
    return id;
  }

  // ─── Session ───────────────────────────────────────────────────────────────
  function getOrCreateSession() {
    var raw = null;
    try { raw = w.sessionStorage.getItem(SESSION_KEY); } catch (e) {}

    var session = null;
    if (raw) {
      try { session = JSON.parse(raw); } catch (e) {}
    }

    var now = Date.now();

    if (session && (now - session.last) < SESSION_TTL) {
      session.last = now;
    } else {
      // New session — either first visit or timed out
      session = { id: uuid(), start: now, last: now };
    }

    try { w.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
    return session.id;
  }

  // ─── UTM / referrer parsing ────────────────────────────────────────────────
  function getUtm() {
    var params = new URLSearchParams(w.location.search);
    var utm = {};
    ['source', 'medium', 'campaign', 'term', 'content'].forEach(function (k) {
      var v = params.get('utm_' + k);
      if (v) utm[k] = v;
    });
    return utm;
  }

  // ─── Event queue + batch flush ────────────────────────────────────────────
  var queue = [];
  var flushTimer = null;

  function flush() {
    if (!queue.length) return;
    var batch = queue.splice(0, MAX_BATCH);
  var key = PROJECT_KEY;

    var payload = JSON.stringify({ k: key, events: batch });

    // sendBeacon for reliability on page unload
    if (w.navigator.sendBeacon) {
      w.navigator.sendBeacon(INGEST_URL, new Blob([payload], { type: 'application/json' }));
    } else {
      // Fallback: fire-and-forget fetch
      try {
        fetch(INGEST_URL, {
          method: 'POST',
          body: payload,
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
        });
      } catch (e) {}
    }

    // If more events remain, schedule another flush
    if (queue.length) {
      flushTimer = setTimeout(flush, BATCH_INTERVAL);
    } else {
      flushTimer = null;
    }
  }

  function scheduleFlush() {
    if (!flushTimer) {
      flushTimer = setTimeout(flush, BATCH_INTERVAL);
    }
  }

  // ─── Core track function ───────────────────────────────────────────────────
  var anonId   = getOrCreateAnonId();
  var sessionId = getOrCreateSession();

  function track(eventName, properties) {
    var event = {
      n:   eventName,
      st:  classifyStage(eventName),
      aid: anonId,
      sid: sessionId,
      u:   w.location.href,
      r:   d.referrer,
      ts:  Date.now(),
    };

    var utm = getUtm();
    if (Object.keys(utm).length) event.utm = utm;
    if (properties)              event.p   = properties;

    queue.push(event);
    scheduleFlush();
  }

  // ─── Auto-capture ─────────────────────────────────────────────────────────

  // page_view on load
  track('page_view');

  // SPA navigation support — track on pushState / popstate
  var _pushState = w.history.pushState;
  w.history.pushState = function () {
    _pushState.apply(w.history, arguments);
    sessionId = getOrCreateSession(); // may start new session after timeout
    track('page_view');
  };
  w.addEventListener('popstate', function () {
    track('page_view');
  });

  // data-fq attribute auto-capture
  // Usage: <button data-fq="pricing_view">See pricing</button>
  d.addEventListener('click', function (e) {
    var el = e.target.closest('[data-fq]');
    if (el && el.dataset.fq) {
      track(el.dataset.fq);
    }
  }, true);

  // Flush remaining events before page unload
  w.addEventListener('visibilitychange', function () {
    if (d.visibilityState === 'hidden') flush();
  });

  // ─── Public API ───────────────────────────────────────────────────────────
  // Usage: funneliq('track', 'pricing_view', { plan: 'growth' })
  // Usage: funneliq('identify', 'user_123')
  w.funneliq = function (method, arg1, arg2) {
    if (method === 'track')    return track(arg1, arg2);
    if (method === 'identify') {
      // Attach user_id to all subsequent events
      w._fq_uid = arg1;
    }
  };

  // Replay any queued calls made before snippet loaded
  // Usage in page: funneliq = funneliq || []; funneliq.push(['track', 'demo_watch'])
  if (Array.isArray(w.funneliq)) {
    w.funneliq.forEach(function (args) { w.funneliq.apply(null, args); });
  }

}(window, document));
