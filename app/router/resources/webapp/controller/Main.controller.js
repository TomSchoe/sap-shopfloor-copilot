sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/ActionSheet",
  "sap/m/Button",
  "sap/m/MessageToast"
], function (Controller, JSONModel, ActionSheet, Button, MessageToast) {
  "use strict";

  const BASE = "/shopfloor";
  // Lokaler Demo-Login (mocked basic-auth) — NUR auf localhost aktiv. In Produktion
  // leer: dann liefert der App-Router/XSUAA den Token (Session-Cookie) automatisch.
  const IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  let demoAuth = IS_LOCAL ? "Basic " + btoa("meister:meister") : "";

  // Aktive UI-Sprache (de|en) — steuert i18n UND den Accept-Language-Header ans Backend
  function currentLang() {
    try {
      const l = (sap.ui.getCore().getConfiguration().getLanguage() || "de").toLowerCase();
      return l.indexOf("en") === 0 ? "en" : "de";
    } catch (e) { return "de"; }
  }

  // OData V4 Function (GET) bzw. Action (POST) bequem aufrufen.
  // Accept-Language gibt die UI-Sprache mit -> das Backend liefert Stationsnamen/Ticker/Fehler in der Sprache.
  async function fn(path) {
    const headers = { "Accept-Language": currentLang() };
    if (demoAuth) headers.Authorization = demoAuth;
    const r = await fetch(`${BASE}/${path}`, { headers });
    if (!r.ok) throw new Error("HTTP " + r.status + " – " + path);
    const j = await r.json();
    return j.value !== undefined ? j.value : j;
  }
  async function action(name, body) {
    const headers = { "content-type": "application/json", "Accept-Language": currentLang() };
    if (demoAuth) headers.Authorization = demoAuth;
    const r = await fetch(`${BASE}/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body || {})
    });
    // Fehler (400/429/500) als Error werfen — mit der Server-Meldung (z.B. Rate-Limit-Text),
    // damit der Aufrufer sie anzeigen kann statt ein Fehler-JSON als Daten zu verarbeiten.
    const j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error((j.error && j.error.message) || "HTTP " + r.status);
    return j;
  }

  // 1 Nachkommastelle im Sprachformat (de: Komma, en: Punkt)
  function fmt1(x) {
    const s = Number(x).toFixed(1);
    return currentLang() === "de" ? s.replace(".", ",") : s;
  }

  // Mini-Markdown -> HTML (Whitelist von sap.m.FormattedText: h4/strong/code/ul/li/p).
  // Deckt Überschriften, Fett, Code, Aufzählungen (- / *  und 1. 2. …) und Absätze ab.
  function mdToHtml(md) {
    const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const inline = s => esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, "<code>$1</code>");
    let html = "", inList = false;
    for (const raw of (md || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) { if (inList) { html += "</ul>"; inList = false; } continue; }
      let m;
      if ((m = line.match(/^#{1,6}\s+(.*)$/))) {
        if (inList) { html += "</ul>"; inList = false; }
        html += "<h4>" + inline(m[1]) + "</h4>";
      } else if ((m = line.match(/^(?:[-*]|\d+\.)\s+(.*)$/))) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += "<li>" + inline(m[1]) + "</li>";
      } else {
        if (inList) { html += "</ul>"; inList = false; }
        html += "<p>" + inline(line) + "</p>";
      }
    }
    if (inList) html += "</ul>";
    return html;
  }

  return Controller.extend("shopfloor.copilot.controller.Main", {

    onInit: function () {
      const rb = this.getOwnerComponent().getModel("i18n").getResourceBundle();
      this._rb = rb;
      const lang = currentLang();
      // Feste Reihenfolge der 9 Takte/Stationen (für die Taktstraßen-Ansicht inkl. leerer Takte)
      this._stationNames = [];
      for (let i = 1; i <= 9; i++) this._stationNames.push(rb.getText("station" + i));
      this._m = new JSONModel({
        kpi: {},
        copilot: { messages: [{ role: "assistant", html: rb.getText("chatGreeting"), tool: "" }], provider: "", providerLabel: "…", switchable: false },
        detail: { title: "", rows: [] },
        flow: [], station: { selected: false, title: "", info: "", stationNo: 0, stationName: "", orders: [], rows: [], bookings: [] },
        live: { shiftLabel: "", clock: "", unitsThisShift: 0, wipCount: 0, wip: [], takte: [], events: [], mode: "demo", shiftShort: rb.getText("shiftWord") },
        me: { user: "", isSupervisor: false, isWorker: false, roleLabel: "…" },
        demo: { user: "meister", isLocal: IS_LOCAL },
        lang: lang, langLabel: lang.toUpperCase(),
        audit: [],
        shiftReport: { early: [], late: [] },
        taktReport: { stations: [], filter: "all" },
        orderDetail: { order: "", model: "", sn: "", valveLine: "", marketLine: "", hasMismatch: false, voltage: "", power: "", dryer: "", wrg: "", takt: 0, station: "" },
        workerQuality: { rows: [] }
      });
      this.getView().setModel(this._m);

      // Klicks auf die Takt-Knoten im SVG: Event-Delegation auf dem stabilen ScrollContainer,
      // damit Klicks auch nach dem 5-s-Neurendern des Diagramms weiter funktionieren.
      this.byId("flowScroll").addEventDelegate({
        onclick: function (oEvent) {
          const node = oEvent.target.closest && oEvent.target.closest("[data-st]");
          if (node) this._selectStation(parseInt(node.getAttribute("data-st"), 10));
        }.bind(this)
      });

      this._init();
    },

    _init: async function () {
      await this._ensureDemoAuth();  // öffentlicher Demo-Host: Basic-Auth-Default setzen (kein Login)
      await this._loadMe();          // Rolle zuerst → steuert die abgespeckte Sicht
      this._loadProvider();          // aktiver KI-Pfad für die Copilot-Anzeige
      this._loadKpis();
      this._loadFlow();
      this._loadLive();
      this._loadAudit();
      this._liveTimer = setInterval(() => this._loadLive(), 5000);
    },

    // Öffentlicher Demo-Host: dort läuft mocked auth OHNE Login. Ein whoami ohne Header → 401.
    // Dann Basic "meister" als Default setzen (wie lokal), damit kein Browser-Login-Popup kommt.
    // BTP (XSUAA-Cookie) → whoami liefert 200, demoAuth bleibt leer. Lokal → früher Ausstieg.
    _ensureDemoAuth: async function () {
      if (IS_LOCAL || demoAuth) return;
      try {
        const r = await fetch(`${BASE}/whoami()`);
        if (r.status === 401) demoAuth = "Basic " + btoa("meister:meister");
      } catch (e) { /* transient – nächster Load versucht erneut */ }
    },

    _loadMe: async function () {
      try {
        const me = await fn("whoami()");
        me.roleLabel = this._rb.getText(me.isSupervisor ? "roleMeister" : "roleMitarbeiter");
        this._m.setProperty("/me", me);
        if (me.demoSwitcher) this._m.setProperty("/demo/isLocal", true);   // Demo-Host: Rollen-Umschalter zeigen
      } catch (e) { /* Defaults bleiben (Werker-Sicht) */ }
    },

    // Sprache umschalten (DE|EN-Segmentbutton): setzt sap-ui-language + laedt neu
    // -> UI5 laedt i18n_de bzw. i18n_en, das Backend bekommt beim naechsten fetch Accept-Language mit.
    onSwitchLanguage: function (oEvent) {
      const next = oEvent.getParameter("item").getKey();   // "de" | "en"
      if (next === currentLang()) return;
      const url = new URL(window.location.href);
      url.searchParams.set("sap-ui-language", next);
      window.location.href = url.toString();
    },

    // Welcher KI-Pfad (lokal / Abo / API) bedient den Copilot — für die Anzeige im Chat-Fenster
    _loadProvider: async function () {
      try { this._applyProvider(await fn("copilotProvider()")); }
      catch (e) { /* Default-Label bleibt */ }
    },
    _applyProvider: function (p) {
      this._m.setProperty("/copilot/provider", p.provider);
      this._m.setProperty("/copilot/providerLabel", p.label);
      this._m.setProperty("/copilot/switchable", !!p.switchable);
    },

    // KI-Pfad live umschalten (nur Meister, nur lokal) — ohne cds-watch-Neustart
    onSwitchProvider: async function (oEvent) {
      const key = oEvent.getParameter("item").getKey();
      try {
        const p = await action("setCopilotProvider", { provider: key });
        if (p.error) throw new Error(p.error.message || this._rb.getText("switchFailed"));
        this._applyProvider(p);
        MessageToast.show(this._rb.getText("aiPathSwitched", [p.label]));
      } catch (e) {
        MessageToast.show(e.message || this._rb.getText("switchFailed"));
        this._loadProvider();   // zurück auf den echten Stand
      }
    },

    // Demo-Login wechseln (nur lokal): setzt den basic-auth-Header und lädt rollenabhängig neu
    onSwitchRole: async function (oEvent) {
      const user = oEvent.getParameter("item").getKey();   // "mitarbeiter" (Werker) | "meister" (Supervisor)
      demoAuth = "Basic " + btoa(user + ":" + user);
      this._m.setProperty("/demo/user", user);
      const pop = this.byId("copilotPopover");
      if (pop && pop.isOpen()) pop.close();
      this._m.setProperty("/station", { selected: false, title: "", info: "", rows: [] });
      this._m.setProperty("/detail", { title: "", rows: [] });
      await this._loadMe();   // Rolle ZUERST — _loadKpis liest /me/isSupervisor aus dem Model
      this._loadKpis();
      this._loadLive();
      this._loadAudit();
    },

    // Zeitmodus umschalten: Demo (beschleunigte Schicht-Uhr) <-> Echtzeit (Systemzeit, reale Takte)
    onSwitchTimeMode: function (oEvent) {
      const mode = oEvent.getParameter("item").getKey();
      action("setTimeMode", { mode }).then(() => this._loadLive()).catch(() => {});
    },

    onExit: function () {
      if (this._liveTimer) clearInterval(this._liveTimer);
    },

    _loadKpis: async function () {
      try {
      const sup = this._m.getProperty("/me/isSupervisor");
      const [bn, fs] = await Promise.all([fn("bottleneck()"), fn("failureSummary()")]);
      const mm = sup ? await fn("configMismatches()") : [];   // Worker darf das nicht (403)
      const wq = sup ? await fn("workerQuality()") : [];      // Leistungsdaten – nur Meister
      const totalFails = (fs || []).reduce((s, x) => s + x.fails, 0);
      const ZIEL = 26;   // Zieltakt in Minuten
      const engp = (bn || []).filter(r => r.avgCycleSec / 60 > ZIEL);
      this._m.setProperty("/kpi", {
        bottleneckCount: String(engp.length),
        bottleneckTakte: engp.length ? this._rb.getText("takt") + " " + engp.map(r => r.stationNo).sort((a, b) => a - b).join(", ") : this._rb.getText("none"),
        fails: String(totalFails),
        mismatches: String((mm || []).length),
        workerIssues: String((wq || []).filter(w => w.rate >= 40).length)
      });
      } catch (e) { /* transient (z.B. beim Rollenwechsel) – nächster Load holt auf */ }
    },

    onBottleneck: async function () {
      const rows = await fn("bottleneck()");   // absteigend nach Taktzeit
      const ZIEL = 26;
      const rb = this._rb;
      this._showDetail(rb.getText("bottleneckDetailTitle", [ZIEL]), rows.map(r => {
        const over = r.avgCycleSec / 60 > ZIEL;
        return {
          line1: `${rb.getText("takt")} ${r.stationNo} – ${r.name}`,
          line2: over ? rb.getText("overTargetBy", [fmt1((r.avgCycleSec - ZIEL * 60) / 60)]) : rb.getText("bookingsCount", [r.samples]),
          info: `${fmt1(r.avgCycleSec / 60)} ${rb.getText("minUnit")}`, state: over ? "Error" : "Success",
          stationNo: r.stationNo   // macht die Zeile im Popup klickbar → Takt-Detail
        };
      }));
    },

    // Klick auf eine Popup-Zeile mit stationNo (Engpass-Kachel): schließt das Popup und
    // öffnet die Takt-Detailübersicht (Ø-Zeit, Engpass-Status, Fehler, Buchungen).
    onKpiItemPress: function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext();
      const st = ctx && ctx.getProperty("stationNo");
      if (st == null) return;
      this.byId("kpiDetailDialog").close();
      this._selectStation(Number(st));
    },

    onFailures: async function () {
      const rows = await fn("failureSummary()");
      this._showDetail(this._rb.getText("failuresDetailTitle"), rows.map(r => ({
        line1: r.measureType, line2: "", info: `${r.fails}`, state: "Error"
      })));
    },

    onMismatches: async function () {
      const rows = await fn("configMismatches()");
      this._showDetail(this._rb.getText("mismatchesDetailTitle"), rows.map(r => ({
        line1: `${r.orderNo} – ${r.kind}`, line2: `Station ${r.station}`,
        info: this._rb.getText("targetSlashInstalled", [r.required, r.installed]), state: "Error"
      })));
    },

    // Klick auf "Auf der Linie" -> Popup, welcher Auftrag an welchem Takt steht (live)
    onWipDetail: function () {
      this.byId("wipDialog").open();
    },

    onCloseWip: function () {
      this.byId("wipDialog").close();
    },

    // Klick auf einen belegten Takt -> Auftragszettel; bei Stau (≥2) erst Auftrag wählen
    onOpenOrder: function (oEvent) {
      const ctx = oEvent.getSource().getBindingContext();
      const item = ctx && ctx.getObject();
      if (!item || !item.orderList || !item.orderList.length) return;   // leerer Takt
      if (item.orderList.length === 1) { this._showOrderZettel(item.orderList[0], item); return; }
      this._openOrderChooser(item, oEvent.getSource());
    },

    // Auswahl-Popover: welcher Auftrag bei Stau (mehrere am selben Takt) geöffnet werden soll
    _openOrderChooser: function (item, source) {
      const that = this;
      const sheet = new ActionSheet({
        title: this._rb.getText("chooseOrder", [item.takt]),
        showCancelButton: true,
        buttons: item.orderList.map(o => new Button({
          text: o, icon: "sap-icon://sales-order",
          press: function () { that._showOrderZettel(o, item); }
        }))
      });
      this.getView().addDependent(sheet);
      sheet.attachAfterClose(function () { sheet.destroy(); });
      sheet.openBy(source);
    },

    // Klick auf einen Auftrag im Takt-Detail (aus dem Diagramm) -> Auftragszettel
    onOpenStationOrder: function (oEvent) {
      const item = oEvent.getSource().getBindingContext().getObject();
      if (!item || !item.order) return;
      this._showOrderZettel(item.order, {
        takt: this._m.getProperty("/station/stationNo"),
        stationName: this._m.getProperty("/station/stationName")
      });
    },

    // Auftragssuche in der ShellBar -> Auftragszettel ("ORD-5003" oder "5003")
    onSearchOrder: function (oEvent) {
      let q = (oEvent.getParameter("query") || "").trim();
      if (!q) return;
      if (/^\d+$/.test(q)) q = "ORD-" + q;          // reine Zahl -> ORD-Präfix
      this._showOrderZettel(q.toUpperCase(), { takt: "—", stationName: this._rb.getText("viaSearch") });
    },

    _showOrderZettel: async function (order, item) {
      const rb = this._rb;
      let d;
      try { d = await action("orderDetail", { order }); } catch (e) { d = null; }
      if (!d || d.model === "–") { MessageToast.show(rb.getText("orderNotFound", [order])); return; }
      const valveLine  = d.valveMismatch  ? rb.getText("targetInstalled", [d.requiredValve, d.installedValve]) : d.requiredValve;
      const marketLine = d.marketMismatch ? rb.getText("targetInstalled", [d.market, d.installedMarket]) : d.market;
      this._m.setProperty("/orderDetail", {
        order: d.order, model: d.model, sn: d.sn,
        valveLine, marketLine, hasMismatch: d.valveMismatch || d.marketMismatch,
        voltage: d.voltage, power: d.power,
        dryer: rb.getText(d.dryer ? "yes" : "no"), wrg: rb.getText(d.wrg ? "yes" : "no"),
        takt: item.takt, station: item.stationName
      });
      this.byId("orderDialog").open();
    },

    onCloseOrder: function () {
      this.byId("orderDialog").close();
    },

    // Klick auf "Auffällige Mitarbeiter" -> Popup mit Fehlerquoten (Meister; Namen sonst maskiert)
    onWorkerQuality: async function () {
      const rows = await fn("workerQuality()");
      this._m.setProperty("/workerQuality/rows", (rows || []).map(w => ({
        worker: w.worker, pernr: w.pernr, rate: w.rate,
        detail: this._rb.getText("workerDetail", [w.takt, w.fail, w.total]),
        state: w.rate >= 40 ? "Error" : "Warning"
      })));
      this.byId("workerDialog").open();
    },

    onCloseWorker: function () {
      this.byId("workerDialog").close();
    },

    // Klick auf "Zielzeit pro Takt" -> Popup mit Ø-Zeit je Station (grün unter, rot über Zielzeit)
    onTaktDetail: async function () {
      const rows = await fn("bottleneck()");
      const target = this._m.getProperty("/live/taktMin") || 26;
      const rb = this._rb;
      this._taktAll = (rows || []).slice().sort((a, b) => a.stationNo - b.stationNo).map(r => {
        const min = r.avgCycleSec / 60, over = min > target, d = min - target;
        return {
          name: `${rb.getText("takt")} ${r.stationNo} – ${r.name}`,
          info: `${fmt1(min)} ${rb.getText("minUnit")}`,
          state: over ? "Error" : "Success",
          delta: rb.getText("deltaVsTarget", [(d >= 0 ? "+" : "") + fmt1(d)])
        };
      });
      this._applyTaktFilter();
      this.byId("taktDialog").open();
    },

    // Filter im Takt-Popup: alle / nur eingehalten (grün) / nur über Zielzeit (rot)
    _applyTaktFilter: function () {
      const f = this._m.getProperty("/taktReport/filter") || "all";
      const all = this._taktAll || [];
      const list = f === "ok" ? all.filter(s => s.state === "Success")
                 : f === "over" ? all.filter(s => s.state === "Error")
                 : all;
      this._m.setProperty("/taktReport/stations", list);
    },

    onFilterTakt: function () {
      this._applyTaktFilter();
    },

    onCloseTakt: function () {
      this.byId("taktDialog").close();
    },

    // Klick auf "Stück (Schicht)" -> Popup mit den fertigen Aufträgen (Früh- + Spätschicht)
    onUnitsDetail: async function () {
      const orders = (await fn("completedOrders()")) || [];
      this._m.setProperty("/shiftReport/early", orders.filter(o => o.shiftKey === "EARLY"));
      this._m.setProperty("/shiftReport/late", orders.filter(o => o.shiftKey === "LATE"));
      this.byId("shiftReportDialog").open();
    },

    onCloseShiftReport: function () {
      this.byId("shiftReportDialog").close();
    },

    onAsk: async function () {
      const q = this.byId("qInput").getValue().trim();
      if (!q) return;
      this.byId("qInput").setValue("");
      // Frage + Platzhalter-Antwort an den Verlauf anhängen
      const msgs = (this._m.getProperty("/copilot/messages") || []).slice();
      msgs.push({ role: "user", html: this._escapeHtml(q), tool: "" });
      const botIdx = msgs.push({ role: "assistant", html: this._rb.getText("thinking"), tool: "" }) - 1;
      this._m.setProperty("/copilot/messages", msgs);
      this._scrollChat();
      try {
        const res = await action("askCopilot", { question: q });
        const upd = (this._m.getProperty("/copilot/messages") || []).slice();
        upd[botIdx] = { role: "assistant", html: mdToHtml(res.answer), tool: res.usedTool || "" };
        this._m.setProperty("/copilot/messages", upd);
        this._loadAudit();   // Audit-Log nach erfolgreichem Aufruf aktualisieren
      } catch (e) {
        const upd = (this._m.getProperty("/copilot/messages") || []).slice();
        // Server-Meldung zeigen, wenn vorhanden (z.B. Rate-Limit-Text oder 400-Hinweis)
        const msg = e && e.message && e.message.indexOf("HTTP") !== 0 ? this._escapeHtml(e.message) : this._rb.getText("chatError");
        upd[botIdx] = { role: "assistant", html: msg, tool: "" };
        this._m.setProperty("/copilot/messages", upd);
      }
      this._scrollChat();
    },

    // Chat-Verlauf leeren (session-scoped; keine Server-Historie)
    onClearChat: function () {
      this._m.setProperty("/copilot/messages", [
        { role: "assistant", html: this._rb.getText("chatCleared"), tool: "" }
      ]);
    },

    // Nutzereingabe HTML-sicher als Absatz (FormattedText erlaubt nur eine Whitelist)
    _escapeHtml: function (s) {
      return "<p>" + String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</p>";
    },

    // Chat ans Ende scrollen (nach dem Rendern)
    _scrollChat: function () {
      const sc = this.byId("copilotScroll");
      if (sc) setTimeout(function () { sc.scrollTo(0, 100000, 300); }, 60);
    },

    onToggleCopilot: function () {
      const pop = this.byId("copilotPopover");
      if (pop.isOpen()) { pop.close(); return; }
      pop.openBy(this.byId("copilotFab"));
      setTimeout(() => { const i = this.byId("qInput"); if (i) i.focus(); }, 200);
    },

    onCloseCopilot: function () {
      this.byId("copilotPopover").close();
    },

    // Abmelden (nur Cloud): der App-Router-Endpunkt /logout beendet die XSUAA-Session
    // zentral und leitet auf /logout.html. Lokal existiert die Route nicht → Hinweis.
    onLogout: function () {
      if (IS_LOCAL) { MessageToast.show(this._rb.getText("logoutCloudOnly")); return; }
      window.location.href = "/logout";
    },

    _showDetail: function (title, rows) {
      this._m.setProperty("/detail", { title, rows });
      this.byId("kpiDetailDialog").open();
    },

    onCloseKpiDetail: function () {
      this.byId("kpiDetailDialog").close();
    },

    // Live-Linienmonitor pollen (alle 5 s) – Schicht, Ausstoß, WIP, Ticker
    _loadLive: async function () {
      try {
        const d = await fn("liveStatus()");
        // WIP je Station zählen → Stau-Flag (≥2 Aufträge an einer Station)
        const cnt = {};
        (d.wip || []).forEach(w => { cnt[w.stationNo] = (cnt[w.stationNo] || 0) + 1; });
        d.wip = (d.wip || []).map(w => ({ ...w, atStation: cnt[w.stationNo], jam: cnt[w.stationNo] >= 2 }));
        // Feste Taktstraße: 9 Takte immer, leere als "frei"
        const byTakt = {};
        d.wip.forEach(w => { (byTakt[w.stationNo] = byTakt[w.stationNo] || []).push(w); });
        d.takte = this._stationNames.map((nm, i) => {
          const ws = byTakt[i + 1] || [];
          return {
            takt: i + 1, stationName: nm,
            orders: ws.length ? ws.map(w => w.order).join(", ") : "— " + this._rb.getText("free") + " —",
            order: ws.length ? ws[0].order : null,
            orderList: ws.map(w => w.order),
            jam: ws.length >= 2, free: ws.length === 0
          };
        });
        d.events = (d.events || []).map(t => ({ text: t }));
        this._m.setProperty("/live", d);
        this._wipByStation = cnt;                                   // fürs Diagramm + Stationsklick
        this._renderFlow(this._m.getProperty("/flow"), d.wip);      // Zickzack live mit WIP/Stau aktualisieren
      } catch (e) { /* transienter Fehler beim Pollen – nächster Tick versucht erneut */ }
    },

    // Copilot-Audit-Log laden (nur Supervisor darf lesen; Worker → 403 → leere Liste)
    _loadAudit: async function () {
      try {
        const rows = await fn("CopilotAudit?$orderby=createdAt desc&$top=15");
        if (!Array.isArray(rows)) { this._m.setProperty("/audit", []); return; }
        this._m.setProperty("/audit", rows.map(r => ({
          time: r.createdAt ? new Date(r.createdAt).toLocaleString(currentLang() === "en" ? "en-GB" : "de-DE") : "",
          role: this._rb.getText(r.role === "Supervisor" ? "roleMeister" : "roleMitarbeiter"),
          question: r.question || "",
          usedTool: r.usedTool || ""
        })));
      } catch (e) { this._m.setProperty("/audit", []); }
    },

    // --- Fertigungslinie als Zickzack-Flussdiagramm ------------------------
    _loadFlow: async function () {
      try {
        const flow = await fn("stationOverview()");
        this._m.setProperty("/flow", flow || []);
        this._renderFlow(flow || []);
      } catch (e) { /* Diagramm bleibt leer; der 5-s-Live-Tick rendert weiter */ }
    },

    _renderFlow: function (stations, wip) {
      const W = 156, H = 72, GAPX = 28;
      const TOPY = 10, MIDY = 104, BOTY = 128, totalH = BOTY + H + 10;   // obere Reihe · Mittellinie · untere Reihe
      const esc = t => String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const wipCount = {};
      (wip || []).forEach(w => { wipCount[w.stationNo] = (wipCount[w.stationNo] || 0) + 1; });
      const nodes = stations.map((s, i) => {
        const x = 14 + i * (W + GAPX);
        const top = (i % 2 === 0);             // Takte abwechselnd über/unter der Mittellinie
        return { s, x, y: top ? TOPY : BOTY, top, cx: x + W / 2 };
      });
      const totalW = 14 + stations.length * (W + GAPX);

      // Durchgehende Mittellinie (Förderband) + Stiel je Takt + Knotenpunkt auf der Linie
      let lines = `<line x1="14" y1="${MIDY}" x2="${totalW - 14}" y2="${MIDY}" stroke="#a9b0b8" stroke-width="3"/>`;
      for (const n of nodes) {
        const yBox = n.top ? (TOPY + H) : BOTY;   // Box-Kante Richtung Mittellinie
        lines += `<line x1="${n.cx}" y1="${MIDY}" x2="${n.cx}" y2="${yBox}" stroke="#a9b0b8" stroke-width="2"/>`
              + `<circle cx="${n.cx}" cy="${MIDY}" r="5" fill="#5b6b7b"/>`;
      }

      const boxes = nodes.map(({ s, x, y }) => {
        const issue  = s.issueCount > 0;
        const fill   = issue ? "#ffeaea" : (s.isBottleneck ? "#fff3e0" : "#eef7ee");
        const stroke = issue ? "#bb0000" : (s.isBottleneck ? "#e76500" : "#2b7d2b");
        const cyc = s.avgCycleSec != null ? `Ø ${fmt1(s.avgCycleSec / 60)} ${this._rb.getText("minUnit")}` : "—";
        const tag = s.isBottleneck ? " · " + this._rb.getText("bottleneckWord") : "";
        const nm  = esc(s.name.length > 24 ? s.name.slice(0, 23) + "…" : s.name);
        const badge = issue
          ? `<circle cx="${x + W - 15}" cy="${y + 15}" r="11" fill="#bb0000"/>`
            + `<text x="${x + W - 15}" y="${y + 19}" text-anchor="middle" font-size="12" font-weight="bold" fill="#fff">${s.issueCount}</text>`
          : "";
        // Live-WIP-Indikator unten rechts: blau = 1 Auftrag an der Station, orange = Stau (≥2)
        const n = wipCount[s.stationNo] || 0;
        const wipBadge = n > 0
          ? `<circle cx="${x + W - 16}" cy="${y + H - 15}" r="11" fill="${n >= 2 ? "#e76500" : "#0a6ed1"}"/>`
            + `<text x="${x + W - 16}" y="${y + H - 11}" text-anchor="middle" font-size="12" font-weight="bold" fill="#fff">${n}</text>`
          : "";
        return `<g data-st="${s.stationNo}" style="cursor:pointer">`
          + `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`
          + `<text x="${x + 12}" y="${y + 23}" font-size="13" font-weight="bold" fill="#1d2d3e">${this._rb.getText("takt")} ${s.stationNo}${tag}</text>`
          + `<text x="${x + 12}" y="${y + 42}" font-size="11" fill="#33414f">${nm}</text>`
          + `<text x="${x + 12}" y="${y + 60}" font-size="11" fill="#5b6b7b">${cyc}</text>`
          + badge + wipBadge + `</g>`;
      }).join("");

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" `
        + `style="font-family:Arial,Helvetica,sans-serif">${lines}${boxes}</svg>`;
      this.byId("flowDiagram").setContent(svg);
    },

    _selectStation: function (stationNo) {
      const s = (this._m.getProperty("/flow") || []).find(x => x.stationNo === stationNo);
      if (!s) return;
      const liveWip = (this._m.getProperty("/live/wip") || []).filter(w => w.stationNo === stationNo);
      const rb = this._rb;
      const info = `${s.kind} · ${s.avgCycleSec != null ? rb.getText("avgTaktTime", [fmt1(s.avgCycleSec / 60)]) : "—"}`
        + (s.isBottleneck ? " · " + rb.getText("lineBottleneck") : "");
      this._m.setProperty("/station", {
        selected: true,
        title: `${rb.getText("takt")} ${s.stationNo} – ${s.name}`,
        info,
        stationNo: stationNo,
        stationName: s.name,
        orders: liveWip.map(w => ({ order: w.order, jam: liveWip.length >= 2 })),
        rows: s.issues || [],
        bookings: []
      });
      // Buchungen am Takt laden – das Backend maskiert die Namen für Nicht-Meister
      fn(`taktBookings(stationNo=${stationNo})`).then(b => {
        this._m.setProperty("/station/bookings", b || []);
      }).catch(() => {});
    }
  });
});
