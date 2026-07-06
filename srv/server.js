const cds = require('@sap/cds')

// Nur im öffentlichen Demo-Host (DEMO_PUBLIC). Lokal/BTP bleibt komplett unberührt.
cds.on('bootstrap', app => {
  if (process.env.DEMO_PUBLIC === 'true') {
    // Kein Browser-Login-Popup: die mocked auth schickt bei 401 einen
    // "WWW-Authenticate: Basic"-Header -> der Browser zeigt seinen Login-Dialog.
    // Im Demo entfernen wir diesen Challenge-Header (aus setHeader UND writeHead);
    // der Frontend-Fallback (whoami 401 -> Basic 'meister') greift unverändert.
    app.use((req, res, next) => {
      const isWWW = n => String(n).toLowerCase() === 'www-authenticate'
      const _set = res.setHeader.bind(res)
      res.setHeader = (name, value) => (isWWW(name) ? res : _set(name, value))
      const _writeHead = res.writeHead.bind(res)
      res.writeHead = (...args) => {
        try { res.removeHeader('WWW-Authenticate') } catch (e) { /* noop */ }
        const last = args[args.length - 1]
        if (last && typeof last === 'object' && !Array.isArray(last)) {
          for (const k of Object.keys(last)) if (isWWW(k)) delete last[k]
        }
        return _writeHead(...args)
      }
      next()
    })
    // nackte Root-URL direkt auf die Fiori-App leiten (statt CAP-Service-Index)
    app.get('/', (_req, res) => res.redirect('/webapp/index.html'))
  }
})

module.exports = cds.server
