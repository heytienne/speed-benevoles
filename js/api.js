/* Accès au backend : Apps Script en production, backend/Code.js dans le navigateur en démo. */
window.SpeedApi = (function () {
  var cfg = window.SPEED_CONFIG;
  var isDemo = !cfg.API_URL;
  var demoReady = null;

  function ApiError(message, code) {
    this.message = message;
    this.code = code;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function ensureDemo() {
    if (!demoReady) {
      demoReady = loadScript('js/demo-shim.js').then(function () {
        return loadScript('backend/Code.js');
      }).then(function () {
        window.speedDemoInit();
      });
    }
    return demoReady;
  }

  function send(body) {
    if (isDemo) {
      return ensureDemo().then(function () {
        return new Promise(function (resolve) { setTimeout(resolve, 200); });
      }).then(function () {
        return JSON.parse(window.doPost({ postData: { contents: body } }).getContent());
      });
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 30000);
    // text/plain évite le pré-contrôle CORS, qu'Apps Script ne sait pas traiter.
    return fetch(cfg.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      signal: ctrl.signal
    }).then(function (res) {
      clearTimeout(timer);
      return res.json();
    });
  }

  return {
    isDemo: isDemo,
    ApiError: ApiError,
    call: function (action, payload, token) {
      var body = JSON.stringify(Object.assign({ action: action, token: token }, payload || {}));
      return send(body).catch(function () {
        throw new ApiError('Connexion impossible. Vérifiez votre réseau.', 'network');
      }).then(function (res) {
        if (!res.ok) throw new ApiError(res.error, res.code);
        return res.data;
      });
    },
    resetDemo: function () {
      return ensureDemo().then(function () { window.speedDemoReset(); });
    }
  };
})();
