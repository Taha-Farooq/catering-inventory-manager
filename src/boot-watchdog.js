import { reportError } from './errors.js';

(function () {
  function showFatal(title, bodyHtml, code) {
    if (window.__dmgBoot && window.__dmgBoot.rendered) return;
    if (window.__dmgBoot && window.__dmgBoot.fatalUi) return;
    var root = document.getElementById('root');
    if (!root) return;
    if (window.__dmgBoot) window.__dmgBoot.fatalUi = true;
    if (code) reportError(code, { title: title });
    root.innerHTML =
      '<div class="boot-fatal" role="alert"><div class="boot-card">' +
      '<h1>' +
      title +
      '</h1>' +
      bodyHtml +
      '</div></div>';
  }
  /** Bundled app: do not rely on global React — only whether mount finished */
  function checkBundleHung() {
    if (window.__dmgBoot && window.__dmgBoot.rendered) return;
    showFatal(
      'App did not start',
      '<p>The application bundle did not finish loading. You may be offline, or the download was interrupted.</p>' +
        '<p class="boot-sub">Error code: DMG-E001. Try refresh. If you use GitHub Pages, wait a minute after deploy.</p>',
      'DMG-E001'
    );
  }
  window.addEventListener('load', function () {
    setTimeout(checkBundleHung, 25000);
  });
  setTimeout(function () {
    if (window.__dmgBoot && window.__dmgBoot.rendered) return;
    if (window.__dmgBoot && window.__dmgBoot.fatalUi) return;
    checkBundleHung();
  }, 45000);
  setTimeout(function () {
    if (window.__dmgBoot && window.__dmgBoot.rendered) return;
    if (window.__dmgBoot && window.__dmgBoot.fatalUi) return;
    var extra = '';
    if (window.__dmgBoot && window.__dmgBoot.bootError)
      extra = '<pre>' + String(window.__dmgBoot.bootError).replace(/</g, '&lt;') + '</pre>';
    else if (window.__dmgBoot && window.__dmgBoot.scriptError)
      extra = '<pre>' + String(window.__dmgBoot.scriptError).replace(/</g, '&lt;') + '</pre>';
    showFatal(
      'Still not ready',
      '<p>The app is taking unusually long to start. Try <strong>refresh</strong> or open the site in a private window.</p>' +
        extra +
        '<p class="boot-sub">Error code DMG-E002. Very slow devices may need a minute on first visit.</p>',
      'DMG-E002'
    );
  }, 90000);
})();
