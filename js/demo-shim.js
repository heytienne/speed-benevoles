/* Mode démo : simule Google Sheets dans le navigateur pour exécuter backend/Code.js sans compte Google. */
(function () {
  var KEY = 'speed_demo_db';
  var db;
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) { db = null; }
  db = db || { sheets: {}, props: {} };
  var cache = {};

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* démo en mémoire seulement */ }
  }
  function clean(v) {
    return typeof v === 'string' && v.charAt(0) === "'" ? v.slice(1) : v;
  }

  function Sheet(name) { this.name = name; }
  Sheet.prototype = {
    rows: function () { return db.sheets[this.name]; },
    getDataRange: function () {
      var rows = this.rows();
      return { getValues: function () { return rows.map(function (r) { return r.slice(); }); } };
    },
    getLastRow: function () { return this.rows().length; },
    getMaxRows: function () { return 1000; },
    appendRow: function (r) { this.rows().push(r.map(clean)); save(); },
    deleteRow: function (n) { this.rows().splice(n - 1, 1); save(); },
    setFrozenRows: function () {},
    getRange: function (r, c) {
      var rows = this.rows();
      return {
        setValue: function (v) { rows[r - 1][c - 1] = clean(v); save(); },
        setNumberFormat: function () {},
        setValues: function (values) {
          values.forEach(function (line, i) {
            rows[r - 1 + i] = rows[r - 1 + i] || [];
            line.forEach(function (v, j) { rows[r - 1 + i][c - 1 + j] = clean(v); });
          });
          save();
        },
        clearContent: function () { rows.length = r - 1; save(); }
      };
    },
    copyTo: function () { return { setName: function () {} }; }
  };

  var ss = {
    getSheetByName: function (n) { return db.sheets[n] ? new Sheet(n) : null; },
    insertSheet: function (n) { db.sheets[n] = []; return new Sheet(n); }
  };

  function bytes(str) {
    // Empreinte de démo uniquement, le vrai backend utilise SHA-256.
    var out = [], h = 2166136261;
    for (var i = 0; i < 32; i++) {
      for (var j = 0; j < str.length; j++) { h ^= str.charCodeAt(j); h = Math.imul(h, 16777619); }
      h ^= i;
      out.push(h & 255);
    }
    return out;
  }
  function b64(v) {
    var s = typeof v === 'string' ? unescape(encodeURIComponent(v)) : String.fromCharCode.apply(null, v);
    return btoa(s);
  }

  window.SpreadsheetApp = { getActive: function () { return ss; }, flush: function () {} };
  window.LockService = { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } };
  window.PropertiesService = {
    getScriptProperties: function () {
      return {
        getProperty: function (k) { return db.props[k] || null; },
        setProperty: function (k, v) { db.props[k] = v; save(); }
      };
    }
  };
  window.CacheService = {
    getScriptCache: function () {
      return {
        get: function (k) { return k in cache ? cache[k] : null; },
        put: function (k, v) { cache[k] = v; },
        remove: function (k) { delete cache[k]; }
      };
    }
  };
  window.ContentService = {
    MimeType: { JSON: 'json' },
    createTextOutput: function (s) {
      return { setMimeType: function () { return { getContent: function () { return s; } }; } };
    }
  };
  // Aucun vrai mail en démo : le contenu s'affiche à l'écran.
  window.MailApp = {
    sendEmail: function (mail) { window.alert('Mail à ' + mail.to + '\n\n' + mail.body); }
  };
  window.Session = { getScriptTimeZone: function () { return 'Europe/Paris'; } };
  window.Utilities = {
    DigestAlgorithm: { SHA_256: 'sha' }, Charset: { UTF_8: 'utf8' },
    getUuid: function () { return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36); },
    computeDigest: function (a, s) { return bytes(s); },
    computeHmacSha256Signature: function (v, k) { return bytes(k + v); },
    base64Encode: b64,
    base64EncodeWebSafe: function (v) { return b64(v).replace(/\+/g, '-').replace(/\//g, '_'); },
    formatDate: function (d, tz, fmt) {
      function p(n) { return (n < 10 ? '0' : '') + n; }
      return fmt
        .replace('yyyy', d.getFullYear()).replace('MM', p(d.getMonth() + 1)).replace('dd', p(d.getDate()))
        .replace('HH', p(d.getHours())).replace('mm', p(d.getMinutes()));
    }
  };

  window.speedDemoInit = function () {
    if (db.sheets.Utilisateurs && db.sheets.Utilisateurs.length > 1) return;
    db = { sheets: {}, props: {} };
    window.initialiser();
    window.seedExample_(window.isoDay_(new Date(), 1), window.isoDay_(new Date(), 2));
    save();
  };
  window.speedDemoReset = function () {
    try { localStorage.removeItem(KEY); } catch (e) { /* rien à effacer */ }
    db = { sheets: {}, props: {} };
    window.speedDemoInit();
  };
})();
