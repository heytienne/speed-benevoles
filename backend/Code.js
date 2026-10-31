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
  LOG: 'Journal',
  ROLES: 'PolesRoles',
  PHOTOS: 'Photos'
};

var HEADERS = {
  Utilisateurs: ['id', 'nom', 'telephone', 'email', 'genre', 'mot_de_passe', 'poles', 'mdp_choisi', 'mdp_temp', 'reset_hash', 'reset_expire', 'souhaits', 'binome', 'age', 'description', 'vitesse_pointe', 'disponibilites'],
  PolesRoles: ['pole', 'role', 'besoin', 'format'],
  Photos: ['user_id', 'photo'],
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
// Adresse fixe de l'appli : un lien de mail ne doit jamais dépendre de ce qu'envoie le client.
var APP_URL = 'https://heytienne.github.io/speed-benevoles/';
var RESET_HOURS = 24;
var MAIL_COOLDOWN_SECONDS = 300;
var MIN_PASSWORD_LENGTH = 8;
// Une cellule de Sheet contient au plus 50 000 caractères : l'appli réduit les photos avant l'envoi.
var MAX_PHOTO_LENGTH = 45000;
var MAX_DESCRIPTION_LENGTH = 500;
var JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

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
  if (req.action === 'login') return withLock_(function () { return login_(req); });
  if (req.action === 'forgot') return withLock_(function () { return forgot_(req); });
  if (req.action === 'resetPassword') return withLock_(function () { return resetPassword_(req); });
  var user = authenticate_(req.token);
  if (req.action === 'setPassword') return withLock_(function () { return setPassword_(user, req); });
  if (!hasChosenPassword_(user)) fail_('Choisissez votre mot de passe.', 'mustChange');
  switch (req.action) {
    case 'dashboard':
      return isManager_(user) ? managerDashboard_(user) : benevoleDashboard_(user);
    case 'getProfile':
      return profile_(user);
    case 'saveProfile':
      return withLock_(function () { return saveProfile_(user, req); });
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

function wishKey_(pole, role) {
  return normName_(pole) + '|' + normName_(role);
}

// Souhaits écrits "Pôle : Rôle", séparés par des virgules.
function parseWishes_(v) {
  return splitPoles_(v).map(function (w) {
    var parts = w.split(':');
    return { label: w, key: parts.length === 2 ? wishKey_(parts[0], parts[1]) : '' };
  });
}

function hasWish_(user, shift) {
  var key = wishKey_(shift.pole, shift.intitule);
  return user.wishes.some(function (w) { return w.key === key; });
}

// Disponibilités écrites "vendredi 18h-22h, samedi" ; un jour seul vaut pour toute la journée.
function parseDisponibilites_(v) {
  var fenetres = [];
  splitPoles_(normName_(v)).forEach(function (texte) {
    var m = texte.match(/^([a-z]+)(?:\s+(\d{1,2})(?:[h:](\d{2})?)?\s*(?:-|a)\s*(\d{1,2})(?:[h:](\d{2})?)?)?$/);
    if (!m || JOURS.indexOf(m[1]) === -1) return;
    var fenetre = { jour: JOURS.indexOf(m[1]), debut: 0, fin: 1440 * 2 };
    if (m[2] !== undefined) {
      fenetre.debut = (+m[2]) * 60 + (+(m[3] || 0));
      fenetre.fin = (+m[4]) * 60 + (+(m[5] || 0));
      if (fenetre.fin <= fenetre.debut) fenetre.fin += 1440;
    }
    fenetres.push(fenetre);
  });
  return fenetres;
}

// Colonne vide : disponible tout le temps. Texte illisible : considéré comme indisponible.
function isAvailable_(user, shift) {
  if (!str_(user.disponibilites)) return true;
  var range = shiftRange_(shift);
  var d = shift.date.split('-');
  var base = Date.UTC(+d[0], +d[1] - 1, +d[2]) / 60000;
  // Avant 6h, le shift appartient à la soirée de la veille, comme dans l'appli.
  if (shift.debut < '06:00') base -= 1440;
  var jour = new Date(base * 60000).getUTCDay();
  return parseDisponibilites_(user.disponibilites).some(function (f) {
    return f.jour === jour && range.start - base >= f.debut && range.end - base <= f.fin;
  });
}

function loadUsers_() {
  return readTable_(SHEETS.USERS).map(function (u) {
    u.id = str_(u.id);
    u.nom = str_(u.nom);
    u.telephone = normPhone_(u.telephone);
    u.email = str_(u.email);
    u.poleList = splitPoles_(u.poles);
    u.wishes = parseWishes_(u.souhaits);
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

function findByIdentifier_(identifiant) {
  var key = normName_(identifiant);
  if (!key) return [];
  return loadUsers_().filter(function (u) {
    return normName_(u.nom) === key || (u.email && normName_(u.email) === key);
  });
}

function hasChosenPassword_(user) {
  return normName_(user.mdp_choisi) === 'oui';
}

// Écrit par nom de colonne et crée celles qui manquent dans un Sheet créé avant leur ajout.
function setUserFields_(user, fields) {
  var s = sheet_(SHEETS.USERS);
  var headers = s.getDataRange().getValues()[0].map(function (h) { return String(h).trim().toLowerCase(); });
  Object.keys(fields).forEach(function (name) {
    var col = headers.indexOf(name) + 1;
    if (!col) {
      headers.push(name);
      col = headers.length;
      s.getRange(1, col).setValue(name);
    }
    s.getRange(user._row, col).setValue(fields[name]);
    user[name] = fields[name];
  });
}

// La signature dépend du mot de passe : en changer ferme les sessions ouvertes ailleurs.
function sessionSignature_(payload, user) {
  return sign_(payload + '|' + str_(user.mot_de_passe));
}

function session_(user) {
  var payload = encodeURIComponent(user.id) + '.' + (Date.now() + TOKEN_DAYS * 86400000);
  return {
    token: payload + '.' + sessionSignature_(payload, user),
    user: publicUser_(user),
    mustChange: !hasChosenPassword_(user)
  };
}

function checkTempPassword_(user, password) {
  return Number(user.reset_expire) > Date.now() && str_(user.mdp_temp) !== '' && checkPassword_(user.mdp_temp, password);
}

function login_(req) {
  var name = normName_(req.nom);
  var password = String(req.password === undefined ? '' : req.password).trim();
  if (!name || !password) fail_('Renseignez votre identifiant et votre mot de passe.');

  var candidates = findByIdentifier_(name);
  var cache = CacheService.getScriptCache();
  // Le compteur suit le compte, pour qu'alterner nom et adresse mail ne donne pas d'essais en plus.
  var failKey = 'fail_' + Utilities.base64EncodeWebSafe(candidates.length ? candidates[0].id : name).slice(0, 200);
  var fails = Number(cache.get(failKey)) || 0;
  if (fails >= MAX_LOGIN_FAILS) fail_('Trop de tentatives. Réessayez dans 15 minutes.', 'locked');

  var user = null;
  var viaTemp = false;
  candidates.forEach(function (u) {
    if (user) return;
    if (checkPassword_(u.mot_de_passe, password)) {
      user = u;
    } else if (checkTempPassword_(u, password)) {
      user = u;
      viaTemp = true;
    }
  });
  if (!user) {
    cache.put(failKey, String(fails + 1), LOCK_SECONDS);
    fail_('Identifiant ou mot de passe incorrect.', 'auth');
  }
  cache.remove(failKey);

  var fields = {};
  // Un mot de passe encore en clair dans le Sheet est chiffré dès la première connexion.
  if (!viaTemp && str_(user.mot_de_passe).indexOf('sha256$') !== 0) fields.mot_de_passe = makeHash_(password);
  if (viaTemp) fields.mdp_choisi = '';
  if (Object.keys(fields).length) setUserFields_(user, fields);
  return session_(user);
}

function authenticate_(token) {
  var parts = str_(token).split('.');
  if (parts.length !== 3) fail_('Session expirée.', 'auth');
  var payload = parts[0] + '.' + parts[1];
  if (Number(parts[1]) < Date.now()) fail_('Session expirée.', 'auth');
  var id = decodeURIComponent(parts[0]);
  var user = loadUsers_().filter(function (u) { return u.id === id; })[0];
  if (!user || sessionSignature_(payload, user) !== parts[2]) fail_('Session expirée.', 'auth');
  return user;
}

function tokenHash_(token) {
  return 'h' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token, Utilities.Charset.UTF_8));
}

// Première connexion et mot de passe oublié. L'ancien mot de passe reste valable tant que le
// nouveau n'est pas choisi, et la réponse est identique que le compte existe ou non.
function forgot_(req) {
  var cache = CacheService.getScriptCache();
  findByIdentifier_(req.identifiant).forEach(function (user) {
    if (!user.email) return;
    var key = 'mail_' + Utilities.base64EncodeWebSafe(user.id);
    if (cache.get(key)) return;
    try {
      var temp = 'speed-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
      var token = Utilities.getUuid() + '-' + Utilities.getUuid();
      setUserFields_(user, {
        mdp_temp: makeHash_(temp),
        reset_hash: tokenHash_(token),
        reset_expire: Date.now() + RESET_HOURS * 3600000
      });
      MailApp.sendEmail({
        to: user.email,
        name: 'Speed Festival',
        subject: 'Speed Festival : ton mot de passe',
        body: 'Salut ' + user.nom.split(' ')[0] + ' !\n\n' +
          'Voici ton mot de passe temporaire pour l\'appli bénévoles : ' + temp + '\n\n' +
          'Pour choisir ton propre mot de passe, ouvre ce lien :\n' + APP_URL + '#reset=' + token + '\n\n' +
          'Le mot de passe temporaire et le lien sont valables ' + RESET_HOURS + ' heures. ' +
          'Si tu n\'as rien demandé, ignore ce message : ton compte ne change pas.\n\nL\'équipe du Speed Festival'
      });
      cache.put(key, '1', MAIL_COOLDOWN_SECONDS);
    } catch (err) {
      console.error(err);
    }
  });
  return { sent: true };
}

function applyPassword_(user, password) {
  var pwd = String(password === undefined ? '' : password).trim();
  if (pwd.length < MIN_PASSWORD_LENGTH) fail_('Choisissez au moins ' + MIN_PASSWORD_LENGTH + ' caractères.');
  setUserFields_(user, { mot_de_passe: makeHash_(pwd), mdp_choisi: 'oui', mdp_temp: '', reset_hash: '', reset_expire: '' });
  return session_(user);
}

function resetPassword_(req) {
  var token = str_(req.resetToken);
  var hash = token ? tokenHash_(token) : '';
  var user = loadUsers_().filter(function (u) {
    return hash && str_(u.reset_hash) === hash && Number(u.reset_expire) > Date.now();
  })[0];
  if (!user) fail_("Ce lien n'est plus valable. Demandez-en un nouveau.", 'badlink');
  return applyPassword_(user, req.password);
}

// Réservé au mot de passe imposé après une connexion avec un mot de passe provisoire.
function setPassword_(user, req) {
  if (hasChosenPassword_(user)) fail_('Votre mot de passe est déjà choisi.', 'forbidden');
  return applyPassword_(user, req.password);
}

function publicUser_(u) {
  return { id: u.id, nom: u.nom, role: isManager_(u) ? 'manager' : 'benevole', poles: u.poleList };
}

function contact_(u) {
  return { id: u.id, nom: u.nom, telephone: u.telephone, email: u.email };
}

/* ---------- Profil ---------- */

// Les photos ont leur propre feuille : Utilisateurs reste lisible et rapide à charger.
function readPhotos_() {
  var photos = {};
  if (!SpreadsheetApp.getActive().getSheetByName(SHEETS.PHOTOS)) return photos;
  readTable_(SHEETS.PHOTOS).forEach(function (p) { photos[str_(p.user_id)] = str_(p.photo); });
  return photos;
}

function savePhoto_(userId, photo) {
  var ss = SpreadsheetApp.getActive();
  var s = ss.getSheetByName(SHEETS.PHOTOS);
  if (!s) {
    s = ss.insertSheet(SHEETS.PHOTOS);
    s.appendRow(HEADERS.Photos);
  }
  var row = readTable_(SHEETS.PHOTOS).filter(function (p) { return str_(p.user_id) === userId; })[0];
  if (!photo) {
    if (row) s.deleteRow(row._row);
  } else if (row) {
    s.getRange(row._row, 2).setValue(photo);
  } else {
    s.appendRow([userId, photo]);
  }
}

function profile_(user) {
  return {
    nom: user.nom,
    email: user.email,
    telephone: user.telephone,
    age: str_(user.age),
    description: str_(user.description),
    vitesse: str_(user.vitesse_pointe),
    photo: readPhotos_()[user.id] || ''
  };
}

function saveProfile_(user, req) {
  var age = str_(req.age);
  if (age && !(/^\d{1,3}$/.test(age) && +age >= 1 && +age <= 120)) fail_("L'âge doit être un nombre entre 1 et 120.");
  var vitesse = str_(req.vitesse).replace(',', '.');
  if (vitesse && !(/^\d+(\.\d+)?$/.test(vitesse) && +vitesse <= 100000)) fail_('La vitesse doit être un nombre positif.');
  var description = str_(req.description);
  if (description.length > MAX_DESCRIPTION_LENGTH) fail_('La description dépasse ' + MAX_DESCRIPTION_LENGTH + ' caractères.');

  // Sans champ photo, la photo actuelle ne change pas ; une valeur vide la supprime.
  if (req.photo !== undefined && req.photo !== null) {
    var photo = String(req.photo);
    if (photo && (photo.length > MAX_PHOTO_LENGTH || !/^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(photo))) {
      fail_('Cette photo ne peut pas être enregistrée. Essayez-en une autre.');
    }
    savePhoto_(user.id, photo);
  }
  setUserFields_(user, { age: age, description: description ? safeCell_(description) : '', vitesse_pointe: vitesse });
  user.description = description;
  return profile_(user);
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
  var equipe = {};
  var nomParId = {};
  benevoles.forEach(function (b) { nomParId[b.id] = b.nom; });
  shifts.forEach(function (s) { shiftById[s.id] = s; });
  assignments.forEach(function (a) {
    var s = shiftById[a.shiftId];
    if (!s) return;
    festivalHours += s.heures;
    if (a.benevoleId === user.id) mine[s.id] = true;
    else if (nomParId[a.benevoleId]) (equipe[s.id] = equipe[s.id] || []).push(nomParId[a.benevoleId]);
  });

  var toutesPhotos = readPhotos_();
  var photos = {};
  var myShifts = shifts.filter(function (s) { return mine[s.id]; }).map(function (s) {
    var copy = JSON.parse(JSON.stringify(s));
    copy.referents = referentsOf(s.pole);
    copy.referents.forEach(function (r) {
      if (toutesPhotos[r.id]) photos[r.id] = toutesPhotos[r.id];
    });
    copy.coequipiers = (equipe[s.id] || []).sort(function (a, b) { return a.localeCompare(b); });
    return copy;
  });

  return {
    user: publicUser_(user),
    shifts: myShifts,
    photos: photos,
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
    copy.candidats = benevoles.filter(function (b) { return hasWish_(b, s) && isAvailable_(b, s); }).map(function (b) { return b.id; });
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
      c.souhaits = b.wishes.map(function (w) { return w.label; });
      var binome = benevoles.filter(function (o) { return o.id !== b.id && normName_(o.nom) === normName_(b.binome); })[0];
      c.binomeId = binome ? binome.id : '';
      c.binomeNom = binome ? binome.nom : str_(b.binome);
      c.disponibilites = str_(b.disponibilites);
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

// Règle stricte, sans confirmation possible : un bénévole ne va que sur un poste qu'il a souhaité.
function requireWish_(shift, benevole) {
  if (!hasWish_(benevole, shift)) {
    fail_(benevole.nom + ' n\'a pas « ' + shift.pole + ' : ' + shift.intitule + ' » dans ses souhaits.', 'wish');
  }
  if (!isAvailable_(benevole, shift)) {
    fail_(benevole.nom + ' n\'est pas disponible sur ce créneau (' + str_(benevole.disponibilites) + ').', 'dispo');
  }
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
  requireWish_(shift, benevole);
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
  requireWish_(shift, newB);
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
    // Numéros 06 39 98 xx xx : réservés par l'ARCEP aux fictions.
    ['M1', 'Camille Martin', '0639980101', 'camille@exemple.fr', 'manager', 'demo', 'Bar, Accueil', 'oui'],
    ['M2', 'Sacha Petit', '0639980102', 'sacha@exemple.fr', 'manager', 'demo', 'Technique', 'oui'],
    ['B1', 'Lou Bernard', '0639980111', 'lou@exemple.fr', 'bénévole', 'demo', '', 'oui'],
    ['B2', 'Noa Durand', '0639980112', 'noa@exemple.fr', 'bénévole', 'demo', '', 'oui'],
    ['B3', 'Alex Moreau', '0639980113', 'alex@exemple.fr', 'bénévole', 'demo', '', 'oui'],
    ['B4', 'Charlie Roux', '0639980114', 'charlie@exemple.fr', 'bénévole', 'demo', '', 'oui'],
    ['B5', 'Maé Fournier', '0639980115', 'mae@exemple.fr', 'bénévole', 'demo', '', 'oui'],
    ['B6', 'Robin Girard', '0639980116', 'robin@exemple.fr', 'bénévole', 'demo', '', 'oui']
  ]);
  loadUsers_().forEach(function (u) {
    if (isManager_(u)) return;
    setUserFields_(u, {
      souhaits: 'Bar : Bar principal, Bar : Bar camping, Accueil : Entrée festival, Technique : Montage scène, Technique : Démontage'
    });
  });
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

// A exécuter une fois depuis l'éditeur : accorde l'autorisation d'envoi et vérifie le quota.
function testerEnvoiMail() {
  var moi = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(moi, 'Speed Festival : test d\'envoi', 'Si tu lis ce message, l\'envoi de mails fonctionne.');
  console.log('Mail envoyé à ' + moi + '. Envois restants aujourd\'hui : ' + MailApp.getRemainingDailyQuota());
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
