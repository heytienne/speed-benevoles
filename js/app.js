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
    sms: null
  };

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
    if (err.code === 'network') state.offline = true;
    toast(err.message || 'Une erreur est survenue.');
  }

  function refresh(silent) {
    if (!state.session) return Promise.resolve();
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
      '<main class="main">' + content + '</main></div></div>' + (options.after || '');
  }

  function nav(items) {
    return '<nav class="nav" aria-label="Navigation">' + items.map(function (it) {
      return '<button data-act="tab" data-tab="' + it[0] + '"' + (state.tab === it[0] ? ' aria-current="page"' : '') + '>' + it[1] + '</button>';
    }).join('') + '</nav>';
  }

  function ticket(s, opts) {
    var now = nowMinutes();
    var status = s.end <= now ? 'past' : s.start <= now ? 'now' : '';
    var tag = opts.href ? 'button' : 'div';
    var attrs = opts.href ? ' data-act="openShift" data-id="' + esc(s.id) + '"' : '';
    return '<' + tag + ' class="ticket ' + (status === 'past' ? 'past' : '') + '"' + attrs + '>' +
      '<div class="ticket-body"><div class="hex"><span>' + esc(time(s.debut)) + '<small>→ ' + esc(time(s.fin)) + '</small></span></div>' +
      '<div class="ticket-text"><div class="ticket-title">' + esc(s.intitule) + '</div>' +
      '<div class="ticket-meta">' + (status === 'now' ? '<span class="pill now">En cours</span> ' : '') + (opts.extra || '') + '</div></div></div>' +
      '<div class="ticket-strip"><span>→ ' + esc(s.pole.toUpperCase()) + '</span><span>' + esc((s.lieu || '').toUpperCase()) + '</span></div>' +
      '</' + tag + '>';
  }

  function groupByDay(shifts, draw) {
    var html = '';
    unique(shifts.map(function (s) { return s.date; })).forEach(function (d) {
      html += '<h2 class="day-title">' + esc(dayLabel(d)) + '</h2>';
      shifts.filter(function (s) { return s.date === d; }).forEach(function (s) { html += draw(s); });
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

  function renderLogin() {
    document.body.dataset.role = 'login';
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
      '<label class="field"><span>Nom</span><input type="text" name="nom" autocomplete="username" autocapitalize="words" required></label>' +
      '<label class="field"><span>Mot de passe</span><input type="password" name="password" autocomplete="current-password" required></label>' +
      '<button class="btn block" type="submit"' + (state.busy ? ' disabled' : '') + '>' + (state.busy ? 'Connexion…' : 'Se connecter') + '</button>' +
      '<p class="hint">Mot de passe oublié ? Contactez votre référent de pôle.</p>' + demo + '</form></div></div>';
  }

  function doLogin(nom, password) {
    state.busy = true;
    state.error = '';
    renderLogin();
    api.call('login', { nom: nom, password: password }).then(function (res) {
      state.session = res;
      write(SESSION_KEY, res);
      state.busy = false;
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
    var content = !state.data ? skeleton()
      : state.tab === 'planning' ? benevolePlanning()
      : state.tab === 'contacts' ? benevoleContacts()
      : benevoleStats();
    root.innerHTML = shell(content, { after: nav([['planning', 'Planning'], ['contacts', 'Référents'], ['stats', 'Stats']]) });
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
      return ticket(s, { extra: extra });
    });
  }

  function benevoleContacts() {
    var poles = unique(state.data.shifts.map(function (s) { return s.pole; }));
    if (!poles.length) return '<div class="empty"><b>Aucun référent</b>Vos référents apparaîtront avec vos shifts.</div>';
    return '<h1 class="section-title">Mes référents</h1>' + poles.map(function (pole) {
      var shift = state.data.shifts.filter(function (s) { return s.pole === pole; })[0];
      var refs = shift.referents.length
        ? shift.referents.map(function (r) {
          return '<div class="row" style="display:block"><div class="name">' + esc(r.nom) + '</div>' +
            '<div class="sub">' + esc(r.telephone) + '</div><div class="contact-actions">' + contactButtons(r) + '</div></div>';
        }).join('')
        : '<p class="hint">Aucun référent renseigné pour ce pôle.</p>';
      return '<section class="card"><h3>Pôle ' + esc(pole) + '</h3>' + refs + '</section>';
    }).join('');
  }

  function bars(rows, format) {
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat(0.01));
    return rows.map(function (r) {
      return '<div class="bar-row"><div class="bar-head"><span>' + esc(r.label) + '</span><span>' + esc(format(r.value)) + '</span></div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + (r.value / max * 100) + '%"></div></div></div>';
    }).join('');
  }

  function sumBy(shifts, key, label) {
    return unique(shifts.map(function (s) { return s[key]; })).map(function (k) {
      return {
        label: label ? label(k) : k,
        value: shifts.filter(function (s) { return s[key] === k; }).reduce(function (t, s) { return t + s.heures; }, 0)
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
      '<section class="card"><h3>Heures par jour</h3>' + bars(sumBy(shifts, 'date', dayLabel), hours) + '</section>' +
      '<section class="card"><h3>Heures par pôle</h3>' + bars(sumBy(shifts, 'pole'), hours) + '</section>' +
      '<section class="card"><h3>Toute l\'équipe</h3><div class="tiles" style="margin:8px 0 0">' +
      '<div class="tile"><div class="num">' + fest.benevoles + '</div><div class="lab">bénévoles</div></div>' +
      '<div class="tile"><div class="num">' + esc(hours(fest.heures)) + '</div><div class="lab">au total</div></div></div>' +
      '<p class="hint">Vous assurez ' + share + ' % des heures prévues. Merci !</p></section>';
  }

  /* ---------- Manager ---------- */

  function visibleShifts() {
    return state.data.shifts.filter(function (s) {
      return (!state.filterPole || s.pole.toLowerCase() === state.filterPole.toLowerCase()) && (!state.filterDay || s.date === state.filterDay);
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
    if (d.poles.length > 1) {
      html += '<div class="chips" aria-label="Filtrer par pôle"><button class="chip" data-act="filterPole" data-v="" aria-pressed="' + !state.filterPole + '">Tous</button>' +
        d.poles.map(function (p) {
          return '<button class="chip" data-act="filterPole" data-v="' + esc(p) + '" aria-pressed="' + (state.filterPole === p) + '">' + esc(p) + '</button>';
        }).join('') + '</div>';
    }
    var days = unique(d.shifts.map(function (s) { return s.date; }));
    if (days.length > 1) {
      html += '<div class="chips" aria-label="Filtrer par jour"><button class="chip" data-act="filterDay" data-v="" aria-pressed="' + !state.filterDay + '">Tous les jours</button>' +
        days.map(function (x) {
          return '<button class="chip" data-act="filterDay" data-v="' + esc(x) + '" aria-pressed="' + (state.filterDay === x) + '">' + esc(dayShort(x)) + '</button>';
        }).join('') + '</div>';
    }
    return html;
  }

  function managerShifts() {
    var shifts = visibleShifts();
    return '<h1 class="section-title">Shifts du pôle</h1>' + managerFilters() + (shifts.length
      ? groupByDay(shifts, function (s) {
        return ticket(s, { href: true, extra: staffingPill(s) });
      })
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
      '<div class="sub">' + esc(b.telephone) + (n ? ' · ' + plural(n, 'commentaire') : '') + '</div></button></div>' +
      (options && options.actions ? '<div class="row-actions">' + options.actions + '</div>' : '') + '</div>';
  }

  function managerBenevoles() {
    var list = state.data.benevoles.filter(function (b) { return b.surMesPoles; });
    if (!list.length) return '<h1 class="section-title">Mes bénévoles</h1><div class="empty"><b>Personne pour l\'instant</b>Aucun bénévole affecté à vos pôles.</div>';
    var all = list.every(function (b) { return state.selected[b.id]; });
    return '<h1 class="section-title">Mes bénévoles</h1>' +
      '<button class="btn small ghost" data-act="selectAll" data-ids="' + esc(list.map(function (b) { return b.id; }).join(',')) + '">' + (all ? 'Tout désélectionner' : 'Tout sélectionner') + '</button>' +
      '<div style="margin-top:6px">' + list.map(function (b) { return benevoleRow(b); }).join('') + '</div>';
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
      return benevoleRow(b, {
        actions: '<button class="btn small ghost" data-act="pickReplace" data-id="' + esc(id) + '">Changer</button>' +
          '<button class="icon-btn" data-act="remove" data-id="' + esc(id) + '" aria-label="Retirer ' + esc(b.nom) + '">✕</button>'
      });
    }).join('');
    return ticket(s, { extra: dayShort(s.date) + ' ' + staffingPill(s) }) +
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
    var list = state.data.benevoles.filter(function (b) {
      return s.benevoleIds.indexOf(b.id) === -1 && (!q || b.nom.toLowerCase().indexOf(q) !== -1);
    }).map(function (b) { return { b: b, conflict: isFree(b, s) }; }).sort(function (a, b) {
      return (a.conflict ? 1 : 0) - (b.conflict ? 1 : 0);
    });
    if (!list.length) return '<div class="empty">Aucun bénévole trouvé.</div>';
    return list.map(function (it) {
      var label = it.conflict
        ? '<span class="pill warn">Déjà sur ' + esc(it.conflict.intitule) + ' ' + esc(time(it.conflict.debut)) + '-' + esc(time(it.conflict.fin)) + '</span>'
        : '<span class="pill">Libre</span>';
      return '<div class="row"><button class="link-btn" data-act="pick" data-id="' + esc(it.b.id) + '"><div class="name">' + esc(it.b.nom) + '</div>' + label + '</button></div>';
    }).join('');
  }

  function picker(view) {
    var s = shiftById(view.shiftId);
    if (!s) return '<div class="empty"><b>Shift introuvable</b></div>';
    var title = view.oldId ? 'Remplacer ' + firstName(benevole(view.oldId).nom) : 'Ajouter un bénévole';
    return '<h1 class="section-title">' + esc(title) + '</h1><p class="hint">' + esc(s.intitule) + ' · ' + esc(dayShort(s.date)) + ' · ' + esc(time(s.debut)) + ' → ' + esc(time(s.fin)) + '</p>' +
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
      '<section class="card"><h3>Ses shifts</h3>' + (b.busy.length ? b.busy.map(function (x) {
        return '<div class="row" style="min-height:0"><div class="grow"><div class="name">' + esc(x.intitule) + '</div><div class="sub">' +
          esc(x.pole) + ' · ' + esc(dayShort(x.date)) + ' · ' + esc(time(x.debut)) + ' → ' + esc(time(x.fin)) + '</div></div></div>';
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
    root.innerHTML = shell(content, { after: nav([['shifts', 'Shifts'], ['benevoles', 'Bénévoles']]) + selectBar(false) });
  }

  function render() {
    var y = window.scrollY;
    if (!state.session) {
      renderLogin();
      return;
    }
    document.body.dataset.role = state.session.user.role;
    if (state.session.user.role === 'manager') renderManager();
    else renderBenevole();
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
    filterDay: function (el) { state.filterDay = el.dataset.v; render(); },
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
    if (e.target.dataset.act !== 'toggle') return;
    if (e.target.checked) state.selected[e.target.dataset.id] = true;
    else delete state.selected[e.target.dataset.id];
    render();
  });

  document.addEventListener('input', function (e) {
    if (e.target.id === 'picker-search') {
      state.search = e.target.value;
      document.getElementById('picker-list').innerHTML = pickerList(state.stack[state.stack.length - 1]);
    } else if (e.target.id === 'sms-text') {
      state.sms.text = e.target.value;
      state.sms.templateId = null;
      document.getElementById('sms-recipients').innerHTML = smsRecipients();
    }
  });

  document.addEventListener('submit', function (e) {
    if (e.target.id !== 'login-form') return;
    e.preventDefault();
    doLogin(e.target.nom.value, e.target.password.value);
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.session && Date.now() - state.lastFetch > 120000) refresh(true);
  });

  /* ---------- Démarrage ---------- */

  render();
  if (state.session) refresh(!!state.data);
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    navigator.serviceWorker.register('sw.js');
  }
})();
