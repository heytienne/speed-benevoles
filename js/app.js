/* Speed Bénévoles : interface mobile (bénévoles et managers). */
(function () {
  var cfg = window.SPEED_CONFIG;
  var api = window.SpeedApi;
  var root = document.getElementById('app');
  var SESSION_KEY = 'speed_session';
  var CACHE_KEY = 'speed_cache';

  var state = {
    session: read(SESSION_KEY),
    data: read(CACHE_KEY),
    tab: null,
    stack: [],
    selected: {},
    filterPole: '',
    filterDay: '',
    search: '',
    loading: false,
    busy: false,
    offline: false,
    error: '',
    lastFetch: 0,
    sms: null,
    authView: 'login',
    loginNom: '',
    resetToken: null,
    calScroll: null,
    profile: null,
    profileDraft: null,
    profileBusy: false
  };

  var VITESSE_UNITE = 'km/h';

  var resetLink = location.hash.match(/^#reset=([\w-]+)$/);
  if (resetLink) {
    state.resetToken = resetLink[1];
    // Le lien est à usage unique : il ne doit rester ni dans la barre d'adresse ni dans l'historique.
    history.replaceState(null, '', location.pathname);
  }

  /* ---------- Outils ---------- */

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function write(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* stockage indisponible : l'appli reste utilisable en ligne */ }
  }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nowMinutes() {
    var d = new Date();
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()) / 60000;
  }
  function parseDay(iso) {
    var p = iso.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function dayLabel(iso) {
    return parseDay(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function dayShort(iso) {
    return parseDay(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' });
  }
  // Un shift commençant avant 6h appartient à la soirée de la veille (00h-02h du vendredi soir).
  function festivalDay(s) {
    if (s.debut >= '06:00') return s.date;
    var d = parseDay(s.date);
    d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function time(t) { return t.replace(':', 'h').replace('h00', 'h'); }
  function hours(h) {
    var r = Math.round(h * 10) / 10;
    return String(r).replace('.', ',') + ' h';
  }
  function plural(n, word) { return n + ' ' + word + (n > 1 ? 's' : ''); }
  function firstName(nom) { return String(nom).split(' ')[0]; }
  function unique(list) {
    return list.filter(function (v, i) { return list.indexOf(v) === i; });
  }
  function benevole(id) {
    return state.data.benevoles.filter(function (b) { return b.id === id; })[0];
  }
  function shiftById(id) {
    return state.data.shifts.filter(function (s) { return s.id === id; })[0];
  }
  function selectedIds() { return Object.keys(state.selected); }

  function toast(message) {
    var old = document.querySelector('.toast');
    if (old) old.remove();
    var t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.textContent = message;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  /* ---------- Données ---------- */

  function setData(data) {
    state.data = data;
    state.offline = false;
    state.lastFetch = Date.now();
    write(CACHE_KEY, data);
  }

  function logout() {
    state.session = null;
    state.data = null;
    state.stack = [];
    state.tab = null;
    state.selected = {};
    state.profile = null;
    state.profileDraft = null;
    write(SESSION_KEY, null);
    write(CACHE_KEY, null);
    render();
  }

  function handleError(err) {
    if (err.code === 'auth') {
      logout();
      toast('Session expirée, reconnectez-vous.');
      return;
    }
    if (err.code === 'mustChange') {
      state.session.mustChange = true;
      write(SESSION_KEY, state.session);
      render();
      return;
    }
    if (err.code === 'network') state.offline = true;
    toast(err.message || 'Une erreur est survenue.');
  }

  function refresh(silent) {
    if (!state.session || state.session.mustChange) return Promise.resolve();
    state.loading = true;
    if (!silent) render();
    return api.call('dashboard', null, state.session.token).then(function (data) {
      setData(data);
    }).catch(handleError).then(function () {
      state.loading = false;
      if (state.session) render();
    });
  }

  // Exécute une modification ; le backend renvoie le tableau de bord à jour.
  function mutate(action, payload, onDone) {
    if (state.busy) return;
    state.busy = true;
    api.call(action, payload, state.session.token).then(function (data) {
      setData(data);
      if (onDone) onDone();
    }).catch(function (err) {
      if (err.code === 'conflict' && !payload.force) {
        state.busy = false;
        if (window.confirm(err.message + '\n\nL\'affecter quand même ?')) {
          mutate(action, Object.assign({}, payload, { force: true }), onDone);
        }
        return;
      }
      handleError(err);
      if (err.code === 'stale') return refresh(true);
    }).then(function () {
      state.busy = false;
      if (state.session) render();
    });
  }

  /* ---------- Navigation (le bouton retour du téléphone ferme les écrans) ---------- */

  function push(view) {
    state.stack.push(view);
    history.pushState({ depth: state.stack.length }, '');
    window.scrollTo(0, 0);
    render();
  }
  function replaceTop(view) {
    state.stack[state.stack.length - 1] = view;
    render();
  }
  window.addEventListener('popstate', function () {
    if (state.stack.length) {
      // La sélection survit au retour depuis le SMS ou le choix d'un bénévole, pas à la sortie du shift.
      if (state.stack.pop().type === 'shift') state.selected = {};
      render();
    }
  });

  /* ---------- Morceaux d'interface ---------- */

  function logo(small) {
    if (cfg.LOGO_URL) return '<img class="logo-img" src="' + esc(cfg.LOGO_URL) + '" alt="Speed Festival">';
    return '<span class="logo' + (small ? ' sm' : '') + '" role="img" aria-label="Speed Festival">speed' +
      (small ? '' : '<small>FESTIVAL</small>') + '</span>';
  }

  function topbar() {
    return '<div class="topbar"><span>→ ' + esc(cfg.FESTIVAL_DATES) + '</span><span class="stars" aria-hidden="true">★★★</span>' +
      '<span class="place">' + esc(cfg.FESTIVAL_LIEU) + '</span></div>';
  }

  function shell(content, options) {
    options = options || {};
    var u = state.session.user;
    var left = options.back
      ? '<button class="icon-btn" data-act="back" aria-label="Retour">←</button>'
      : logo(true);
    return '<div class="frame"><div class="frame-in">' + topbar() +
      '<header class="header">' + left +
      '<div class="who"><b>' + esc(u.nom) + '</b>' + (u.role === 'manager' ? 'Manager · ' + esc(u.poles.join(', ')) : 'Bénévole') + '</div>' +
      '<button class="icon-btn" data-act="refresh" aria-label="Actualiser">↻</button>' +
      (options.back ? '' : '<button class="icon-btn" data-act="logout" aria-label="Se déconnecter">⏻</button>') +
      '</header>' +
      (state.offline ? '<div class="banner">Hors connexion : dernières données enregistrées.</div>' : '') +
      (api.isDemo ? '<div class="banner">MODE DÉMO : données fictives</div>' : '') +
      (options.nav || '') +
      '<main class="main' + (options.back ? ' narrow' : '') + (options.nav ? '' : ' no-nav') + '">' + content + '</main></div></div>' + (options.after || '');
  }

  function nav(items) {
    return '<nav class="nav" aria-label="Navigation">' + items.map(function (it) {
      return '<button data-act="tab" data-tab="' + it[0] + '"' + (state.tab === it[0] ? ' aria-current="page"' : '') + '>' + it[1] + '</button>';
    }).join('') + '</nav>';
  }

  function ticket(s, opts) {
    var now = nowMinutes();
    var status = s.end <= now ? 'past' : s.start <= now ? 'now' : '';
    var tag = opts.act ? 'button' : 'div';
    var attrs = opts.act ? ' data-act="' + opts.act + '" data-id="' + esc(s.id) + '"' : '';
    return '<' + tag + ' class="ticket ' + (status === 'past' ? 'past' : '') + '"' + attrs + '>' +
      '<div class="ticket-body"><div class="hex"><span>' + esc(time(s.debut)) + '<small>→ ' + esc(time(s.fin)) + '</small></span></div>' +
      '<div class="ticket-text"><div class="ticket-title">' + esc(s.intitule) + '</div>' +
      '<div class="ticket-meta">' + (status === 'now' ? '<span class="pill now">En cours</span> ' : '') + (opts.extra || '') + '</div></div></div>' +
      '<div class="ticket-strip"><span>→ ' + esc(s.pole.toUpperCase()) + '</span><span>' + esc((s.lieu || '').toUpperCase()) + '</span></div>' +
      '</' + tag + '>';
  }

  function groupByDay(shifts, draw) {
    var html = '';
    unique(shifts.map(festivalDay)).forEach(function (d) {
      html += '<h2 class="day-title">' + esc(dayLabel(d)) + '</h2><div class="card-grid">';
      shifts.filter(function (s) { return festivalDay(s) === d; }).forEach(function (s) { html += draw(s); });
      html += '</div>';
    });
    return html;
  }

  function skeleton() {
    return '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  }

  function contactButtons(c) {
    var out = '';
    if (c.telephone) {
      out += '<a class="btn small" href="tel:' + esc(c.telephone) + '">Appeler</a>' +
        '<a class="btn small ghost" href="sms:' + esc(c.telephone) + '">SMS</a>';
    }
    if (c.email) out += '<a class="btn small ghost" href="mailto:' + esc(c.email) + '">Mail</a>';
    return out;
  }

  /* ---------- Connexion ---------- */

  function authFrame(content) {
    root.innerHTML = '<div class="frame"><div class="frame-in">' + topbar() +
      '<div class="hero">' + logo(false) + '</div><div class="login">' + content + '</div></div></div>';
  }

  function renderForgot() {
    if (state.authView === 'sent') {
      authFrame('<h1 class="poster-title">Regardez vos mails</h1>' +
        '<p>Si ce compte existe, un mail vient de partir avec un mot de passe temporaire et un lien pour choisir le vôtre. Pensez à vérifier les spams.</p>' +
        '<p class="hint">Rien après quelques minutes ? Votre adresse n\'est peut-être pas renseignée : contactez votre référent de pôle.</p>' +
        '<button class="btn block" data-act="showLogin">Retour à la connexion</button>');
      return;
    }
    authFrame('<form id="forgot-form"><h1 class="poster-title">Première connexion ou mot de passe oublié</h1>' +
      (state.error ? '<div class="error" role="alert">' + esc(state.error) + '</div>' : '') +
      '<label class="field"><span>Nom ou adresse mail</span><input type="text" name="identifiant" autocomplete="username" autocapitalize="none" required value="' + esc(state.loginNom) + '"></label>' +
      '<button class="btn block" type="submit"' + (state.busy ? ' disabled' : '') + '>' + (state.busy ? 'Envoi…' : 'Recevoir le mail') + '</button>' +
      '<p><button type="button" class="text-btn" data-act="showLogin">Retour à la connexion</button></p></form>');
  }

  function renderChoosePassword() {
    document.body.dataset.role = 'login';
    authFrame('<form id="password-form"><h1 class="poster-title">Choisissez votre mot de passe</h1>' +
      '<p class="hint">Au moins 8 caractères. C\'est lui qui servira pour vos prochaines connexions.</p>' +
      (state.error ? '<div class="error" role="alert">' + esc(state.error) + '</div>' : '') +
      '<label class="field"><span>Nouveau mot de passe</span><input type="password" name="password" autocomplete="new-password" minlength="8" required></label>' +
      '<label class="field"><span>Confirmation</span><input type="password" name="confirm" autocomplete="new-password" minlength="8" required></label>' +
      '<button class="btn block" type="submit"' + (state.busy ? ' disabled' : '') + '>' + (state.busy ? 'Enregistrement…' : 'Enregistrer') + '</button>' +
      '<p><button type="button" class="text-btn" data-act="cancelPassword">Annuler</button></p></form>');
  }

  function doForgot(identifiant) {
    state.busy = true;
    state.error = '';
    state.loginNom = identifiant;
    renderForgot();
    api.call('forgot', { identifiant: identifiant }).then(function () {
      state.authView = 'sent';
    }).catch(function (err) {
      state.error = err.message;
    }).then(function () {
      state.busy = false;
      renderForgot();
    });
  }

  function doChoosePassword(form) {
    if (form.password.value !== form.confirm.value) {
      state.error = 'Les deux mots de passe sont différents.';
      renderChoosePassword();
      return;
    }
    state.busy = true;
    state.error = '';
    var password = form.password.value;
    renderChoosePassword();
    var call = state.resetToken
      ? api.call('resetPassword', { resetToken: state.resetToken, password: password })
      : api.call('setPassword', { password: password }, state.session.token);
    call.then(function (res) {
      state.busy = false;
      state.resetToken = null;
      state.data = null;
      state.session = res;
      write(CACHE_KEY, null);
      write(SESSION_KEY, res);
      return refresh();
    }).catch(function (err) {
      state.busy = false;
      if (err.code === 'badlink') {
        state.resetToken = null;
        state.authView = 'forgot';
        state.error = err.message;
        render();
        return;
      }
      if (err.code === 'auth') {
        logout();
        toast(err.message);
        return;
      }
      state.error = err.message;
      renderChoosePassword();
    });
  }

  function renderLogin() {
    document.body.dataset.role = 'login';
    if (state.authView !== 'login') {
      renderForgot();
      return;
    }
    var demo = api.isDemo
      ? '<div class="demo-box"><p><b>Mode démo.</b> Mot de passe : <b>demo</b></p><div class="demo-actions">' +
        '<button type="button" class="btn small ghost" data-act="demoLogin" data-nom="Lou Bernard">Bénévole</button>' +
        '<button type="button" class="btn small ghost" data-act="demoLogin" data-nom="Camille Martin">Manager</button>' +
        '<button type="button" class="btn small ghost" data-act="demoReset">Réinitialiser</button></div></div>'
      : '';
    root.innerHTML = '<div class="frame"><div class="frame-in">' + topbar() +
      '<div class="hero">' + logo(false) + '</div>' +
      '<form class="login" id="login-form"><h1 class="poster-title">Espace bénévoles</h1>' +
      (state.error ? '<div class="error" role="alert">' + esc(state.error) + '</div>' : '') +
      '<label class="field"><span>Nom ou adresse mail</span><input type="text" name="nom" autocomplete="username" autocapitalize="none" required value="' + esc(state.loginNom) + '"></label>' +
      '<label class="field"><span>Mot de passe</span><input type="password" name="password" autocomplete="current-password" required></label>' +
      '<button class="btn block" type="submit"' + (state.busy ? ' disabled' : '') + '>' + (state.busy ? 'Connexion…' : 'Se connecter') + '</button>' +
      '<p><button type="button" class="text-btn" data-act="showForgot">Première connexion ou mot de passe oublié ?</button></p>' + demo + '</form></div></div>';
  }

  function doLogin(nom, password) {
    state.busy = true;
    state.error = '';
    state.loginNom = nom;
    renderLogin();
    api.call('login', { nom: nom, password: password }).then(function (res) {
      state.session = res;
      write(SESSION_KEY, res);
      state.busy = false;
      if (res.mustChange) {
        render();
        return null;
      }
      return refresh();
    }).catch(function (err) {
      state.busy = false;
      state.error = err.message;
      renderLogin();
    });
  }

  /* ---------- Bénévole ---------- */

  function renderBenevole() {
    if (!state.tab) state.tab = 'planning';
    var top = state.stack[state.stack.length - 1];
    if (top && state.data) {
      root.innerHTML = shell(myShiftDetail(top), { back: true });
      return;
    }
    var content = state.tab === 'profil' ? profilePage()
      : !state.data ? skeleton()
      : state.tab === 'planning' ? benevolePlanning()
      : state.tab === 'contacts' ? benevoleContacts()
      : benevoleStats();
    root.innerHTML = shell(content, { nav: nav([['planning', 'Planning'], ['contacts', 'Référents'], ['stats', 'Stats'], ['profil', 'Profil']]) });
  }

  function validPhoto(photo) {
    return /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo || '') ? photo : '';
  }

  function avatar(nom, photo, large) {
    var cls = 'avatar' + (large ? ' large' : '');
    if (validPhoto(photo)) return '<img class="' + cls + '" src="' + esc(photo) + '" alt="Photo de ' + esc(nom) + '">';
    var initiales = String(nom).split(' ').map(function (m) { return m.charAt(0); }).join('').slice(0, 2).toUpperCase();
    return '<span class="' + cls + ' empty" aria-hidden="true">' + esc(initiales) + '</span>';
  }

  function referentCard(r) {
    var photos = state.data.photos || {};
    return '<div class="person">' + avatar(r.nom, photos[r.id]) +
      '<div class="grow"><div class="name">' + esc(r.nom) + '</div>' +
      '<div class="sub">' + esc(r.telephone) + (r.telephone && r.email ? ' · ' : '') + esc(r.email) + '</div>' +
      (r.telephone || r.email
        ? '<div class="contact-actions">' + contactButtons(r) + '</div>'
        : '<p class="hint">Coordonnées pas encore renseignées.</p>') +
      '</div></div>';
  }

  function myShiftDetail(view) {
    var s = state.data.shifts.filter(function (x) { return x.id === view.id; })[0];
    if (!s) return '<div class="empty"><b>Créneau introuvable</b>Votre planning a peut-être changé.</div>';
    var equipe = s.coequipiers || [];
    return ticket(s, { extra: esc(dayShort(festivalDay(s))) + ' · ' + esc(hours(s.heures)) }) +
      '<section class="card"><h3>Avec vous sur ce créneau</h3>' + (equipe.length
        ? '<ul class="team">' + equipe.map(function (nom) { return '<li>' + esc(nom) + '</li>'; }).join('') + '</ul>'
        : '<p class="hint">Personne d\'autre pour le moment.</p>') + '</section>' +
      '<section class="card"><h3>' + (s.referents.length > 1 ? 'Vos référents' : 'Votre référent') + '</h3>' + (s.referents.length
        ? s.referents.map(referentCard).join('')
        : '<p class="hint">Aucun référent renseigné pour ce pôle.</p>') + '</section>';
  }

  /* ---------- Profil ---------- */

  function loadProfile() {
    api.call('getProfile', null, state.session.token).then(function (profile) {
      state.profile = profile;
      if (state.session && state.tab === 'profil') render();
    }).catch(handleError);
  }

  // Le brouillon survit aux réaffichages, par exemple au retour de l'appareil photo.
  function draft() {
    if (!state.profileDraft) {
      var p = state.profile;
      state.profileDraft = { age: p.age, description: p.description, vitesse: p.vitesse, photo: undefined };
    }
    return state.profileDraft;
  }

  function currentPhoto() {
    var d = draft();
    return d.photo !== undefined ? d.photo : state.profile.photo;
  }

  function photoBlock() {
    var photo = currentPhoto();
    return avatar(state.profile.nom, photo, true) +
      '<div class="contact-actions"><label class="btn small ghost">' + (photo ? 'Changer la photo' : 'Ajouter une photo') +
      '<input type="file" id="profile-photo" accept="image/*" class="visually-hidden"></label>' +
      (photo ? '<button type="button" class="btn small ghost" data-act="removePhoto">Retirer</button>' : '') + '</div>';
  }

  function profilePage() {
    if (!state.profile) return skeleton();
    var d = draft();
    return '<h1 class="section-title">Mon profil</h1><form id="profile-form" class="profile">' +
      '<div class="profile-photo" id="photo-block">' + photoBlock() + '</div>' +
      '<p class="profile-name"><b>' + esc(state.profile.nom) + '</b><br><span class="sub">' + esc(state.profile.email) + '</span></p>' +
      '<label class="field"><span>Âge</span><input type="text" inputmode="numeric" id="profile-age" maxlength="3" value="' + esc(d.age) + '"></label>' +
      '<label class="field"><span>Vitesse de pointe (' + VITESSE_UNITE + ')</span><input type="text" inputmode="decimal" id="profile-vitesse" maxlength="10" value="' + esc(d.vitesse) + '"></label>' +
      '<label class="field"><span>Description</span><textarea id="profile-description" maxlength="500">' + esc(d.description) + '</textarea></label>' +
      '<button class="btn block" type="submit"' + (state.profileBusy ? ' disabled' : '') + '>' + (state.profileBusy ? 'Enregistrement…' : 'Enregistrer') + '</button></form>';
  }

  // Recadre au carré et réduit la photo pour qu'elle tienne dans une cellule du Sheet.
  function resizePhoto(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var SIZE = 160;
        var side = Math.min(img.naturalWidth, img.naturalHeight);
        var canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, SIZE, SIZE);
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('image'));
      };
      img.src = url;
    });
  }

  function saveProfile() {
    if (state.profileBusy) return;
    var d = draft();
    state.profileBusy = true;
    render();
    var payload = { age: d.age, description: d.description, vitesse: d.vitesse };
    if (d.photo !== undefined) payload.photo = d.photo;
    api.call('saveProfile', payload, state.session.token).then(function (profile) {
      state.profile = profile;
      state.profileDraft = null;
      toast('Profil enregistré.');
    }).catch(handleError).then(function () {
      state.profileBusy = false;
      if (state.session) render();
    });
  }

  function benevolePlanning() {
    var shifts = state.data.shifts;
    if (!shifts.length) {
      return '<div class="empty"><b>Pas encore de shift</b>Votre planning apparaîtra ici dès qu\'il sera prêt.</div>';
    }
    var now = nowMinutes();
    var next = shifts.filter(function (s) { return s.end > now; })[0];
    var html = '<h1 class="section-title">Mon planning</h1>';
    if (!next) html += '<p class="hint">Tous vos shifts sont terminés. Merci !</p>';
    return html + groupByDay(shifts, function (s) {
      var extra = esc(hours(s.heures));
      if (next && s.id === next.id && s.start > now) extra = '<span class="pill">Prochain</span> ' + extra;
      return ticket(s, { extra: extra, act: 'openMyShift' });
    });
  }

  function benevoleContacts() {
    var poles = unique(state.data.shifts.map(function (s) { return s.pole; }));
    if (!poles.length) return '<div class="empty"><b>Aucun référent</b>Vos référents apparaîtront avec vos shifts.</div>';
    return '<h1 class="section-title">Mes référents</h1><div class="card-grid">' + poles.map(function (pole) {
      var shift = state.data.shifts.filter(function (s) { return s.pole === pole; })[0];
      var refs = shift.referents.length
        ? shift.referents.map(referentCard).join('')
        : '<p class="hint">Aucun référent renseigné pour ce pôle.</p>';
      return '<section class="card"><h3>Pôle ' + esc(pole) + '</h3>' + refs + '</section>';
    }).join('') + '</div>';
  }

  function bars(rows, format) {
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat(0.01));
    return rows.map(function (r) {
      return '<div class="bar-row"><div class="bar-head"><span>' + esc(r.label) + '</span><span>' + esc(format(r.value)) + '</span></div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + (r.value / max * 100) + '%"></div></div></div>';
    }).join('');
  }

  function sumBy(shifts, keyOf, label) {
    return unique(shifts.map(keyOf)).map(function (k) {
      return {
        label: label ? label(k) : k,
        value: shifts.filter(function (s) { return keyOf(s) === k; }).reduce(function (t, s) { return t + s.heures; }, 0)
      };
    });
  }

  function benevoleStats() {
    var shifts = state.data.shifts;
    if (!shifts.length) return '<div class="empty"><b>Pas encore de stats</b>Elles arriveront avec vos premiers shifts.</div>';
    var now = nowMinutes();
    var total = shifts.reduce(function (t, s) { return t + s.heures; }, 0);
    var done = shifts.filter(function (s) { return s.end <= now; }).reduce(function (t, s) { return t + s.heures; }, 0);
    var fest = state.data.festival;
    var share = fest.heures ? Math.round(total / fest.heures * 100) : 0;
    return '<h1 class="section-title">Mes stats</h1><div class="tiles">' +
      '<div class="tile hot"><div class="num">' + esc(hours(total)) + '</div><div class="lab">de bénévolat sur le festival</div></div>' +
      '<div class="tile"><div class="num">' + shifts.length + '</div><div class="lab">' + (shifts.length > 1 ? 'shifts' : 'shift') + '</div></div>' +
      '<div class="tile"><div class="num">' + esc(hours(done)) + '</div><div class="lab">déjà effectuées</div></div></div>' +
      '<div class="card-grid"><section class="card"><h3>Heures par jour</h3>' + bars(sumBy(shifts, festivalDay, dayLabel), hours) + '</section>' +
      '<section class="card"><h3>Heures par pôle</h3>' + bars(sumBy(shifts, function (s) { return s.pole; }), hours) + '</section>' +
      '<section class="card"><h3>Toute l\'équipe</h3><div class="tiles" style="margin:8px 0 0">' +
      '<div class="tile"><div class="num">' + fest.benevoles + '</div><div class="lab">bénévoles</div></div>' +
      '<div class="tile"><div class="num">' + esc(hours(fest.heures)) + '</div><div class="lab">au total</div></div></div>' +
      '<p class="hint">Vous assurez ' + share + ' % des heures prévues. Merci !</p></section></div>';
  }

  /* ---------- Manager ---------- */

  function visibleShifts() {
    return state.data.shifts.filter(function (s) {
      return (!state.filterPole || s.pole.toLowerCase() === state.filterPole.toLowerCase()) && (!state.filterDay || festivalDay(s) === state.filterDay);
    });
  }

  function staffingPill(s) {
    var n = s.benevoleIds.length;
    if (!s.nbRequis) return '<span class="pill">' + plural(n, 'bénévole') + '</span>';
    var missing = s.nbRequis - n;
    return '<span class="pill' + (missing > 0 ? ' warn' : '') + '">' + n + '/' + s.nbRequis + (missing > 0 ? ' · manque ' + missing : ' · complet') + '</span>';
  }

  function managerFilters() {
    var d = state.data;
    var html = '';
    ensureDay();
    if (d.poles.length > 1) {
      html += '<div class="chips" aria-label="Filtrer par pôle"><button class="chip" data-act="filterPole" data-v="" aria-pressed="' + !state.filterPole + '">Tous</button>' +
        d.poles.map(function (p) {
          return '<button class="chip" data-act="filterPole" data-v="' + esc(p) + '" aria-pressed="' + (state.filterPole === p) + '">' + esc(p) + '</button>';
        }).join('') + '</div>';
    }
    var days = unique(d.shifts.map(festivalDay));
    if (days.length > 1) {
      html += '<div class="chips" aria-label="Choisir le jour">' +
        days.map(function (x) {
          return '<button class="chip" data-act="filterDay" data-v="' + esc(x) + '" aria-pressed="' + (state.filterDay === x) + '">' + esc(dayShort(x)) + '</button>';
        }).join('') + '</div>';
    }
    return html;
  }

  // Le calendrier montre un jour à la fois : aujourd'hui pendant le festival, sinon le premier jour.
  function ensureDay() {
    var days = unique(state.data.shifts.map(festivalDay));
    if (days.indexOf(state.filterDay) !== -1) return;
    var d = new Date();
    var today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    state.filterDay = days.indexOf(today) !== -1 ? today : days[0] || '';
  }

  function calendarBlock(s, lane, rowOf, now) {
    var missing = s.nbRequis ? s.nbRequis - s.benevoleIds.length : 0;
    var names = s.benevoleIds.map(function (id) {
      var b = benevole(id);
      return b ? firstName(b.nom) : '';
    }).filter(String);
    var count = s.nbRequis ? s.benevoleIds.length + '/' + s.nbRequis : String(s.benevoleIds.length);
    return '<button class="cal-block' + (missing > 0 ? ' short' : '') + (s.end <= now ? ' past' : '') + '" data-act="openShift" data-id="' + esc(s.id) + '"' +
      ' style="grid-column:' + lane + ';grid-row:' + rowOf(s.start) + ' / ' + rowOf(s.end) + '"' +
      ' aria-label="' + esc(s.pole + ', ' + s.intitule + ', ' + time(s.debut) + ' à ' + time(s.fin) + ', ' + count + (missing > 0 ? ', manque ' + missing : ', complet')) + '">' +
      '<b>' + esc(count) + (missing > 0 ? ' · manque ' + missing : '') + '</b>' +
      '<span>' + esc(names.join(', ')) + '</span></button>';
  }

  function calendar(shifts) {
    var SLOT = 30;
    var min = Math.min.apply(null, shifts.map(function (s) { return s.start; }));
    var max = Math.max.apply(null, shifts.map(function (s) { return s.end; }));
    min -= min % 60;
    function rowOf(minutes) { return Math.round((minutes - min) / SLOT) + 2; }

    // Une colonne par rôle, avec une colonne de plus si deux shifts du même rôle se chevauchent.
    var columns = [];
    var poleOrder = unique(shifts.map(function (s) { return s.pole; }));
    var placed = [];
    poleOrder.forEach(function (pole) {
      unique(shifts.filter(function (s) { return s.pole === pole; }).map(function (s) { return s.intitule; })).forEach(function (role) {
        var lanes = [];
        shifts.filter(function (s) { return s.pole === pole && s.intitule === role; }).forEach(function (s) {
          var i = 0;
          while (lanes[i] !== undefined && lanes[i] > s.start) i++;
          lanes[i] = s.end;
          if (!columns.some(function (c) { return c.pole === pole && c.role === role && c.lane === i; })) {
            columns.push({ pole: pole, role: role, lane: i });
          }
          placed.push({ shift: s, pole: pole, role: role, lane: i });
        });
      });
    });
    function columnIndex(p) {
      for (var i = 0; i < columns.length; i++) {
        if (columns[i].pole === p.pole && columns[i].role === p.role && columns[i].lane === p.lane) return i + 2;
      }
      return 2;
    }

    var html = '<div class="cal-corner"></div>' + columns.map(function (c, i) {
      return '<div class="cal-head" style="grid-column:' + (i + 2) + '"><small>' + esc(c.pole) + '</small>' + esc(c.role) + '</div>';
    }).join('');
    for (var t = min; t < max; t += 60) {
      var h = Math.floor(t / 60) % 24;
      html += '<div class="cal-hour" style="grid-row:' + rowOf(t) + ' / ' + rowOf(t + 60) + '">' + h + 'h</div>';
      html += '<div class="cal-line" style="grid-column:2 / ' + (columns.length + 2) + ';grid-row:' + rowOf(t) + ' / ' + rowOf(t + 60) + '"></div>';
    }
    var now = nowMinutes();
    html += placed.map(function (p) { return calendarBlock(p.shift, columnIndex(p), rowOf, now); }).join('');
    return '<div class="cal" id="calendar"><div class="cal-grid" style="grid-template-columns:42px repeat(' + columns.length + ',minmax(96px,1fr));grid-template-rows:auto repeat(' + Math.round((max - min) / SLOT) + ',24px)">' + html + '</div></div>' +
      '<p class="hint">Touchez un créneau pour voir et modifier les bénévoles.</p>';
  }

  function managerShifts() {
    var filters = managerFilters();
    var shifts = visibleShifts();
    return '<h1 class="section-title">Shifts du pôle</h1>' + filters + (shifts.length
      ? calendar(shifts)
      : '<div class="empty"><b>Aucun shift</b>Rien de prévu avec ces filtres.</div>');
  }

  function commentCount(id) {
    return state.data.comments.filter(function (c) { return c.benevoleId === id; }).length;
  }

  function benevoleRow(b, options) {
    var checked = state.selected[b.id] ? ' checked' : '';
    var n = commentCount(b.id);
    return '<div class="row"><input type="checkbox" data-act="toggle" data-id="' + esc(b.id) + '" aria-label="Sélectionner ' + esc(b.nom) + '"' + checked + '>' +
      '<div class="grow"><button class="link-btn" data-act="openBenevole" data-id="' + esc(b.id) + '"><div class="name">' + esc(b.nom) + '</div>' +
      '<div class="sub">' + esc(b.telephone) + (n ? ' · ' + plural(n, 'commentaire') : '') + '</div>' +
      (options && options.note ? '<div class="sub">' + options.note + '</div>' : '') + '</button></div>' +
      (options && options.actions ? '<div class="row-actions">' + options.actions + '</div>' : '') + '</div>';
  }

  function managerBenevoles() {
    var list = state.data.benevoles.filter(function (b) { return b.surMesPoles; });
    if (!list.length) return '<h1 class="section-title">Mes bénévoles</h1><div class="empty"><b>Personne pour l\'instant</b>Aucun bénévole affecté à vos pôles.</div>';
    var all = list.every(function (b) { return state.selected[b.id]; });
    return '<h1 class="section-title">Mes bénévoles</h1>' +
      '<button class="btn small ghost" data-act="selectAll" data-ids="' + esc(list.map(function (b) { return b.id; }).join(',')) + '">' + (all ? 'Tout désélectionner' : 'Tout sélectionner') + '</button>' +
      '<div class="row-list">' + list.map(function (b) { return benevoleRow(b); }).join('') + '</div>';
  }

  function selectBar(noNav) {
    var n = selectedIds().length;
    if (!n) return '';
    return '<div class="select-bar' + (noNav ? ' no-nav' : '') + '"><button class="btn dark" data-act="openSms">Envoyer un SMS (' + n + ')</button></div>';
  }

  function shiftDetail(view) {
    var s = shiftById(view.id);
    if (!s) return '<div class="empty"><b>Shift introuvable</b></div>';
    var rows = s.benevoleIds.map(function (id) {
      var b = benevole(id);
      if (!b) return '';
      var note = '';
      if (b.binomeId) {
        note = s.benevoleIds.indexOf(b.binomeId) !== -1
          ? 'Avec son binôme ' + esc(firstName(b.binomeNom))
          : '<span class="pill warn">Binôme ' + esc(firstName(b.binomeNom)) + ' pas sur ce shift</span>';
      }
      return benevoleRow(b, {
        note: note,
        actions: '<button class="btn small ghost" data-act="pickReplace" data-id="' + esc(id) + '">Changer</button>' +
          '<button class="btn small ghost" data-act="remove" data-id="' + esc(id) + '" aria-label="Retirer ' + esc(b.nom) + ' de ce créneau">Retirer</button>'
      });
    }).join('');
    return ticket(s, { extra: dayShort(festivalDay(s)) + ' ' + staffingPill(s) }) +
      '<section class="card"><h3>Bénévoles prévus</h3>' +
      (rows || '<p class="hint">Personne sur ce shift pour le moment.</p>') +
      '<div class="contact-actions"><button class="btn small" data-act="pickAdd">+ Ajouter</button>' +
      (s.benevoleIds.length ? '<button class="btn small ghost" data-act="selectAll" data-ids="' + esc(s.benevoleIds.join(',')) + '">Tout sélectionner</button>' : '') +
      '</div></section>';
  }

  function isFree(b, shift) {
    return b.busy.filter(function (x) {
      return x.shiftId !== shift.id && x.start < shift.end && shift.start < x.end;
    })[0];
  }

  function pickerList(view) {
    var s = shiftById(view.shiftId);
    var q = state.search.trim().toLowerCase();
    // Seuls les bénévoles ayant ce poste dans leurs souhaits sont proposés, binômes présents en tête.
    var list = state.data.benevoles.filter(function (b) {
      return s.candidats.indexOf(b.id) !== -1 && s.benevoleIds.indexOf(b.id) === -1 && (!q || b.nom.toLowerCase().indexOf(q) !== -1);
    }).map(function (b) {
      return { b: b, conflict: isFree(b, s), duo: b.binomeId && s.benevoleIds.indexOf(b.binomeId) !== -1 && b.binomeId !== view.oldId };
    }).sort(function (a, b) {
      return (a.conflict ? 2 : 0) - (b.conflict ? 2 : 0) + (a.duo ? 0 : 1) - (b.duo ? 0 : 1);
    });
    if (!list.length) return '<div class="empty">Aucun bénévole disponible à cette heure n\'a ce poste dans ses souhaits.</div>';
    return list.map(function (it) {
      var label = it.conflict
        ? '<span class="pill warn">Déjà sur ' + esc(it.conflict.intitule) + ' ' + esc(time(it.conflict.debut)) + '-' + esc(time(it.conflict.fin)) + '</span>'
        : '<span class="pill">Libre</span>';
      if (it.duo) label += ' <span class="pill now">Binôme ' + esc(firstName(it.b.binomeNom)) + ' sur ce shift</span>';
      return '<div class="row"><button class="link-btn" data-act="pick" data-id="' + esc(it.b.id) + '"><div class="name">' + esc(it.b.nom) + '</div>' + label + '</button></div>';
    }).join('');
  }

  function picker(view) {
    var s = shiftById(view.shiftId);
    if (!s) return '<div class="empty"><b>Shift introuvable</b></div>';
    var title = view.oldId ? 'Remplacer ' + firstName(benevole(view.oldId).nom) : 'Ajouter un bénévole';
    return '<h1 class="section-title">' + esc(title) + '</h1><p class="hint">' + esc(s.intitule) + ' · ' + esc(dayShort(festivalDay(s))) + ' · ' + esc(time(s.debut)) + ' → ' + esc(time(s.fin)) + '</p>' +
      '<p class="hint">Seuls les bénévoles ayant ce poste en souhait et disponibles sur ce créneau sont proposés.</p>' +
      '<input type="search" id="picker-search" placeholder="Rechercher un nom" aria-label="Rechercher un bénévole" value="' + esc(state.search) + '">' +
      '<div id="picker-list" style="margin-top:6px">' + pickerList(view) + '</div>';
  }

  function benevoleDetail(view) {
    var b = benevole(view.id);
    if (!b) return '<div class="empty"><b>Bénévole introuvable</b></div>';
    var comments = state.data.comments.filter(function (c) { return c.benevoleId === b.id; }).sort(function (x, y) {
      return x.date < y.date ? 1 : -1;
    });
    var me = state.session.user.id;
    return '<section class="card"><h3>' + esc(b.nom) + '</h3><div class="sub">' + esc(b.telephone) + (b.email ? ' · ' + esc(b.email) : '') + '</div>' +
      '<div class="contact-actions">' + contactButtons(b) + '</div></section>' +
      '<section class="card"><h3>Souhaits</h3>' + (b.souhaits.length
        ? '<p class="hint">Affectation possible uniquement sur ces postes.</p><div class="contact-actions">' + b.souhaits.map(function (w) { return '<span class="pill">' + esc(w) + '</span>'; }).join(' ') + '</div>'
        : '<p class="hint">Aucun souhait renseigné : affectation impossible.</p>') +
      '<p><b>Binôme souhaité :</b> ' + (b.binomeNom ? esc(b.binomeNom) : 'aucun') + '</p>' +
      '<p><b>Disponibilités :</b> ' + (b.disponibilites ? esc(b.disponibilites) : 'tout le festival') + '</p></section>' +
      '<section class="card"><h3>Ses shifts</h3>' + (b.busy.length ? b.busy.map(function (x) {
        return '<div class="row" style="min-height:0"><div class="grow"><div class="name">' + esc(x.intitule) + '</div><div class="sub">' +
          esc(x.pole) + ' · ' + esc(dayShort(festivalDay(x))) + ' · ' + esc(time(x.debut)) + ' → ' + esc(time(x.fin)) + '</div></div></div>';
      }).join('') : '<p class="hint">Aucun shift.</p>') + '</section>' +
      '<section class="card"><h3>Commentaires</h3><p class="hint">Visibles uniquement par les managers.</p>' +
      comments.map(function (c) {
        var when = c.date ? new Date(c.date).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
        return '<div class="comment"><div class="sub"><span>' + esc(c.managerNom) + ' · ' + esc(when) + '</span>' +
          (c.managerId === me ? '<button class="text-btn" data-act="delComment" data-id="' + esc(c.id) + '">Supprimer</button>' : '') + '</div><p>' + esc(c.texte) + '</p></div>';
      }).join('') +
      (b.surMesPoles
        ? '<label class="field"><span>Nouveau commentaire</span><textarea id="comment-text" maxlength="1000"></textarea></label>' +
          '<button class="btn small" data-act="addComment" data-id="' + esc(b.id) + '">Ajouter</button>'
        : '') + '</section>';
  }

  /* ---------- SMS ---------- */

  // {shift}, {heure} et {lieu} viennent du shift ouvert, sinon du prochain shift du bénévole sur mes pôles.
  function shiftForSms(b) {
    if (state.sms.shiftId) return shiftById(state.sms.shiftId);
    var now = nowMinutes();
    return state.data.shifts.filter(function (s) {
      return s.benevoleIds.indexOf(b.id) !== -1 && s.end > now;
    })[0] || null;
  }

  function fillTemplate(text, b, shift) {
    return text
      .replace(/\s*\{prenom\}/g, b ? ' ' + firstName(b.nom) : '')
      .trim()
      .replace(/\{shift\}/g, shift ? shift.intitule : 'ton shift')
      .replace(/\{heure\}/g, shift ? time(shift.debut) : "l'heure prévue")
      .replace(/\{lieu\}/g, shift && shift.lieu ? shift.lieu : 'ton poste');
  }

  function smsHref(phones, body) {
    var ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    var enc = encodeURIComponent(body);
    if (ios) {
      return phones.length > 1
        ? 'sms:/open?addresses=' + phones.join(',') + '&body=' + enc
        : 'sms:' + phones[0] + '&body=' + enc;
    }
    return 'sms:' + phones.join(',') + '?body=' + enc;
  }

  function smsRecipients() {
    var ids = state.sms.ids.filter(function (id) { return benevole(id); });
    var sample = benevole(ids[0]);
    var html = sample
      ? '<div class="hint">Aperçu pour ' + esc(firstName(sample.nom)) + ' :</div><div class="preview">' + esc(fillTemplate(state.sms.text, sample, shiftForSms(sample))) + '</div>'
      : '';
    html += ids.map(function (id) {
      var b = benevole(id);
      var sent = state.sms.sent[id];
      if (!b.telephone) {
        return '<div class="row"><div class="grow"><div class="name">' + esc(b.nom) + '</div><div class="sub">Pas de numéro</div></div></div>';
      }
      return '<div class="row"><div class="grow"><div class="name">' + esc(b.nom) + '</div><div class="sub">' + esc(b.telephone) + '</div></div>' +
        '<a class="btn small' + (sent ? ' done' : '') + '" data-act="smsOpened" data-id="' + esc(id) + '" href="' + esc(smsHref([b.telephone], fillTemplate(state.sms.text, b, shiftForSms(b)))) + '">' + (sent ? 'Rouvrir' : 'Écrire') + '</a></div>';
    }).join('');
    var phones = ids.map(function (id) { return benevole(id).telephone; }).filter(Boolean);
    if (phones.length > 1) {
      var group = fillTemplate(state.sms.text, null, state.sms.shiftId ? shiftById(state.sms.shiftId) : null);
      html += '<div style="margin-top:10px"><a class="btn small ghost" href="' + esc(smsHref(phones, group)) + '">Tout en un SMS groupé</a>' +
        '<p class="hint">En groupe, chaque destinataire peut voir les numéros des autres et le message n\'est pas personnalisé.</p></div>';
    }
    return html;
  }

  function smsView() {
    var t = state.data.templates;
    return '<h1 class="section-title">Envoyer un SMS</h1>' +
      (t.length
        ? '<div class="chips">' + t.map(function (x) {
          return '<button class="chip" data-act="smsTemplate" data-id="' + esc(x.id) + '" aria-pressed="' + (state.sms.templateId === x.id) + '">' + esc(x.titre) + '</button>';
        }).join('') + '</div>'
        : '<p class="hint">Aucun modèle : ajoutez-en dans la feuille ModelesSMS.</p>') +
      '<label class="field"><span>Message</span><textarea id="sms-text">' + esc(state.sms.text) + '</textarea></label>' +
      '<p class="hint">Chaque bouton ouvre votre application SMS avec le message prêt : il reste à appuyer sur Envoyer.</p>' +
      '<section class="card" id="sms-recipients">' + smsRecipients() + '</section>';
  }

  /* ---------- Rendu manager ---------- */

  function renderManager() {
    if (!state.tab) state.tab = 'shifts';
    var managerNav = [['shifts', 'Shifts'], ['benevoles', 'Bénévoles'], ['profil', 'Profil']];
    if (state.tab === 'profil' && !state.stack.length) {
      root.innerHTML = shell(profilePage(), { nav: nav(managerNav) });
      return;
    }
    if (!state.data || !state.data.benevoles) {
      root.innerHTML = shell(skeleton());
      return;
    }
    var top = state.stack[state.stack.length - 1];
    if (top) {
      var body = top.type === 'shift' ? shiftDetail(top)
        : top.type === 'picker' ? picker(top)
        : top.type === 'benevole' ? benevoleDetail(top)
        : smsView();
      root.innerHTML = shell(body, { back: true, after: top.type === 'shift' ? selectBar(true) : '' });
      return;
    }
    var content = state.tab === 'shifts' ? managerShifts() : managerBenevoles();
    root.innerHTML = shell(content, { nav: nav(managerNav), after: selectBar(false) });
  }

  function render() {
    var y = window.scrollY;
    if (state.resetToken || (state.session && state.session.mustChange)) {
      renderChoosePassword();
      return;
    }
    if (!state.session) {
      renderLogin();
      return;
    }
    var cal = document.getElementById('calendar');
    if (cal) state.calScroll = { x: cal.scrollLeft, y: cal.scrollTop };
    document.body.dataset.role = state.session.user.role;
    if (state.session.user.role === 'manager') renderManager();
    else renderBenevole();
    cal = document.getElementById('calendar');
    if (cal && state.calScroll) {
      cal.scrollLeft = state.calScroll.x;
      cal.scrollTop = state.calScroll.y;
    }
    window.scrollTo(0, y);
  }

  /* ---------- Actions ---------- */

  var actions = {
    back: function () { history.back(); },
    logout: function () { if (window.confirm('Se déconnecter ?')) logout(); },
    refresh: function () { refresh(); },
    tab: function (el) {
      state.tab = el.dataset.tab;
      state.selected = {};
      window.scrollTo(0, 0);
      render();
      if (state.tab === 'profil') loadProfile();
    },
    openMyShift: function (el) { push({ type: 'myshift', id: el.dataset.id }); },
    removePhoto: function () {
      draft().photo = '';
      document.getElementById('photo-block').innerHTML = photoBlock();
    },
    demoLogin: function (el) {
      var f = document.getElementById('login-form');
      f.nom.value = el.dataset.nom;
      f.password.value = 'demo';
      doLogin(el.dataset.nom, 'demo');
    },
    demoReset: function () {
      api.resetDemo().then(function () { toast('Données de démo réinitialisées.'); });
    },
    filterPole: function (el) { state.filterPole = el.dataset.v; render(); },
    filterDay: function (el) { state.filterDay = el.dataset.v; state.calScroll = null; render(); },
    showForgot: function () {
      var field = document.querySelector('#login-form [name=nom]');
      if (field) state.loginNom = field.value;
      state.error = '';
      state.authView = 'forgot';
      renderLogin();
    },
    showLogin: function () {
      state.error = '';
      state.authView = 'login';
      renderLogin();
    },
    cancelPassword: function () {
      state.resetToken = null;
      state.error = '';
      state.authView = 'login';
      if (state.session && state.session.mustChange) logout();
      else render();
    },
    openShift: function (el) { state.selected = {}; push({ type: 'shift', id: el.dataset.id }); },
    openBenevole: function (el) { push({ type: 'benevole', id: el.dataset.id }); },
    selectAll: function (el) {
      var ids = el.dataset.ids.split(',');
      var all = ids.every(function (id) { return state.selected[id]; });
      state.selected = {};
      if (!all) ids.forEach(function (id) { state.selected[id] = true; });
      render();
    },
    remove: function (el) {
      var top = state.stack[state.stack.length - 1];
      var b = benevole(el.dataset.id);
      if (!window.confirm('Retirer ' + b.nom + ' de ce shift ?')) return;
      delete state.selected[b.id];
      mutate('unassign', { shiftId: top.id, benevoleId: b.id }, function () { toast(b.nom + ' retiré·e du shift.'); });
    },
    pickReplace: function (el) {
      state.search = '';
      push({ type: 'picker', shiftId: state.stack[state.stack.length - 1].id, oldId: el.dataset.id });
    },
    pickAdd: function () {
      state.search = '';
      push({ type: 'picker', shiftId: state.stack[state.stack.length - 1].id });
    },
    pick: function (el) {
      var top = state.stack[state.stack.length - 1];
      var b = benevole(el.dataset.id);
      var done = function () {
        toast(b.nom + ' est sur le shift.');
        history.back();
      };
      if (top.oldId) mutate('replace', { shiftId: top.shiftId, oldId: top.oldId, newId: b.id }, done);
      else mutate('assign', { shiftId: top.shiftId, benevoleId: b.id }, done);
    },
    addComment: function (el) {
      var box = document.getElementById('comment-text');
      var texte = box.value.trim();
      if (!texte) return box.focus();
      mutate('addComment', { benevoleId: el.dataset.id, texte: texte }, function () { toast('Commentaire ajouté.'); });
    },
    delComment: function (el) {
      if (window.confirm('Supprimer ce commentaire ?')) mutate('deleteComment', { id: el.dataset.id });
    },
    openSms: function () {
      var top = state.stack[state.stack.length - 1];
      var first = state.data.templates[0];
      state.sms = {
        ids: selectedIds(),
        shiftId: top && top.type === 'shift' ? top.id : null,
        templateId: first ? first.id : null,
        text: first ? first.texte : '',
        sent: {}
      };
      push({ type: 'sms' });
    },
    smsTemplate: function (el) {
      var t = state.data.templates.filter(function (x) { return x.id === el.dataset.id; })[0];
      state.sms.templateId = t.id;
      state.sms.text = t.texte;
      render();
    },
    smsOpened: function (el) {
      state.sms.sent[el.dataset.id] = true;
      // Le lien doit d'abord s'ouvrir : le bouton est mis à jour juste après.
      setTimeout(function () {
        document.getElementById('sms-recipients').innerHTML = smsRecipients();
      }, 300);
      return true;
    }
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el || el.dataset.act === 'toggle') return;
    var keepDefault = actions[el.dataset.act](el);
    if (!keepDefault) e.preventDefault();
  });

  document.addEventListener('change', function (e) {
    if (e.target.id === 'profile-photo' && e.target.files[0]) {
      resizePhoto(e.target.files[0]).then(function (photo) {
        draft().photo = photo;
        document.getElementById('photo-block').innerHTML = photoBlock();
      }).catch(function () {
        toast('Cette image ne peut pas être lue. Essayez-en une autre.');
      });
      return;
    }
    if (e.target.dataset.act !== 'toggle') return;
    if (e.target.checked) state.selected[e.target.dataset.id] = true;
    else delete state.selected[e.target.dataset.id];
    render();
  });

  document.addEventListener('input', function (e) {
    if (e.target.id === 'profile-age') draft().age = e.target.value;
    else if (e.target.id === 'profile-vitesse') draft().vitesse = e.target.value;
    else if (e.target.id === 'profile-description') draft().description = e.target.value;
    else if (e.target.id === 'picker-search') {
      state.search = e.target.value;
      document.getElementById('picker-list').innerHTML = pickerList(state.stack[state.stack.length - 1]);
    } else if (e.target.id === 'sms-text') {
      state.sms.text = e.target.value;
      state.sms.templateId = null;
      document.getElementById('sms-recipients').innerHTML = smsRecipients();
    }
  });

  document.addEventListener('submit', function (e) {
    e.preventDefault();
    if (e.target.id === 'login-form') doLogin(e.target.nom.value, e.target.password.value);
    else if (e.target.id === 'forgot-form') doForgot(e.target.identifiant.value);
    else if (e.target.id === 'password-form') doChoosePassword(e.target);
    else if (e.target.id === 'profile-form') saveProfile();
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.session && Date.now() - state.lastFetch > 120000) refresh(true);
  });

  /* ---------- Démarrage ---------- */

  render();
  if (state.session && !state.resetToken) refresh(!!state.data);
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    navigator.serviceWorker.register('sw.js');
  }
})();
