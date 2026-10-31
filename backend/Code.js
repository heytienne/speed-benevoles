/**
 * Speed Festival - Backend de l'appli bénévoles (Google Apps Script).
 * A coller dans l'éditeur Apps Script du Google Sheet (voir README.md).
 * Le mode démo de l'appli exécute ce même fichier dans le navigateur.
 */

var SHEETS = {
  USERS: 'Utilisateurs',
  SHIFTS: 'Shifts',
  ASSIGN: 'Affectations',
  COMMENTS: 'Commentaires',
  SMS: 'ModelesSMS',
  LOG: 'Journal'
};

var HEADERS = {
  Utilisateurs: ['id', 'nom', 'telephone', 'email', 'genre', 'mot_de_passe', 'poles'],
  Shifts: ['id', 'pole', 'intitule', 'date', 'debut', 'fin', 'lieu', 'nb_requis'],
  Affectations: ['shift_id', 'benevole_id'],
  Commentaires: ['id', 'benevole_id', 'manager_id', 'manager_nom', 'date', 'texte'],
  ModelesSMS: ['id', 'titre', 'texte'],
  Journal: ['date', 'manager', 'action', 'detail']
};

var TOKEN_DAYS = 14;
var HASH_ROUNDS = 200;
var MAX_LOGIN_FAILS = 5;
var LOCK_SECONDS = 900;

/* ---------- Point d'entrée HTTP ---------- */

function doGet() {
  return json_({ ok: true, data: { service: 'speed-benevoles' } });
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    return json_({ ok: true, data: route_(req) });
  } catch (err) {
    if (!err.publicMessage) console.error(err);
    return json_({
      ok: false,
      error: err.publicMessage || 'Erreur serveur, réessayez.',
      code: err.code || 'server',
      details: err.details || null
    });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(message, code, details) {
  var err = new Error(message);
  err.publicMessage = message;
  err.code = code || 'invalid';
  err.details = details;
  throw err;
}

function route_(req) {
  if (req.action === 'login') return login_(req);
  var user = authenticate_(req.token);
  switch (req.action) {
    case 'dashboard':
      return isManager_(user) ? managerDashboard_(user) : benevoleDashboard_(user);
    case 'assign':
      return withLock_(function () { return assign_(requireManager_(user), req); });
    case 'unassign':
      return withLock_(function () { return unassign_(requireManager_(user), req); });
    case 'replace':
      return withLock_(function () { return replace_(requireManager_(user), req); });
    case 'addComment':
      return withLock_(function () { return addComment_(requireManager_(user), req); });
    case 'deleteComment':
      return withLock_(function () { return deleteComment_(requireManager_(user), req); });
    default:
      fail_('Action inconnue.');
  }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var result = fn();
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Lecture / écriture des feuilles ---------- */

function sheet_(name) {
  var s = SpreadsheetApp.getActive().getSheetByName(name);
  if (!s) fail_('Feuille "' + name + '" absente : lancez le menu Speed > Initialiser.', 'setup');
  return s;
}

function readTable_(name) {
  var values = sheet_(name).getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = { _row: i + 1 };
    var empty = true;
    for (var c = 0; c < headers.length; c++) {
      row[headers[c]] = values[i][c];
      if (values[i][c] !== '') empty = false;
    }
    if (!empty) rows.push(row);
  }
  return rows;
}

// Empêche qu'un texte saisi dans l'appli soit interprété comme une formule par le Sheet.
function safeCell_(v) {
  var s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function str_(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function normName_(v) {
  return str_(v).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
}

function pad_(n) {
  return (n < 10 ? '0' : '') + n;
}

// Le Sheet peut renvoyer un Date, "2026-08-28" ou "28/08/2026" selon le format de la cellule.
function normDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var s = str_(v), m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1] + '-' + pad_(+m[2]) + '-' + pad_(+m[3]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return m[3] + '-' + pad_(+m[2]) + '-' + pad_(+m[1]);
  return '';
}

function normTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
  var m = str_(v).match(/^(\d{1,2})\s*[:hH]\s*(\d{0,2})/);
  return m ? pad_(+m[1]) + ':' + pad_(+(m[2] || 0)) : '';
}

// Un numéro saisi sans format texte perd son 0 initial dans le Sheet.
function normPhone_(v) {
  var s = str_(v).replace(/[\s.\-()]/g, '');
  return /^\d{9}$/.test(s) ? '0' + s : s;
}

function splitPoles_(v) {
  return str_(v).split(/[,;|]/).map(function (p) { return p.trim(); }).filter(String);
}

function isManager_(user) {
  return normName_(user.genre) === 'manager';
}

function requireManager_(user) {
  if (!isManager_(user)) fail_('Réservé aux managers.', 'forbidden');
  return user;
}

function loadUsers_() {
  return readTable_(SHEETS.USERS).map(function (u) {
    u.id = str_(u.id);
    u.nom = str_(u.nom);
    u.telephone = normPhone_(u.telephone);
    u.email = str_(u.email);
    u.poleList = splitPoles_(u.poles);
    return u;
  }).filter(function (u) { return u.id && u.nom; });
}

function loadShifts_() {
  return readTable_(SHEETS.SHIFTS).map(function (r) {
    var s = {
      id: str_(r.id), pole: str_(r.pole), intitule: str_(r.intitule), date: normDate_(r.date),
      debut: normTime_(r.debut), fin: normTime_(r.fin), lieu: str_(r.lieu), nbRequis: Number(r.nb_requis) || 0
    };
    var range = shiftRange_(s);
    s.start = range.start;
    s.end = range.end;
    s.heures = (range.end - range.start) / 60;
    return s;
  }).filter(function (s) { return s.id && s.date && s.debut && s.fin; }).sort(function (a, b) {
    return a.start - b.start || a.pole.localeCompare(b.pole);
  });
}

// Minutes absolues ; une fin avant le début signifie que le shift finit le lendemain (22h -> 2h).
function shiftRange_(s) {
  var d = s.date.split('-');
  var base = Date.UTC(+d[0], +d[1] - 1, +d[2]) / 60000;
  var a = s.debut.split(':'), b = s.fin.split(':');
  var start = base + (+a[0]) * 60 + (+a[1]);
  var end = base + (+b[0]) * 60 + (+b[1]);
  if (end <= start) end += 1440;
  return { start: start, end: end };
}

function loadAssignments_() {
  return readTable_(SHEETS.ASSIGN).map(function (a) {
    return { shiftId: str_(a.shift_id), benevoleId: str_(a.benevole_id), _row: a._row };
  });
}

function log_(user, action, detail) {
  sheet_(SHEETS.LOG).appendRow([new Date().toISOString(), safeCell_(user.nom), action, safeCell_(detail)]);
}

/* ---------- Authentification ---------- */

function secret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('TOKEN_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('TOKEN_SECRET', s);
  }
  return s;
}

function sign_(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(value, secret_()));
}

function hash_(password, salt) {
  var value = salt + password;
  for (var i = 0; i < HASH_ROUNDS; i++) {
    value = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + value, Utilities.Charset.UTF_8));
  }
  return value;
}

function makeHash_(password) {
  var salt = Utilities.getUuid();
  return 'sha256$' + salt + '$' + hash_(password, salt);
}

function checkPassword_(stored, password) {
  var s = str_(stored);
  if (s.indexOf('sha256$') !== 0) return s !== '' && s === password;
  var parts = s.split('$');
  return hash_(password, parts[1]) === parts[2];
}

function login_(req) {
  var name = normName_(req.nom);
  var password = String(req.password === undefined ? '' : req.password).trim();
  if (!name || !password) fail_('Renseignez votre nom et votre mot de passe.');

  var cache = CacheService.getScriptCache();
  var failKey = 'fail_' + Utilities.base64EncodeWebSafe(name).slice(0, 200);
  var fails = Number(cache.get(failKey)) || 0;
  if (fails >= MAX_LOGIN_FAILS) fail_('Trop de tentatives. Réessayez dans 15 minutes.', 'locked');

  var candidates = loadUsers_().filter(function (u) { return normName_(u.nom) === name; });
  var user = null;
  candidates.forEach(function (u) {
    if (!user && checkPassword_(u.mot_de_passe, password)) user = u;
  });
  if (!user) {
    cache.put(failKey, String(fails + 1), LOCK_SECONDS);
    fail_('Nom ou mot de passe incorrect.', 'auth');
  }
  cache.remove(failKey);

  // Un mot de passe encore en clair dans le Sheet est chiffré dès la première connexion.
  if (str_(user.mot_de_passe).indexOf('sha256$') !== 0) {
    var col = HEADERS.Utilisateurs.indexOf('mot_de_passe') + 1;
    sheet_(SHEETS.USERS).getRange(user._row, col).setValue(makeHash_(password));
  }

  var payload = encodeURIComponent(user.id) + '.' + (Date.now() + TOKEN_DAYS * 86400000);
  return { token: payload + '.' + sign_(payload), user: publicUser_(user) };
}

function authenticate_(token) {
  var parts = str_(token).split('.');
  if (parts.length !== 3) fail_('Session expirée.', 'auth');
  var payload = parts[0] + '.' + parts[1];
  if (sign_(payload) !== parts[2] || Number(parts[1]) < Date.now()) fail_('Session expirée.', 'auth');
  var id = decodeURIComponent(parts[0]);
  var user = loadUsers_().filter(function (u) { return u.id === id; })[0];
  if (!user) fail_('Session expirée.', 'auth');
  return user;
}

function publicUser_(u) {
  return { id: u.id, nom: u.nom, role: isManager_(u) ? 'manager' : 'benevole', poles: u.poleList };
}

function contact_(u) {
  return { id: u.id, nom: u.nom, telephone: u.telephone, email: u.email };
}

/* ---------- Vue bénévole ---------- */

function benevoleDashboard_(user) {
  var users = loadUsers_();
  var managers = users.filter(isManager_);
  var benevoles = users.filter(function (u) { return !isManager_(u); });
  var shifts = loadShifts_();
  var assignments = loadAssignments_();

  function referentsOf(pole) {
    return managers.filter(function (m) {
      return m.poleList.some(function (p) { return normName_(p) === normName_(pole); });
    }).map(contact_);
  }

  var mine = {};
  var festivalHours = 0;
  var shiftById = {};
  shifts.forEach(function (s) { shiftById[s.id] = s; });
  assignments.forEach(function (a) {
    var s = shiftById[a.shiftId];
    if (!s) return;
    festivalHours += s.heures;
    if (a.benevoleId === user.id) mine[s.id] = true;
  });

  var myShifts = shifts.filter(function (s) { return mine[s.id]; }).map(function (s) {
    var copy = JSON.parse(JSON.stringify(s));
    copy.referents = referentsOf(s.pole);
    return copy;
  });

  return {
    user: publicUser_(user),
    shifts: myShifts,
    festival: { benevoles: benevoles.length, shifts: shifts.length, heures: festivalHours }
  };
}

/* ---------- Vue manager ---------- */

function managerDashboard_(user) {
  var users = loadUsers_();
  var poles = user.poleList.map(normName_);
  var shifts = loadShifts_();
  var assignments = loadAssignments_();
  var byId = {};
  shifts.forEach(function (s) { byId[s.id] = s; });

  var benevoles = users.filter(function (u) { return !isManager_(u); });
  var benevoleById = {};
  benevoles.forEach(function (b) { benevoleById[b.id] = b; });

  var busy = {};
  var onShift = {};
  assignments.forEach(function (a) {
    var s = byId[a.shiftId];
    if (!s || !benevoleById[a.benevoleId]) return;
    (busy[a.benevoleId] = busy[a.benevoleId] || []).push({
      shiftId: s.id, intitule: s.intitule, pole: s.pole, date: s.date, debut: s.debut, fin: s.fin, start: s.start, end: s.end
    });
    (onShift[s.id] = onShift[s.id] || []).push(a.benevoleId);
  });

  var myShifts = shifts.filter(function (s) {
    return poles.indexOf(normName_(s.pole)) !== -1;
  }).map(function (s) {
    var copy = JSON.parse(JSON.stringify(s));
    copy.benevoleIds = onShift[s.id] || [];
    return copy;
  });

  var onMyPoles = {};
  myShifts.forEach(function (s) {
    s.benevoleIds.forEach(function (id) { onMyPoles[id] = true; });
  });

  var comments = readTable_(SHEETS.COMMENTS).map(function (c) {
    return {
      id: str_(c.id), benevoleId: str_(c.benevole_id), managerId: str_(c.manager_id),
      managerNom: str_(c.manager_nom), date: str_(c.date), texte: str_(c.texte)
    };
  }).filter(function (c) { return onMyPoles[c.benevoleId] || c.managerId === user.id; });

  var templates = readTable_(SHEETS.SMS).map(function (t) {
    return { id: str_(t.id), titre: str_(t.titre), texte: str_(t.texte) };
  });

  return {
    user: publicUser_(user),
    poles: user.poleList,
    shifts: myShifts,
    benevoles: benevoles.map(function (b) {
      var c = contact_(b);
      c.busy = busy[b.id] || [];
      c.surMesPoles = !!onMyPoles[b.id];
      return c;
    }).sort(function (a, b) { return a.nom.localeCompare(b.nom); }),
    comments: comments,
    templates: templates
  };
}

function requireShift_(user, shiftId) {
  var shift = loadShifts_().filter(function (s) { return s.id === str_(shiftId); })[0];
  if (!shift) fail_('Shift introuvable.', 'notfound');
  var allowed = user.poleList.some(function (p) { return normName_(p) === normName_(shift.pole); });
  if (!allowed) fail_("Ce shift n'est pas dans vos pôles.", 'forbidden');
  return shift;
}

function requireBenevole_(id) {
  var b = loadUsers_().filter(function (u) { return u.id === str_(id) && !isManager_(u); })[0];
  if (!b) fail_('Bénévole introuvable.', 'notfound');
  return b;
}

// Refuse un chevauchement d'horaires, sauf si le manager a confirmé (force).
function checkConflict_(shift, benevole, ignoreShiftId, force) {
  if (force) return;
  var shifts = loadShifts_();
  var conflicts = loadAssignments_().filter(function (a) {
    return a.benevoleId === benevole.id && a.shiftId !== ignoreShiftId;
  }).map(function (a) {
    return shifts.filter(function (s) { return s.id === a.shiftId; })[0];
  }).filter(function (s) {
    return s && s.id !== shift.id && s.start < shift.end && shift.start < s.end;
  });
  if (conflicts.length) {
    var c = conflicts[0];
    fail_(benevole.nom + ' est déjà sur « ' + c.intitule + ' » (' + c.debut + '-' + c.fin + ').', 'conflict');
  }
}

function assign_(user, req) {
  var shift = requireShift_(user, req.shiftId);
  var benevole = requireBenevole_(req.benevoleId);
  var existing = loadAssignments_().filter(function (a) {
    return a.shiftId === shift.id && a.benevoleId === benevole.id;
  });
  if (existing.length) fail_(benevole.nom + ' est déjà sur ce shift.');
  checkConflict_(shift, benevole, null, req.force);
  sheet_(SHEETS.ASSIGN).appendRow([shift.id, benevole.id]);
  log_(user, 'ajout', benevole.nom + ' sur ' + shift.id + ' (' + shift.intitule + ')');
  return managerDashboard_(user);
}

function unassign_(user, req) {
  var shift = requireShift_(user, req.shiftId);
  var benevole = requireBenevole_(req.benevoleId);
  var rows = loadAssignments_().filter(function (a) {
    return a.shiftId === shift.id && a.benevoleId === benevole.id;
  });
  if (!rows.length) fail_("Ce bénévole n'est plus sur ce shift.", 'stale');
  sheet_(SHEETS.ASSIGN).deleteRow(rows[0]._row);
  log_(user, 'retrait', benevole.nom + ' de ' + shift.id + ' (' + shift.intitule + ')');
  return managerDashboard_(user);
}

function replace_(user, req) {
  var shift = requireShift_(user, req.shiftId);
  var oldB = requireBenevole_(req.oldId);
  var newB = requireBenevole_(req.newId);
  var assignments = loadAssignments_();
  var row = assignments.filter(function (a) {
    return a.shiftId === shift.id && a.benevoleId === oldB.id;
  })[0];
  if (!row) fail_(oldB.nom + " n'est plus sur ce shift.", 'stale');
  var dup = assignments.some(function (a) {
    return a.shiftId === shift.id && a.benevoleId === newB.id;
  });
  if (dup) fail_(newB.nom + ' est déjà sur ce shift.');
  checkConflict_(shift, newB, null, req.force);
  sheet_(SHEETS.ASSIGN).getRange(row._row, 2).setValue(newB.id);
  log_(user, 'remplacement', oldB.nom + ' -> ' + newB.nom + ' sur ' + shift.id + ' (' + shift.intitule + ')');
  return managerDashboard_(user);
}

function addComment_(user, req) {
  var benevole = requireBenevole_(req.benevoleId);
  var texte = str_(req.texte).slice(0, 1000);
  if (!texte) fail_('Le commentaire est vide.');
  var data = managerDashboard_(user);
  var visible = data.benevoles.some(function (b) { return b.id === benevole.id && b.surMesPoles; });
  if (!visible) fail_("Ce bénévole n'est pas sur vos pôles.", 'forbidden');
  sheet_(SHEETS.COMMENTS).appendRow([
    Utilities.getUuid(), benevole.id, user.id, safeCell_(user.nom), new Date().toISOString(), safeCell_(texte)
  ]);
  return managerDashboard_(user);
}

function deleteComment_(user, req) {
  var row = readTable_(SHEETS.COMMENTS).filter(function (c) { return str_(c.id) === str_(req.id); })[0];
  if (!row) fail_('Commentaire introuvable.', 'notfound');
  if (str_(row.manager_id) !== user.id) fail_('Vous ne pouvez supprimer que vos commentaires.', 'forbidden');
  sheet_(SHEETS.COMMENTS).deleteRow(row._row);
  return managerDashboard_(user);
}

/* ---------- Administration depuis le Google Sheet ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Speed')
    .addItem('Initialiser les feuilles', 'initialiser')
    .addItem('Charger des données exemple', 'chargerExemple')
    .addItem('Chiffrer les mots de passe', 'chiffrerMotsDePasse')
    .addToUi();
}

function initialiser() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(HEADERS).forEach(function (name) {
    var s = ss.getSheetByName(name) || ss.insertSheet(name);
    if (s.getLastRow() === 0) {
      s.appendRow(HEADERS[name]);
      s.setFrozenRows(1);
    }
    // Format texte : conserve le 0 des numéros et évite les conversions de dates/heures.
    s.getRange(1, 1, s.getMaxRows(), HEADERS[name].length).setNumberFormat('@');
  });
}

function isoDay_(date, offset) {
  var d = new Date(date.getTime() + offset * 86400000);
  return d.getFullYear() + '-' + pad_(d.getMonth() + 1) + '-' + pad_(d.getDate());
}

function chargerExemple() {
  initialiser();
  if (sheet_(SHEETS.USERS).getLastRow() > 1) {
    fail_('La feuille Utilisateurs contient déjà des données.', 'setup');
  }
  seedExample_(isoDay_(new Date(), 1), isoDay_(new Date(), 2));
}

function seedExample_(j1, j2) {
  function fill(name, rows) {
    var s = sheet_(name);
    rows.forEach(function (r) { s.appendRow(r); });
  }
  fill(SHEETS.USERS, [
    ['M1', 'Camille Martin', '0601020304', 'camille@exemple.fr', 'manager', 'demo', 'Bar, Accueil'],
    ['M2', 'Sacha Petit', '0605060708', 'sacha@exemple.fr', 'manager', 'demo', 'Technique'],
    ['B1', 'Lou Bernard', '0611111111', 'lou@exemple.fr', 'bénévole', 'demo', ''],
    ['B2', 'Noa Durand', '0622222222', 'noa@exemple.fr', 'bénévole', 'demo', ''],
    ['B3', 'Alex Moreau', '0633333333', 'alex@exemple.fr', 'bénévole', 'demo', ''],
    ['B4', 'Charlie Roux', '0644444444', 'charlie@exemple.fr', 'bénévole', 'demo', ''],
    ['B5', 'Maé Fournier', '0655555555', 'mae@exemple.fr', 'bénévole', 'demo', ''],
    ['B6', 'Robin Girard', '0666666666', 'robin@exemple.fr', 'bénévole', 'demo', '']
  ]);
  fill(SHEETS.SHIFTS, [
    ['S1', 'Bar', 'Bar principal', j1, '17:00', '21:00', 'Scène A', 3],
    ['S2', 'Bar', 'Bar principal', j1, '21:00', '01:00', 'Scène A', 3],
    ['S3', 'Accueil', 'Entrée festival', j1, '16:00', '20:00', 'Portail nord', 2],
    ['S4', 'Technique', 'Montage scène', j1, '09:00', '13:00', 'Scène A', 2],
    ['S5', 'Bar', 'Bar camping', j2, '18:00', '22:00', 'Camping', 2],
    ['S6', 'Accueil', 'Entrée festival', j2, '16:00', '20:00', 'Portail nord', 2],
    ['S7', 'Technique', 'Démontage', j2, '23:00', '03:00', 'Scène A', 2]
  ]);
  fill(SHEETS.ASSIGN, [
    ['S1', 'B1'], ['S1', 'B2'], ['S2', 'B3'], ['S3', 'B4'], ['S3', 'B5'],
    ['S4', 'B1'], ['S5', 'B1'], ['S5', 'B6'], ['S6', 'B2'], ['S7', 'B3']
  ]);
  fill(SHEETS.SMS, [
    ['T1', 'Rappel de shift', 'Salut {prenom} ! Rappel : ton shift « {shift} » commence à {heure}. Rendez-vous à {lieu}. À tout de suite !'],
    ['T2', 'Point de rendez-vous', 'Salut {prenom}, changement de point de rendez-vous pour « {shift} » : merci de contacter ton référent.'],
    ['T3', 'Besoin de renfort', 'Salut {prenom}, on a besoin de renfort sur le pôle. Tu es disponible ? Réponds à ce SMS, merci !']
  ]);
}

// Chiffre les mots de passe encore en clair. A relancer si le message le demande.
function chiffrerMotsDePasse() {
  var started = Date.now();
  var col = HEADERS.Utilisateurs.indexOf('mot_de_passe') + 1;
  var s = sheet_(SHEETS.USERS);
  var remaining = 0;
  readTable_(SHEETS.USERS).forEach(function (u) {
    var pwd = str_(u.mot_de_passe);
    if (!pwd || pwd.indexOf('sha256$') === 0) return;
    if (Date.now() - started > 300000) { remaining++; return; }
    s.getRange(u._row, col).setValue(makeHash_(pwd));
  });
  SpreadsheetApp.getUi().alert(remaining ? 'Il en reste ' + remaining + ' : relancez la commande.' : 'Tous les mots de passe sont chiffrés.');
}
