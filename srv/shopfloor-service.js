const cds = require('@sap/cds')
const { runCopilot, providerInfo, setProvider } = require('./lib/llm')

// =============================================================================
// Copilot-Rate-Limit: schützt den öffentlichen API-Pfad (Sonnet, Pay-per-Token)
// vor Missbrauch & unkontrollierten Kosten. In-Memory, pro App-Instanz.
// Standard: nur in der Cloud aktiv (VCAP_APPLICATION); lokal per COPILOT_RATE_ALWAYS=true.
// Alle Limits per cf set-env / .env überschreibbar.
//   COPILOT_RATE_WINDOW_S · COPILOT_RATE_PER_USER · COPILOT_RATE_GLOBAL · COPILOT_RATE_DAILY
// =============================================================================
const DEMO_PUBLIC = process.env.DEMO_PUBLIC === 'true'   // öffentlicher Standalone-Demo-Host (mocked auth, kein XSUAA)
const RL = {
  windowMs: Number(process.env.COPILOT_RATE_WINDOW_S || 60) * 1000,          // Burst-Fenster (global + je Login-User)
  perUser:  Number(process.env.COPILOT_RATE_PER_USER  || 5),                 // je eingeloggtem Nutzer pro Fenster (BTP)
  global:   Number(process.env.COPILOT_RATE_GLOBAL    || 30),                // gesamt pro Fenster
  daily:    Number(process.env.COPILOT_RATE_DAILY     || (DEMO_PUBLIC ? 150 : 500)),  // gesamt/Tag = harte Kosten-Obergrenze
  // Öffentliche Demo: pro Besucher-IP begrenzt (NICHT pro Login — sonst per Cookie/Rolle/Logout umgehbar).
  perIp:      Number(process.env.COPILOT_RATE_PER_IP      || 10),
  ipWindowMs: Number(process.env.COPILOT_RATE_IP_WINDOW_H || 24) * 3600000,
}
const _rlHits = new Map()          // key -> [timestamps im jeweiligen Fenster]
let _rlDayStart = Date.now(), _rlDayCount = 0
// Hygiene: Keys entfernen, deren letzter Treffer älter als das größte Fenster ist —
// sonst wächst die Map um einen Eintrag pro jemals gesehener Besucher-IP (24/7-Demo).
const _rlSweep = setInterval(() => {
  const now = Date.now(), maxWin = Math.max(RL.windowMs, RL.ipWindowMs)
  for (const [k, arr] of _rlHits) {
    if (!arr.length || now - arr[arr.length - 1] > maxWin) _rlHits.delete(k)
  }
}, 3600000)
if (_rlSweep.unref) _rlSweep.unref()
// Prüft: Tageskappe (harte Kosten-Obergrenze) + globaler Burst + das Schlüssel-Limit
// (Login-User pro windowMs ODER Besucher-IP pro ipWindowMs).
function copilotRateLimit(key, keyLimit, keyWindowMs) {
  const now = Date.now()
  if (now - _rlDayStart > 86400000) { _rlDayStart = now; _rlDayCount = 0 }   // Tagesreset
  if (_rlDayCount >= RL.daily)
    return { ok: false, msg: `Das Tageslimit für Copilot-Anfragen ist erreicht (${RL.daily}). Bitte morgen erneut.` }
  const win = (k, cutoff) => (_rlHits.get(k) || []).filter(t => t > cutoff)
  const g = win('__global__', now - RL.windowMs)
  if (g.length >= RL.global)
    return { ok: false, msg: `Der Copilot ist gerade stark ausgelastet. Bitte in ${Math.ceil(RL.windowMs / 1000)}s erneut versuchen.` }
  const u = win(key, now - keyWindowMs)
  if (u.length >= keyLimit)
    return { ok: false, msg: keyWindowMs >= 3600000
      ? `Du hast dein Demo-Kontingent von ${keyLimit} Copilot-Fragen aufgebraucht. Schau später gern wieder rein.`
      : `Zu viele Anfragen – max. ${keyLimit} pro ${Math.ceil(keyWindowMs / 1000)}s. Bitte kurz warten.` }
  g.push(now); _rlHits.set('__global__', g)
  u.push(now); _rlHits.set(key, u)
  _rlDayCount++
  return { ok: true }
}
// Besucher-IP aus dem HTTP-Request. Hinter Cloud Run/Proxy steht sie in x-forwarded-for (erster Eintrag).
function clientIp(req) {
  const h = (req.http && req.http.req && req.http.req.headers) || {}
  const xff = h['x-forwarded-for']
  if (xff) return String(xff).split(',')[0].trim()
  const r = req.http && req.http.req
  return (r && (r.ip || (r.socket && r.socket.remoteAddress))) || 'unknown'
}
// UI-Sprache aus dem Request: die Fiori-App schickt Accept-Language mit, CAP mappt das auf req.locale.
// Alles außer Englisch fällt auf Deutsch zurück (Fallback-Sprache der App).
function langOf(req) {
  return String((req && req.locale) || 'de').toLowerCase().startsWith('en') ? 'en' : 'de'
}

module.exports = cds.service.impl(async function () {
  const {
    ProductionOrders, Confirmations, TestMeasurements,
    InstalledParts, Materials, Stations, IssueHistory, CopilotAudit
  } = this.entities

  // =========================================================================
  // Deterministische Analyse-Tools  (DB-gestützt, kein LLM)
  // Diese Funktionen sind sowohl OData-Endpunkte ALS AUCH die "Tools",
  // die der Copilot per Function Calling aufruft.
  // =========================================================================

  /** Engpass der Linie: Ø Taktzeit je Station. */
  async function bottleneck(lang = 'de') {
    const confs    = await SELECT.from(Confirmations).columns('station_ID', 'cycleTimeSec')
    const stations = await SELECT.from(Stations)
    const sMap = Object.fromEntries(stations.map(s => [s.ID, s]))
    const agg = {}
    for (const c of confs) {
      if (c.cycleTimeSec == null) continue
      const a = agg[c.station_ID] || (agg[c.station_ID] = { sum: 0, n: 0 })
      a.sum += c.cycleTimeSec; a.n++
    }
    return Object.entries(agg)
      .map(([id, v]) => ({
        stationNo: sMap[id]?.stationNo, name: stationName(lang, sMap[id]?.stationNo, sMap[id]?.name),
        avgCycleSec: +(v.sum / v.n).toFixed(1), samples: v.n
      }))
      .sort((a, b) => b.avgCycleSec - a.avgCycleSec)
  }

  // Gehärtete bottleneck-Variante FÜR DEN COPILOT: nimmt dem LLM Sortierung, Argmax und
  // Sekunden→Minuten-Umrechnung ab (kleine lokale Modelle wählen sonst die falsche Zeile).
  // OData-Function `bottleneck()` + Frontend nutzen weiter das rohe Array oben.
  const ZIELTAKT_MIN = 26
  async function bottleneckInsight(lang = 'de') {
    const rows = await bottleneck(lang)   // bereits absteigend nach avgCycleSec sortiert
    const takte = rows.map((r, i) => ({
      rang: i + 1,
      takt: r.stationNo,
      station: r.name,
      avgCycleMin: +(r.avgCycleSec / 60).toFixed(1),
      ueberZiel: (r.avgCycleSec / 60) > ZIELTAKT_MIN
    }))
    const top = takte[0]
    return {
      engpass: top ? { takt: top.takt, station: top.station, avgCycleMin: top.avgCycleMin } : null,
      zieltaktMin: ZIELTAKT_MIN,
      hinweis: top
        ? `Engpass = Takt ${top.takt} (${top.station}) mit Ø ${top.avgCycleMin} min, Zieltakt ${ZIELTAKT_MIN} min. `
          + `Die Liste 'takte' ist bereits absteigend nach Taktzeit sortiert: Rang 1 = langsamster Takt. `
          + `Nimm für "welcher Takt dauert am längsten / Engpass" IMMER 'engpass' bzw. Rang 1 – NICHT die höchste Takt-Nummer.`
        : 'Keine Taktzeiten vorhanden.',
      takte
    }
  }

  /** Durchfaller je Messgröße. */
  async function failureSummary() {
    const fails = await SELECT.from(TestMeasurements).where({ passed: false })
    const m = {}
    for (const f of fails) m[f.measureType] = (m[f.measureType] || 0) + 1
    return Object.entries(m)
      .map(([measureType, fails]) => ({ measureType, fails }))
      .sort((a, b) => b.fails - a.fails)
  }

  // Gehärtete failureSummary-Variante FÜR DEN COPILOT (Muster wie bottleneckInsight):
  // fertiges 'haeufigster'-Feld + Klartext-Hinweis, damit kleine Modelle nicht selbst
  // die häufigste Durchfall-Ursache heraussuchen müssen. OData/Frontend nutzen das rohe Array.
  async function failureSummaryInsight() {
    const rows = await failureSummary()   // [{measureType, fails}], bereits absteigend
    const top = rows[0]
    return {
      haeufigster: top ? { measureType: top.measureType, fails: top.fails } : null,
      hinweis: top
        ? `Häufigster Durchfaller = ${top.measureType} mit ${top.fails} Fällen. `
          + `Die Liste 'nachMessgroesse' ist absteigend sortiert (Rang 1 = häufigste Ursache). `
          + `Für "welche Messgröße fällt am häufigsten durch" IMMER 'haeufigster' bzw. Rang 1 nehmen.`
        : 'Keine Durchfaller vorhanden.',
      nachMessgroesse: rows.map((r, i) => ({ rang: i + 1, measureType: r.measureType, fails: r.fails }))
    }
  }

  /** Phasenasymmetrie der Stromaufnahme (L1/L2/L3), Spread >= Schwelle. */
  async function currentAsymmetry(thresholdA = 1.5) {
    const cur = await SELECT.from(TestMeasurements)
      .where({ measureType: { in: ['CURRENT_L1', 'CURRENT_L2', 'CURRENT_L3'] } })
    const orderNo = Object.fromEntries(
      (await SELECT.from(ProductionOrders).columns('ID', 'orderNo')).map(o => [o.ID, o.orderNo])
    )
    const byOrder = {}
    for (const r of cur) {
      const o = byOrder[r.order_ID] || (byOrder[r.order_ID] = {})
      o[r.measureType] = parseFloat(r.value)
    }
    const out = []
    for (const [oid, ph] of Object.entries(byOrder)) {
      const vals = [ph.CURRENT_L1, ph.CURRENT_L2, ph.CURRENT_L3].filter(v => v != null)
      if (vals.length < 3) continue
      const spread = Math.max(...vals) - Math.min(...vals)
      if (spread >= thresholdA) out.push({
        orderNo: orderNo[oid], l1: ph.CURRENT_L1, l2: ph.CURRENT_L2, l3: ph.CURRENT_L3,
        spreadA: +spread.toFixed(2)
      })
    }
    return out.sort((a, b) => b.spreadA - a.spreadA)
  }

  /**
   * Wurzelursachen-Analyse: Welche Aufträge sind bei dieser Messung durchgefallen,
   * und teilen sie einen gemeinsamen Faktor (z.B. dieselbe Charge)?
   * Das ist die "Detektivarbeit", die sonst Stunden manueller Suche kostet.
   */
  // Nutzer-sichtbare rootCause-Texte DE/EN (Sprache kommt via Accept-Language -> req.locale).
  const RC_TXT = {
    de: {
      noFails: 'Keine Durchfaller für diese Messung.',
      charge: b => `Charge ${b}`,
      chargeHyp: (n, total, shared) => `${n} von ${total} Durchfallern teilen ${shared}. `
        + `Verdacht: chargenbezogener Zulieferer-/Vorfertigungsfehler. Charge sperren und prüfen.`,
      noCharge: 'keine dominante Charge',
      noChargeHyp: 'Durchfaller verteilen sich über mehrere Chargen/Stationen. '
        + 'Verdacht: Montagefehler oder nicht rückverfolgtes Kanban-Teil (Blindstelle).'
    },
    en: {
      noFails: 'No failed units for this measurement.',
      charge: b => `Batch ${b}`,
      chargeHyp: (n, total, shared) => `${n} of ${total} failed units share ${shared}. `
        + `Suspected batch-related supplier/prefabrication defect. Block and inspect the batch.`,
      noCharge: 'no dominant batch',
      noChargeHyp: 'Failures are spread across several batches/stations. '
        + 'Suspected assembly error or an untracked kanban part (blind spot).'
    }
  }
  async function rootCause(measureType, lang = 'de') {
    const T = RC_TXT[lang]
    const fails = await SELECT.from(TestMeasurements).where({ measureType, passed: false })
    const failIds = [...new Set(fails.map(f => f.order_ID))]
    if (!failIds.length)
      return { measureType, failingOrders: 0, hypothesis: T.noFails, sharedFactor: '' }

    const parts = await SELECT.from(InstalledParts).where({ order_ID: { in: failIds } })
    const batchCount = {}
    for (const p of parts) if (p.batchNo) batchCount[p.batchNo] = (batchCount[p.batchNo] || 0) + 1
    const top = Object.entries(batchCount).sort((a, b) => b[1] - a[1])[0]

    if (top && top[1] >= Math.ceil(failIds.length * 0.6)) {
      const shared = T.charge(top[0])
      return {
        measureType, failingOrders: failIds.length, sharedFactor: shared,
        hypothesis: T.chargeHyp(top[1], failIds.length, shared)
      }
    }
    return {
      measureType, failingOrders: failIds.length, sharedFactor: T.noCharge,
      hypothesis: T.noChargeHyp
    }
  }

  // Freitext/Umgangssprache -> konkrete Messgröße. Kleine lokale Modelle mappen
  // "Stromaufnahme" nicht zuverlässig auf CURRENT_L2 und wählen mal das falsche Tool.
  function mapMeasureType(input) {
    const s = String(input || '').toLowerCase()
    if (/strom|phase|asymmetr|current|ampere|l1|l2|l3/.test(s)) return 'CURRENT_L2'
    if (/dicht|leck|leak/.test(s))                              return 'LEAKAGE'
    if (/prüf|pruef|first|erstlauf|probelauf|funktion/.test(s)) return 'FIRST_RUN'
    return input   // vermutlich schon eine konkrete Messgröße
  }

  // Gehärtete rootCause-Variante FÜR DEN COPILOT: mappt Freitext auf die Messgröße,
  // fällt bei Unbekanntem auf die häufigste Durchfall-Messgröße zurück, und macht den
  // Charge-Befund explizit ("nenne diese Charge"). Behebt qwens instabile Tool-/Param-Wahl.
  async function rootCauseInsight(input, lang = 'de') {
    let mt = mapMeasureType(input)
    const exists = await SELECT.one.from(TestMeasurements).where({ measureType: mt })
    if (!exists) { const fs = await failureSummary(); mt = fs[0]?.measureType || mt }
    const rc = await rootCause(mt, lang)
    const hasCharge = typeof rc.sharedFactor === 'string' && /^(Charge|Batch) /.test(rc.sharedFactor)
    return {
      ...rc,
      hinweis: hasCharge
        ? `Wurzelursache für ${mt}: ${rc.sharedFactor}. ${rc.hypothesis} Nenne diese Charge in der Antwort.`
        : rc.hypothesis
    }
  }

  // Gehärtete currentAsymmetry-Variante FÜR DEN COPILOT: liefert zusätzlich die dominante
  // Charge (aus rootCause), damit die Charge auch dann genannt wird, wenn das Modell bei
  // "Stromaufnahme" dieses Tool statt rootCause wählt.
  async function currentAsymmetryInsight(thresholdA = 1.5, lang = 'de') {
    const rows = await currentAsymmetry(thresholdA)
    const rc = await rootCause('CURRENT_L2', lang)
    const hasCharge = typeof rc.sharedFactor === 'string' && /^(Charge|Batch) /.test(rc.sharedFactor)
    return {
      auffaelligeAuftraege: rows,
      charge: hasCharge ? rc.sharedFactor : RC_TXT[lang].noCharge,
      hinweis: hasCharge
        ? `${rows.length} Aufträge mit Phasenasymmetrie. Gemeinsame Ursache: ${rc.sharedFactor} (${rc.hypothesis}). Nenne diese Charge.`
        : `${rows.length} Aufträge mit Phasenasymmetrie; keine dominante Charge erkennbar.`
    }
  }

  /** Stille Konfigurationsfehler: Ventil-Druckstufe und Markt-Anschlussvariante. */
  async function configMismatches(lang = 'de') {
    const kindValve  = lang === 'en' ? 'Valve pressure rating'       : 'Ventil-Druckstufe'
    const kindMarket = lang === 'en' ? 'Connection market variant'   : 'Anschluss-Marktvariante'
    const orders   = await SELECT.from(ProductionOrders)
    const oMap     = Object.fromEntries(orders.map(o => [o.ID, o]))
    const parts    = await SELECT.from(InstalledParts)
    const mats     = Object.fromEntries((await SELECT.from(Materials)).map(m => [m.ID, m]))
    const stNo     = Object.fromEntries((await SELECT.from(Stations)).map(s => [s.ID, s.stationNo]))
    const out = []
    for (const p of parts) {
      const o = oMap[p.order_ID], mat = mats[p.material_ID]
      if (!o || !mat || !p.installedSpec) continue
      if (mat.partNo.startsWith('V-') && o.requiredValveSpec && p.installedSpec !== o.requiredValveSpec)
        out.push({ orderNo: o.orderNo, kind: kindValve, required: o.requiredValveSpec, installed: p.installedSpec, station: stNo[p.station_ID] })
      if (mat.partNo.startsWith('AN-') && o.destinationMarket && p.installedSpec !== o.destinationMarket)
        out.push({ orderNo: o.orderNo, kind: kindMarket, required: o.destinationMarket, installed: p.installedSpec, station: stNo[p.station_ID] })
    }
    return out
  }

  /** Lagerbestand je Teil mit Status OK/KNAPP/LEER (Meldebestand-Abgleich). Werker-tauglich. */
  async function stockLevels() {
    const mats = await SELECT.from(Materials)
    const rank = { LEER: 0, KNAPP: 1, OK: 2 }
    return mats
      .map(m => {
        const qty = m.stockQty ?? 0, rop = m.reorderPoint ?? 0
        const status = qty === 0 ? 'LEER' : (qty <= rop ? 'KNAPP' : 'OK')
        return { partNo: m.partNo, description: m.description, stockQty: qty, reorderPoint: rop, status }
      })
      .sort((a, b) => rank[a.status] - rank[b.status] || a.partNo.localeCompare(b.partNo))
  }

  /** Häufigste Nacharbeiten/Montagefehler, aggregiert (ohne Auftrags-/Chargendetails). Werker-tauglich. */
  async function repairSummary() {
    const reps = await SELECT.from('shopfloor.Repairs')
    const m = {}
    for (const r of reps) {
      // Kurz-Kategorie = Text vor dem ersten " - " (lässt sensible Detail-Hälfte weg)
      const key = (r.description || r.kind || 'Sonstige').split(/\s[-–]\s/)[0].trim()
      m[key] = (m[key] || 0) + 1
    }
    return Object.entries(m).map(([issue, count]) => ({ issue, count })).sort((a, b) => b.count - a.count)
  }

  // Kuratierter Fehlerkatalog je Takt (Erfahrungswissen aus der Linie) – erweiterbar.
  // Erscheint im Takt-Detail zusätzlich zur datengetriebenen Charge-/Konfig-Erkennung.
  const TAKT_FEHLER = {
    de: {
      3: [
        { kat: 'Crimpung',    text: 'Crimpfehler an den Leistungskabeln (große Querschnitte, manuell gecrimpt) – Klemme sitzt nicht sicher, unsicherer Phasenkontakt' },
        { kat: 'Verdrahtung', text: 'Drei Phasen L1/L2/L3 vertauscht angeschlossen – falsches Drehfeld / Drehrichtung' },
        { kat: 'Vormontage',  text: 'Leitungen aus der Vormontage zu kurz geliefert – Kabelbaum-Vorfertigung prüfen' }
      ],
      5: [
        { kat: 'Abdichtung', text: 'Ölauge/Schauglas in den Ölabscheider geschraubt, mit Teflonband gedichtet – zu wenig Teflon oder nicht fest genug eingedreht → Leckage bei der Dichtheitsprüfung' }
      ],
      7: [
        { kat: 'Montage', text: 'Rohrverschraubungen zu fest oder zu locker angezogen – Dichtgummi dabei eingeklemmt/beschädigt → Undichtigkeit' },
        { kat: 'Montage', text: 'Rohrverschraubung vergessen richtig anzuziehen → Leckage bei der Dichtheitsprüfung' }
      ]
    },
    en: {
      3: [
        { kat: 'Crimping',     text: 'Crimp defects on the power cables (large cross-sections, crimped manually) – terminal not seated firmly, unreliable phase contact' },
        { kat: 'Wiring',       text: 'Three phases L1/L2/L3 connected in the wrong order – wrong rotating field / direction of rotation' },
        { kat: 'Pre-assembly', text: 'Cables delivered too short by pre-assembly – check wiring-harness prefabrication' }
      ],
      5: [
        { kat: 'Sealing', text: 'Oil sight glass screwed into the oil separator, sealed with PTFE tape – too little tape or not screwed in tightly enough → leak during the leak test' }
      ],
      7: [
        { kat: 'Assembly', text: 'Pipe fittings over- or under-tightened – sealing rubber pinched/damaged → leakage' },
        { kat: 'Assembly', text: 'Pipe fitting not tightened properly → leak during the leak test' }
      ]
    }
  }

  /**
   * Stationsübersicht fürs Flussdiagramm: Ø Taktzeit, Engpass-Flag und die
   * konkreten Fehler/Auffälligkeiten je Station — stille Konfig-Fehler
   * (Ventil/Anschluss) und auffällige Zulieferchargen (über Durchfaller erkannt).
   */
  // Nutzer-sichtbare stationOverview-Texte DE/EN (Kategorie-Labels + Aggregat-Texte).
  const SO_TXT = {
    de: {
      katCfg: 'Konfiguration', katBatch: 'Charge',
      wrongValve: 'Falsches Ventil', wrongMarket: 'Falsche Markt-Anschlussvariante',
      cfg:   (typ, soll, ist, n, sample) => `${typ}: Soll ${soll}, verbaut ${ist} – ${n} Aufträge (${sample})`,
      batch: (no, fail, total) => `Auffällige Charge ${no}: ${fail} von ${total} verbauten Teilen in Durchfallern → Charge prüfen/sperren`
    },
    en: {
      katCfg: 'Configuration', katBatch: 'Batch',
      wrongValve: 'Wrong valve', wrongMarket: 'Wrong market connection variant',
      cfg:   (typ, soll, ist, n, sample) => `${typ}: target ${soll}, installed ${ist} – ${n} orders (${sample})`,
      batch: (no, fail, total) => `Suspicious batch ${no}: ${fail} of ${total} installed parts in failed units → inspect/block the batch`
    }
  }
  async function stationOverview(isSupervisor, lang = 'de') {
    const T = SO_TXT[lang]
    // nach stationNo sortiert -> Engpass-Gleichstand fällt auf die niedrigere Station (konsistent mit der KPI-Kachel)
    const stations = (await SELECT.from(Stations)).sort((a, b) => a.stationNo - b.stationNo)
    const confs    = await SELECT.from(Confirmations).columns('station_ID', 'cycleTimeSec')
    const parts    = await SELECT.from(InstalledParts)
    const orders   = await SELECT.from(ProductionOrders)
    const oMap     = Object.fromEntries(orders.map(o => [o.ID, o]))
    const mats     = Object.fromEntries((await SELECT.from(Materials)).map(m => [m.ID, m]))
    const fails    = await SELECT.from(TestMeasurements).where({ passed: false })
    const failOrders = new Set(fails.map(f => f.order_ID))

    // Ø Taktzeit je Station + Engpass (langsamste Station)
    const cyc = {}
    for (const c of confs) {
      if (c.cycleTimeSec == null) continue
      const a = cyc[c.station_ID] || (cyc[c.station_ID] = { sum: 0, n: 0 })
      a.sum += c.cycleTimeSec; a.n++
    }
    let slowest = null, slowAvg = -1
    for (const s of stations) {   // stations sind nach stationNo aufsteigend sortiert
      const a = cyc[s.ID]; if (!a) continue
      const avg = +(a.sum / a.n).toFixed(1)   // gerundet wie bottleneck()/KPI-Kachel -> Gleichstand fällt auf niedrigere Station
      if (avg > slowAvg) { slowAvg = avg; slowest = s.ID }
    }

    // Fehler/Auffälligkeiten je Station ({ katKey, kat, text }) — katKey ist der STABILE
    // interne Schlüssel für den Governance-Filter (kat ist nur das übersetzte Anzeige-Label;
    // würde auf kat gefiltert, griffe der Filter auf Englisch nicht mehr -> Charge-Leak).
    const issues = {}
    const add = (sid, katKey, kat, text) => { (issues[sid] || (issues[sid] = [])).push({ katKey, kat, text }) }

    // 1) Stille Konfigurationsfehler je Station + Typ ZUSAMMENGEFASST (nicht je Auftrag einzeln)
    const cfgAgg = {}   // sid|typ -> { sid, typ, soll, ist, orders:[] }
    for (const p of parts) {
      const o = oMap[p.order_ID], mat = mats[p.material_ID]
      if (!o || !mat || !p.installedSpec) continue
      let typ, soll
      if (mat.partNo.startsWith('V-') && o.requiredValveSpec && p.installedSpec !== o.requiredValveSpec) {
        typ = T.wrongValve; soll = o.requiredValveSpec
      } else if (mat.partNo.startsWith('AN-') && o.destinationMarket && p.installedSpec !== o.destinationMarket) {
        typ = T.wrongMarket; soll = o.destinationMarket
      } else continue
      const key = `${p.station_ID}|${typ}`
      const ag = cfgAgg[key] || (cfgAgg[key] = { sid: p.station_ID, typ, soll, ist: p.installedSpec, orders: [] })
      ag.orders.push(o.orderNo)
    }
    for (const k in cfgAgg) {
      const ag = cfgAgg[k]
      const sample = ag.orders.slice(0, 4).join(', ') + (ag.orders.length > 4 ? ` …+${ag.orders.length - 4}` : '')
      add(ag.sid, 'config', T.katCfg, T.cfg(ag.typ, ag.soll, ag.ist, ag.orders.length, sample))
    }

    // 2) Auffällige Chargen: Charge, die überproportional in Durchfallern steckt
    const batch = {}
    for (const p of parts) {
      if (!p.batchNo) continue
      const key = `${p.station_ID}|${p.batchNo}`
      const a = batch[key] || (batch[key] = { sid: p.station_ID, no: p.batchNo, fail: 0, total: 0 })
      a.total++
      if (failOrders.has(p.order_ID)) a.fail++
    }
    for (const k in batch) {
      const a = batch[k]
      if (a.fail >= 3 && a.fail >= Math.ceil(a.total * 0.6))
        add(a.sid, 'batch', T.katBatch, T.batch(a.no, a.fail, a.total))
    }

    return stations
      .map(s => {
        const a = cyc[s.ID]
        let list = (issues[s.ID] || []).concat(TAKT_FEHLER[lang][s.stationNo] || [])
        // Governance: forensische Kategorien (stille Konfig-Fehler mit Auftragsnummern,
        // auffällige Chargen) nur für Meister – sonst wäre taktInfo/UI ein Umweg an
        // Meister-Daten (rootCause/configMismatches sind @requires:'Supervisor').
        // Filter auf dem sprachunabhängigen katKey, NICHT auf dem übersetzten Label!
        if (!isSupervisor) list = list.filter(i => i.katKey !== 'config' && i.katKey !== 'batch')
        return {
          stationNo: s.stationNo, name: stationName(lang, s.stationNo, s.name), kind: s.kind,
          avgCycleSec: a ? +(a.sum / a.n).toFixed(1) : null,
          samples: a ? a.n : 0,
          isBottleneck: s.ID === slowest,
          issueCount: list.length,
          issues: list.map(({ kat, text }) => ({ kat, text }))   // katKey bleibt intern
        }
      })
      .sort((x, y) => x.stationNo - y.stationNo)
  }

  // =========================================================================
  // Live-Schicht-Simulation (rein in-memory, beschleunigte Zeit) – lässt die
  // Linie "laufen", ohne die Demo-Fehlerszenarien in der DB zu verändern.
  // =========================================================================
  const ST_NAMES = {
    de: [
      'Grundplatte + Motormontage', 'Schaltschrankmontage', 'Elektromontage Motorleistungen',
      'Lüftergehäuse + Lüftermotor', 'Ölabscheider + Sicherheitsventil', 'Elektromontage Sensoren/Bedienpult',
      'Verrohrung', 'Gehäuse + verkleben', 'Inline-Prüfung'
    ],
    en: [
      'Base plate + motor assembly', 'Control cabinet assembly', 'Electrical assembly – motor power',
      'Fan housing + fan motor', 'Oil separator + safety valve', 'Electrical assembly – sensors/control panel',
      'Piping', 'Housing + bonding', 'Inline test'
    ]
  }
  // Stationsname in der UI-Sprache (die DB-Stammdaten sind deutsch; EN kommt aus ST_NAMES.en)
  const stationName = (lang, no, fallback) =>
    (ST_NAMES[lang] && ST_NAMES[lang][no - 1]) || fallback || `Station ${no}`
  const TAKT_MIN = 26, SHIFT_TARGET = 16   // realer Zieltakt ~26 min, ~16 Stück/Schicht (lt. Case Study)
  const N_STATIONS = 9
  const SHIFT_LEN = 7 * 60                  // 7 h je Schicht (Früh 06–13, Spät 13–20)
  // Stations-Schwankung in Prozent: Chance, dass ein Schritt einen Takt länger dauert
  // (St.3/6/7 = leichter Engpass, deckt sich mit den Ø-Taktzeiten der Confirmations).
  const EXTRA_TAKT = { 1: 12, 2: 12, 3: 40, 4: 12, 5: 12, 6: 22, 7: 22, 8: 12, 9: 12 }
  const BUFFER = 2, LINE_CAP = 10
  // Der Live-Monitor ist eine REINE FUNKTION DER ZEIT: zu jeder Master-Zeit wird der
  // Linienzustand deterministisch berechnet (gleiche Zeit -> gleicher Stand). Die Echtzeit-
  // Linie läuft als Master mit der Systemzeit; Demo ist dieselbe Linie in beschleunigter Zeit.
  const sim = { mode: 'demo', virtualMin: 0 }

  const SHIFT_TXT = {
    de: { EARLY: 'Frühschicht · 06:00–13:00', LATE: 'Spätschicht · 13:00–20:00', NIGHT: 'Nachtschicht · 20:00–06:00', end: ' (Schichtende)' },
    en: { EARLY: 'Early shift · 06:00–13:00', LATE: 'Late shift · 13:00–20:00', NIGHT: 'Night shift · 20:00–06:00', end: ' (end of shift)' }
  }
  function shiftOf(h, lang = 'de') {
    const key = (h >= 6 && h < 13) ? 'EARLY' : (h >= 13 && h < 20) ? 'LATE' : 'NIGHT'
    return { key, label: SHIFT_TXT[lang][key] }
  }
  // Master-Zeit = Minuten seit 06:00 (Demo: beschleunigt; Echtzeit: Systemzeit, auf Früh+Spät begrenzt).
  function masterMin() {
    if (sim.mode === 'demo') return sim.virtualMin
    const now = new Date()
    let m = (now.getHours() - 6) * 60 + now.getMinutes()
    if (m < 0) m += 24 * 60
    return Math.max(0, Math.min(2 * SHIFT_LEN, m))
  }
  // Uhrzeit + Schicht zu einer Minute-seit-06:00.
  function clockShift(minSince06, lang = 'de') {
    const total = 6 * 60 + minSince06
    const hh = Math.floor(total / 60) % 24, mm = Math.floor(total) % 60
    const sh = shiftOf(hh, lang)
    return { clock: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, shiftKey: sh.key, shiftLabel: sh.label }
  }
  // Deterministischer Hash -> reproduzierbare Schwankung (statt Zufall, sonst kein "Master").
  function hash32(str) {
    let h = 2166136261
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
    return h >>> 0
  }
  const stepDur = (k, st) => 1 + ((hash32(k + '-' + st) % 100) < (EXTRA_TAKT[st] || 12) ? 1 : 0)
  // Minuten-Versatz innerhalb des Takts (0..TAKT_MIN-1), damit Buchungen gestaffelte Uhrzeiten bekommen
  const taktOffset = (k, st) => hash32('off' + k + '-' + st) % TAKT_MIN

  // Linienzustand nach `targetTakt` Takten – deterministisch, von eingeschwungen voller Linie aus.
  let _lineCache = { takt: -1, result: null }
  function computeLine(targetTakt) {
    if (targetTakt === _lineCache.takt) return _lineCache.result
    const countAt = (arr, st) => arr.filter(o => o.st === st).length
    let orders = [], completed = [], taktLog = [], nextK = 0
    // Startbestand: Linie eingeschwungen besetzt (k=0..8 an St.9..1, wie Schichtübergabe)
    for (let s = N_STATIONS; s >= 1; s--) { orders.push({ k: nextK, st: s, remain: stepDur(nextK, s) }); nextK++ }
    for (let t = 0; t <= targetTakt; t++) {
      // 1) Arbeit: vorderster Auftrag je Station macht einen Takt
      const byst = {}
      for (const o of orders) (byst[o.st] || (byst[o.st] = [])).push(o)
      for (const s in byst) { byst[s].sort((a, b) => a.k - b.k); if (byst[s][0].remain > 0) byst[s][0].remain-- }
      // 2) Fertig gebucht -> weiterschieben (vorne zuerst), wenn die Folgestation Platz hat.
      //    Jeder Takt-Abschluss wird protokolliert (Historie der Taktlinie).
      for (const o of [...orders].sort((a, b) => b.st - a.st || a.k - b.k)) {
        if (o.remain > 0) continue
        if (o.st >= N_STATIONS) { o.done = true; completed.push({ k: o.k, finishTakt: t }); taktLog.push({ k: o.k, takt: N_STATIONS, finishMin: t * TAKT_MIN + taktOffset(o.k, N_STATIONS) }); continue }
        if (countAt(orders, o.st + 1) < BUFFER) { taktLog.push({ k: o.k, takt: o.st, finishMin: t * TAKT_MIN + taktOffset(o.k, o.st) }); o.st++; o.remain = stepDur(o.k, o.st) }
      }
      orders = orders.filter(o => !o.done)
      // 3) Neuen Auftrag einlasten, wenn Station 1 Platz hat
      if (orders.length < LINE_CAP && countAt(orders, 1) < BUFFER) {
        orders.push({ k: nextK, st: 1, remain: stepDur(nextK, 1) }); nextK++
      }
    }
    _lineCache = { takt: targetTakt, result: { wip: orders, completed, taktLog } }
    return _lineCache.result
  }

  // Timer treibt nur die Demo-Uhr; Echtzeit braucht keinen Timer (alles aus der Systemzeit berechnet).
  function onTimer() {
    if (sim.mode === 'demo') {
      sim.virtualMin += TAKT_MIN
      if (sim.virtualMin >= 2 * SHIFT_LEN) sim.virtualMin = 0   // nach Spätschicht (20:00) neue Runde
    }
  }
  const _t = setInterval(onTimer, 30000); if (_t.unref) _t.unref()

  // Echte DB-Aufträge (ORD-5xxx) lazy laden – die Live-Linie lässt sie zyklisch durchlaufen,
  // damit Live-Position und Diagnose/Fehler denselben Auftrag betreffen.
  let DB_ORDERS = null
  async function ensureOrders() {
    if (!DB_ORDERS) {
      const rows = await SELECT.from(ProductionOrders).columns('orderNo').orderBy('orderNo')
      DB_ORDERS = rows.map(r => r.orderNo)
    }
    return DB_ORDERS
  }
  const orderForK = k => (DB_ORDERS && DB_ORDERS.length) ? DB_ORDERS[k % DB_ORDERS.length] : `ORD-${5000 + k}`

  async function liveStatus(lang = 'de') {
    await ensureOrders()
    const mm = masterMin()
    let info = clockShift(mm, lang)
    // Nachts läuft die Linie nicht (Schichten: Früh 06–13 + Spät 13–20). Statt einer leeren
    // "Nachtschicht" den eingefrorenen End-Stand der Spätschicht zeigen — bis die Frühschicht
    // um 06:00 startet. (Der Linien-Stand ist über masterMin bereits auf 20:00 geklemmt.)
    if (info.shiftKey === 'NIGHT') info = { clock: '20:00', shiftKey: 'LATE', shiftLabel: SHIFT_TXT[lang].LATE + SHIFT_TXT[lang].end }
    const { wip, completed, taktLog } = computeLine(Math.floor(mm / TAKT_MIN))
    // Stück (Schicht) = tatsächlich in der laufenden Schicht fertiggestellte Aufträge
    const unitsThisShift = completed.filter(c => clockShift(c.finishTakt * TAKT_MIN).shiftKey === info.shiftKey).length
    // Ereignis-Ticker = Historie der Takt-Abschlüsse (wann welcher Auftrag welchen Takt fertig gebucht hat)
    const ticker = taktLog
      .filter(e => e.finishMin <= mm)                       // nur bereits vergangene Buchungen
      .sort((a, b) => a.finishMin - b.finishMin)
      .slice(-8).reverse()
      .map(e => {
        const clk = clockShift(e.finishMin).clock
        if (e.takt >= N_STATIONS) return lang === 'en'
          ? `✓ ${orderForK(e.k)} completed – Takt ${e.takt} passed (${clk})`
          : `✓ ${orderForK(e.k)} fertiggestellt – Takt ${e.takt} bestanden (${clk})`
        return lang === 'en'
          ? `${orderForK(e.k)} – Takt ${e.takt} booked as done (${clk})`
          : `${orderForK(e.k)} – Takt ${e.takt} fertig gebucht (${clk})`
      })
    return {
      shift: info.shiftKey, shiftLabel: info.shiftLabel, shiftShort: info.shiftLabel.split(' · ')[0],
      plant: lang === 'en' ? 'Plant 1000' : 'Werk 1000', line: lang === 'en' ? 'Line BK-1' : 'Linie BK-1',
      clock: info.clock, mode: sim.mode,
      unitsThisShift, taktMin: TAKT_MIN, shiftTarget: SHIFT_TARGET, wipCount: wip.length,
      wip: wip.slice().sort((a, b) => a.st - b.st).map(o => ({
        order: orderForK(o.k),
        stationNo: o.st, stationName: stationName(lang, o.st)
      })),
      events: ticker
    }
  }

  // Mitarbeiter-Stammdaten (Personalnummer + Name) zu den Buchungs-Kennungen.
  const EMPLOYEES = {
    W01: { name: 'Anna Berg',   pernr: '10042301' }, W02: { name: 'Bernd Klein',  pernr: '10042302' },
    W03: { name: 'Cem Yılmaz',  pernr: '10042303' }, W04: { name: 'Dana Roth',    pernr: '10042304' },
    W05: { name: 'Erik Sommer', pernr: '10042305' }, W06: { name: 'Frank Huber',  pernr: '10042306' },
    W07: { name: 'Greta Lang',  pernr: '10042307' }, W08: { name: 'Hakan Demir',  pernr: '10042308' },
    W09: { name: 'Ines Vogt',   pernr: '10042309' }, T01: { name: 'Jens Adler',   pernr: '10042311' },
    T02: { name: 'Klara Bauer', pernr: '10042312' }, T03: { name: 'Lars Möller',  pernr: '10042313' }
  }

  // Buchungen an einem Takt (wer hat wann für welchen Auftrag gebucht). Mitarbeiter-Namen
  // werden FÜR NICHT-MEISTER im Backend MASKIERT (DSGVO) – nur die Personalnummer bleibt.
  async function taktBookings(stationNo, isSupervisor, lang = 'de') {
    const st = await SELECT.one.from(Stations).where({ stationNo })
    if (!st) return []
    const confs = await SELECT.from(Confirmations).where({ station_ID: st.ID })
    const orderNo = Object.fromEntries(
      (await SELECT.from(ProductionOrders).columns('ID', 'orderNo')).map(o => [o.ID, o.orderNo])
    )
    return confs
      .sort((a, b) => String(b.confirmedAt || '').localeCompare(String(a.confirmedAt || '')))
      .slice(0, 6)
      .map(c => {
        const emp = EMPLOYEES[c.worker] || { name: c.worker, pernr: '–' }
        return {
          worker: isSupervisor ? emp.name : (lang === 'en' ? '•••••••• (masked)' : '•••••••• (maskiert)'),
          pernr: emp.pernr,
          orderNo: orderNo[c.order_ID] || '–',
          shift: c.shift,
          confirmedAt: c.confirmedAt
        }
      })
  }

  // Mitarbeiter-Qualität: je Mitarbeiter der Takt mit der höchsten Fehlerquote (Buchungen für
  // später durchgefallene Aufträge / gesamt). HOCHSENSIBEL (Leistungsbewertung) -> Namen werden
  // für Nicht-Meister maskiert; als Copilot-Tool nur dem Meister verfügbar.
  async function workerQuality(isSupervisor) {
    const orders = await SELECT.from(ProductionOrders).columns('ID', 'finalResult', 'status')
    const failSet = new Set(orders.filter(o => o.finalResult === 'FAIL' || o.status === 'REWORK').map(o => o.ID))
    const stnNo = Object.fromEntries((await SELECT.from(Stations)).map(s => [s.ID, s.stationNo]))
    const confs = await SELECT.from(Confirmations)
    const agg = {}   // worker -> { takt -> { total, fail } }
    for (const c of confs) {
      const t = stnNo[c.station_ID]; if (t == null) continue
      const a = agg[c.worker] || (agg[c.worker] = {})
      const at = a[t] || (a[t] = { total: 0, fail: 0 })
      at.total++; if (failSet.has(c.order_ID)) at.fail++
    }
    return Object.entries(agg)
      .map(([w, takte]) => {
        const worst = Object.entries(takte)
          .filter(([, x]) => x.total >= 4)
          .map(([t, x]) => ({ takt: Number(t), total: x.total, fail: x.fail, rate: Math.round(100 * x.fail / x.total) }))
          .sort((a, b) => b.rate - a.rate)[0]
        const emp = EMPLOYEES[w] || { name: w, pernr: '–' }
        return worst && {
          worker: isSupervisor ? emp.name : '•••••••• (maskiert)',
          pernr: emp.pernr, takt: worst.takt, rate: worst.rate, fail: worst.fail, total: worst.total
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.rate - a.rate)
  }

  // Gehärtete workerQuality-Variante FÜR DEN COPILOT (Muster wie bottleneckInsight):
  // fertiges 'auffaelligster'-Feld + Klartext-Hinweis. Maskierung (isSupervisor) bleibt in
  // workerQuality; nur Meister ruft dieses Tool ohnehin auf. OData/UI-Kachel nutzen das rohe Array.
  async function workerQualityInsight(isSupervisor) {
    const rows = await workerQuality(isSupervisor)   // bereits absteigend nach rate
    const top = rows[0]
    return {
      auffaelligster: top || null,
      hinweis: top
        ? `Auffälligster Mitarbeiter = ${top.worker} (PersNr ${top.pernr}) mit ${top.rate}% Fehlerquote an Takt ${top.takt} `
          + `(${top.fail} von ${top.total} Buchungen für durchgefallene Aufträge). `
          + `Die Liste 'mitarbeiter' ist absteigend nach Fehlerquote sortiert (Rang 1 = auffälligster). `
          + `Für "welcher Mitarbeiter macht die meisten Fehler" IMMER 'auffaelligster' bzw. Rang 1 nehmen.`
        : 'Keine auffälligen Mitarbeiter (zu wenig Buchungen für eine belastbare Quote).',
      mitarbeiter: rows.map((r, i) => ({ rang: i + 1, ...r }))
    }
  }

  // Auftragszettel: Konfiguration aus dem echten Fertigungsauftrag (ProductionOrders).
  async function orderDetail(order) {
    const o = await SELECT.one.from(ProductionOrders).where({ orderNo: order })
    if (!o) return { order: order || '', model: '–', sn: '–', requiredValve: '–', installedValve: '–', valveMismatch: false, market: '–', installedMarket: '–', marketMismatch: false, voltage: '–', power: '–', dryer: false, wrg: false }
    const us = o.destinationMarket === 'US'
    // Ist-Zustand: tatsächlich verbaute Ventil-/Anschlussvariante (für den Soll-Ist-Abgleich)
    const parts = await SELECT.from(InstalledParts).where({ order_ID: o.ID })
    const mats = Object.fromEntries((await SELECT.from(Materials)).map(m => [m.ID, m]))
    let installedValve = o.requiredValveSpec, installedMarket = o.destinationMarket
    for (const p of parts) {
      const mat = mats[p.material_ID]
      if (!mat || !p.installedSpec) continue
      if (mat.partNo.startsWith('V-')) installedValve = p.installedSpec
      if (mat.partNo.startsWith('AN-')) installedMarket = p.installedSpec
    }
    return {
      order: o.orderNo,
      model: us ? 'Baukompressor BK-Standard (US)' : 'Baukompressor BK-Standard (EU)',
      sn: o.compressorSN,
      requiredValve: o.requiredValveSpec, installedValve, valveMismatch: installedValve !== o.requiredValveSpec,
      market: o.destinationMarket, installedMarket, marketMismatch: installedMarket !== o.destinationMarket,
      voltage: us ? '460 V / 60 Hz' : '400 V / 50 Hz',
      power: us ? '7,5 hp' : '5,5 kW',
      dryer: !!o.hasDryer,
      wrg: !!o.hasHeatRecovery
    }
  }

  // Fertige Aufträge (chronologisch) für die Schicht-Übersicht – Früh + Spät bis zur Master-Zeit.
  async function completedOrders(lang = 'de') {
    await ensureOrders()
    const { completed } = computeLine(Math.floor(masterMin() / TAKT_MIN))
    return completed.map(c => {
      const cs = clockShift(c.finishTakt * TAKT_MIN, lang)
      return { order: orderForK(c.k), clock: cs.clock, shiftKey: cs.shiftKey, shiftLabel: cs.shiftLabel }
    })
  }

  /** Präventiver Abgleich beim Scan – der Wächter, der früher fehlte. */
  async function validateInstall(orderNo, partNo, installedSpec) {
    const o = await SELECT.one.from(ProductionOrders).where({ orderNo })
    if (!o) return { ok: false, message: `Auftrag ${orderNo} nicht gefunden.` }
    if (partNo.startsWith('V-') && installedSpec && installedSpec !== o.requiredValveSpec)
      return { ok: false, message: `STOPP: Auftrag ${orderNo} verlangt Ventil ${o.requiredValveSpec}, gescannt ${installedSpec}.` }
    if (partNo.startsWith('AN-') && installedSpec && installedSpec !== o.destinationMarket)
      return { ok: false, message: `STOPP: Zielmarkt ${o.destinationMarket}, aber Anschluss-Variante ${installedSpec} gescannt.` }
    return { ok: true, message: 'OK – Teil passt zum Auftrag.' }
  }

  // OData-Handler (direkte Aufrufe, z.B. aus Fiori)
  this.on('bottleneck',       req => bottleneck(langOf(req)))
  this.on('failureSummary',   ()  => failureSummary())
  this.on('currentAsymmetry', req => currentAsymmetry(req.data.thresholdA ?? 1.5))
  this.on('rootCause',        req => rootCause(req.data.measureType, langOf(req)))
  this.on('configMismatches', req => configMismatches(langOf(req)))
  this.on('stockLevels',      ()  => stockLevels())
  this.on('repairSummary',    ()  => repairSummary())
  this.on('stationOverview',  req => stationOverview(req.user.is('Supervisor'), langOf(req)))
  this.on('liveStatus',       req => liveStatus(langOf(req)))
  this.on('completedOrders',  req => completedOrders(langOf(req)))
  this.on('orderDetail',      req => orderDetail(req.data.order))
  this.on('taktBookings',     req => taktBookings(req.data.stationNo, req.user.is('Supervisor'), langOf(req)))
  this.on('workerQuality',    req => workerQuality(req.user.is('Supervisor')))
  this.on('setTimeMode', req => {
    sim.mode = req.data.mode === 'real' ? 'real' : 'demo'
    return { mode: sim.mode }
  })
  // Welcher KI-Pfad läuft (Anzeige für alle Nutzer).
  this.on('copilotProvider', () => providerInfo())
  // KI-Pfad wechseln: nur lokal möglich (Cloud ist hart auf API gesperrt). Rolle egal —
  // Mitarbeiter wie Meister dürfen lokal zwischen Lokal/Abo/API umschalten (Demo).
  this.on('setCopilotProvider', req => {
    if (!providerInfo().switchable) return req.reject(403, 'KI-Pfad-Wechsel ist nur lokal möglich (Cloud nutzt fix die API).')
    return setProvider(req.data.provider)
  })
  this.on('whoami', req => ({
    user: req.user.id,
    isSupervisor: req.user.is('Supervisor'),
    isWorker: req.user.is('Worker'),
    demoSwitcher: DEMO_PUBLIC   // öffentlicher Demo-Host: Rollen-Umschalter in der UI einblenden
  }))
  this.on('validateInstall',  req => validateInstall(req.data.orderNo, req.data.partNo, req.data.installedSpec))

  // =========================================================================
  // RAG  (lokal: einfaches Keyword-Retrieval über die Störungshistorie)
  // Auf BTP: ersetzen durch HANA-Cloud-Vektorstore + Embeddings (Gen AI Hub).
  // =========================================================================
  async function retrieveKnowledge(query) {
    const docs = await SELECT.from(IssueHistory)
    const words = query.toLowerCase().split(/\W+/).filter(w => w.length > 3)
    return docs
      .map(d => {
        const text = `${d.symptom} ${d.rootCause} ${d.resolution}`.toLowerCase()
        const score = words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0)
        return { d, score }
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map(x => `- ${x.d.symptom}: ${x.d.rootCause} -> ${x.d.resolution}`)
      .join('\n')
  }

  // =========================================================================
  // Copilot: natürliche Sprache -> Tool-Calling + RAG
  // =========================================================================
  // Werker-taugliche Tools: operativ + aggregiert, keine sensiblen Auftrags-/Chargendetails.
  const WORKER_TOOLS = [
    { name: 'bottleneck',     description: 'Engpass/Taktzeiten der Linie. Liefert das Engpass-Feld fertig (langsamster Takt in Minuten) + die nach Taktzeit absteigend sortierte Liste. Für "welcher Takt dauert am längsten" das Feld engpass bzw. Rang 1 nehmen.', input_schema: { type: 'object', properties: {} } },
    { name: 'failureSummary', description: 'Prüfstand-Durchfaller je Messgröße. Liefert das haeufigster-Feld fertig + die absteigend sortierte Liste. Für "welche Messgröße fällt am häufigsten durch" das Feld haeufigster bzw. Rang 1 nehmen.', input_schema: { type: 'object', properties: {} } },
    { name: 'stockLevels',    description: 'Lagerbestand je Teil: Menge, Meldebestand und Status (OK/KNAPP/LEER). Für "haben wir Teil X im Lager?".', input_schema: { type: 'object', properties: {} } },
    { name: 'repairSummary',  description: 'Häufigste Nacharbeiten/Montagefehler (aggregiert), z.B. welche Fehler treten oft auf.', input_schema: { type: 'object', properties: {} } },
    { name: 'lineStatus',     description: 'Aktueller Live-Stand der Linie: laufende Schicht, gefertigte Stück, Soll, Zieltakt und welcher Auftrag an welchem Takt steht (z.B. "wie viele Stück diese Schicht?", "wo steht Auftrag X?").', input_schema: { type: 'object', properties: {} } },
    { name: 'orderInfo',      description: 'Konfiguration eines Fertigungsauftrags (Typ, Markt EU/US, Spannung/Frequenz, Leistung, Soll-Ventil, Kältetrockner, Wärmerückgewinnung). Parameter: Auftragsnummer, z.B. "ORD-5003".', input_schema: { type: 'object', properties: { order: { type: 'string' } }, required: ['order'] } },
    { name: 'taktInfo',       description: 'Info zu einem Takt (1–9): Ø-Taktzeit, Engpass-Status und die Fehler/Auffälligkeiten an diesem Takt. Parameter: Takt-Nummer.', input_schema: { type: 'object', properties: { stationNo: { type: 'integer' } }, required: ['stationNo'] } },
    { name: 'taktBookings',   description: 'Buchungshistorie an einem Takt (wer hat wann für welchen Auftrag gebucht). Mitarbeiter-Namen sind für Nicht-Meister maskiert. Parameter: Takt-Nummer.', input_schema: { type: 'object', properties: { stationNo: { type: 'integer' } }, required: ['stationNo'] } },
  ]
  // Nur Supervisor: forensische Wurzelursachen-Analyse + sensible Einzeldetails.
  const SUPERVISOR_TOOLS = [
    ...WORKER_TOOLS,
    { name: 'currentAsymmetry', description: 'Aufträge mit Phasenasymmetrie der Stromaufnahme – liefert zusätzlich die dominante Charge.', input_schema: { type: 'object', properties: { thresholdA: { type: 'number' } } } },
    { name: 'rootCause',        description: 'Wurzelursachen-Analyse: warum fällt eine Messgröße durch + welche Charge steckt dahinter. Akzeptiert konkrete Messgrößen (CURRENT_L2, FIRST_RUN, LEAKAGE) ODER Freitext wie "Stromaufnahme", "Dichtheit". Für jedes "warum fällt X durch / welche Charge ist schuld" IMMER dieses Tool nehmen.', input_schema: { type: 'object', properties: { measureType: { type: 'string' } }, required: ['measureType'] } },
    { name: 'configMismatches', description: 'Stille Konfigurationsfehler (falsches Ventil / falsche Markt-Anschlussvariante), die kein Prüfstand meldet.', input_schema: { type: 'object', properties: {} } },
    { name: 'workerQuality',    description: 'Mitarbeiter mit auffälliger Fehlerquote (je Mitarbeiter der Takt mit der höchsten Quote an Buchungen für durchgefallene Aufträge). Liefert das auffaelligster-Feld fertig + die absteigend sortierte Liste. Für "welcher Mitarbeiter macht häufig Fehler" das Feld auffaelligster bzw. Rang 1 nehmen. Sensibel/Leistungsbewertung – nur Meister.', input_schema: { type: 'object', properties: {} } },
  ]
  this.on('askCopilot', async req => {
    const lang = langOf(req)
    // Eingabe-Guard VOR dem Rate-Limit: leere Frage → 400 (sonst TypeError → 500, und der
    // Fehlversuch zählt gegen das Kontingent). Längenkappung = Kostenschutz im Public-Demo
    // (das Rate-Limit deckelt nur die Anzahl der Anfragen, nicht die Token pro Anfrage).
    const question = String(req.data.question || '').trim()
    if (!question)
      return req.reject(400, lang === 'en' ? 'Please enter a question.' : 'Bitte gib eine Frage ein.')
    if (question.length > 1000)
      return req.reject(400, lang === 'en' ? 'Question too long (max. 1,000 characters).' : 'Frage zu lang (max. 1.000 Zeichen).')
    // Rate-Limit gegen Missbrauch/Kosten: in der Cloud (BTP), im öffentlichen Demo-Host (DEMO_PUBLIC)
    // oder lokal per COPILOT_RATE_ALWAYS=true. Demo: pro Besucher-IP; sonst pro Login-Nutzer.
    if (process.env.VCAP_APPLICATION || DEMO_PUBLIC || process.env.COPILOT_RATE_ALWAYS === 'true') {
      const rl = DEMO_PUBLIC
        ? copilotRateLimit('ip:' + clientIp(req), RL.perIp, RL.ipWindowMs)
        : copilotRateLimit('user:' + (req.user.id || 'anonymous'), RL.perUser, RL.windowMs)
      if (!rl.ok) return req.reject(429, rl.msg)
    }
    const isSup = req.user.is('Supervisor')
    // Tool-Gating: Werker bekommen NUR die unkritischen Tools. Das schützt auch den
    // In-Process-Aufruf des Copilots (die OData-@requires greifen hier nicht).
    const tools = isSup ? SUPERVISOR_TOOLS : WORKER_TOOLS
    // impl je Anfrage: taktBookings maskiert die Mitarbeiter-Namen anhand der Rolle (isSup);
    // die Sprache (lang) fließt in alle Tools mit nutzer-sichtbaren Texten
    const impl = {
      bottleneck: () => bottleneckInsight(lang), failureSummary: failureSummaryInsight, stockLevels, repairSummary,
      configMismatches: () => configMismatches(lang),
      currentAsymmetry: a => currentAsymmetryInsight(a.thresholdA ?? 1.5, lang),
      rootCause:        a => rootCauseInsight(a.measureType, lang),
      lineStatus:       () => liveStatus(lang),
      orderInfo:        a => orderDetail(a.order),
      taktInfo:         async a => (await stationOverview(isSup, lang)).find(x => x.stationNo === Number(a.stationNo)) || { stationNo: a.stationNo, hinweis: 'Takt nicht gefunden' },
      taktBookings:     async a => {
        const rows = await taktBookings(Number(a.stationNo), isSup, lang)
        // Für Werker: Buchungen mit explizitem Hinweis kapseln, damit das Modell keine
        // Leistungs-/Fehleraussagen über einzelne Mitarbeiter ableitet (Governance/DSGVO).
        return isSup ? rows : { buchungen: rows, hinweis: 'Namen maskiert. Aus diesen Buchungen KEINE Aussagen über Fehlerhäufigkeit oder Leistung einzelner Mitarbeiter ableiten — das ist dem Meister vorbehalten.' }
      },
      workerQuality:    () => workerQualityInsight(isSup)
    }
    const knowledge = await retrieveKnowledge(question)
    const roleNote = isSup
      ? `Du hast Meister-Rechte: nutze bei Bedarf auch Wurzelursachen-Analyse und sensible Einzeldetails.`
      : `Du hilfst einem Mitarbeiter an der Linie. Verfügbar: Live-Stand der Linie, Engpass, Durchfaller-Übersicht, ` +
        `Lagerbestand, häufige Nacharbeiten, Auftragskonfigurationen, Takt-Infos und Buchungen (Mitarbeiter-Namen maskiert). ` +
        `Forensische Ursachenanalysen, einzelne Auftragsnummern mit Fehlern und stille Konfigurationsfehler sind dem ` +
        `Meister vorbehalten — wird danach gefragt, verweise freundlich an den Meister, statt zu spekulieren. ` +
        `WICHTIG: Leite aus Buchungsdaten (taktBookings) NIEMALS Aussagen über Fehlerhäufigkeit, Qualität oder Leistung ` +
        `einzelner Mitarbeiter ab — auch nicht anhand der PersNr, und stelle keine Vermutungen darüber an. Auf Fragen wie ` +
        `„welcher Mitarbeiter macht die meisten Fehler?" antwortest du, dass Mitarbeiterbewertungen dem Meister vorbehalten sind.`
    const system =
      `Du bist ein Shopfloor-Assistent für eine Baukompressor-Montagelinie (9 Stationen + Prüfraum).\n` +
      `Nutze die Tools für Live-Daten (Zahlen, Aufträge, Fehler). Erfinde keine Zahlen.\n` +
      `Taktzeiten kommen als Sekunden (Feld avgCycleSec) – rechne sie in MINUTEN um (÷60) und nenne sie in Minuten (z.B. 1736s = 28,9 min). Zieltakt ist 26 min.\n` +
      `${roleNote}\n` +
      `Stütze Erklärungen/Empfehlungen auf folgendes Erfahrungswissen, falls relevant:\n` +
      `${knowledge || '(kein passender Eintrag)'}\n` +
      (lang === 'en'
        ? `Antworte knapp und konkret auf ENGLISCH (die Oberfläche des Nutzers ist englisch). `
        : `Antworte knapp und konkret auf Deutsch. `) +
      `Stellt der Nutzer seine Frage erkennbar in einer anderen Sprache, antworte in der Sprache des Nutzers. ` +
      `Nenne Auftragsnummern und Stationen, wenn vorhanden.`

    const { answer, usedTool } = await runCopilot({ system, question, tools, impl })

    // Audit-Log (Governance): wer hat wann was gefragt, welche Tools liefen?
    // Direkt in die DB-Tabelle (die OData-Projektion ist @readonly).
    await INSERT.into('shopfloor.CopilotAudit').entries({
      question: (question || '').slice(0, 500),
      usedTool,
      answerChars: (answer || '').length,
      role: req.user.is('Supervisor') ? 'Supervisor' : 'Worker',
      createdBy: req.user.id,
      createdAt: new Date().toISOString()
    })

    return { answer, usedTool, grounding: knowledge }
  })
})
