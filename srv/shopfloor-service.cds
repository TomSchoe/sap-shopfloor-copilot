using shopfloor from '../db/schema';

/**
 * OData-Service + KI-Schicht für den Shopfloor-Copilot.
 *
 *  - Lesende OData-Entities (für Fiori und externe Systeme)
 *  - Deterministische Analyse-"Tools" (auch vom Copilot per Function Calling genutzt)
 *  - validateInstall: präventiver Poka-Yoke-Abgleich beim Einbau
 *  - askCopilot: natürliche Sprache -> Tool-Calling + RAG -> Antwort
 */
service ShopfloorService @(path: '/shopfloor', requires: 'authenticated-user') {

  // --- Daten als OData (lesend) ---
  @readonly entity ProductionOrders as projection on shopfloor.ProductionOrders;
  @readonly entity Confirmations    as projection on shopfloor.Confirmations;
  @readonly entity InstalledParts   as projection on shopfloor.InstalledParts;
  @readonly entity TestMeasurements as projection on shopfloor.TestMeasurements;
  @readonly entity Stations         as projection on shopfloor.Stations;
  @readonly entity Materials        as projection on shopfloor.Materials;
  @readonly entity IssueHistory     as projection on shopfloor.IssueHistory;

  // Audit-Log: nur Supervisor darf es einsehen
  @readonly @(requires: 'Supervisor')
  entity CopilotAudit as projection on shopfloor.CopilotAudit;

  // --- Deterministische Analyse-Tools (Live-Daten, kein LLM nötig) ---

  /** Engpass: durchschnittliche Ist-Taktzeit je Station, absteigend. */
  function bottleneck() returns array of {
    stationNo : Integer; name : String; avgCycleSec : Decimal; samples : Integer;
  };

  /** Anzahl Prüfstand-Durchfaller je Messgröße. */
  function failureSummary() returns array of {
    measureType : String; fails : Integer;
  };

  /** Aufträge mit Phasenasymmetrie der Stromaufnahme (L1/L2/L3). — nur Supervisor */
  @(requires: 'Supervisor')
  function currentAsymmetry(thresholdA : Decimal) returns array of {
    orderNo : String; l1 : Decimal; l2 : Decimal; l3 : Decimal; spreadA : Decimal;
  };

  /** Wurzelursachen-Analyse für eine durchgefallene Messgröße. — nur Supervisor */
  @(requires: 'Supervisor')
  function rootCause(measureType : String) returns {
    measureType : String; failingOrders : Integer; hypothesis : String; sharedFactor : String;
  };

  /** Stille Konfigurationsfehler (falsches Ventil / falsche Markt-Anschlussvariante). — nur Supervisor */
  @(requires: 'Supervisor')
  function configMismatches() returns array of {
    orderNo : String; kind : String; required : String; installed : String; station : Integer;
  };

  /** Lagerbestand je Teil (Menge, Meldebestand, Status OK/KNAPP/LEER). — auch für Werker. */
  function stockLevels() returns array of {
    partNo : String; description : String; stockQty : Integer; reorderPoint : Integer; status : String;
  };

  /** Häufigste Nacharbeiten/Montagefehler (aggregiert, ohne sensible Details). — auch für Werker. */
  function repairSummary() returns array of {
    issue : String; count : Integer;
  };

  /** Stationsübersicht für das Flussdiagramm: Taktzeit, Engpass-Flag und Fehler/Auffälligkeiten je Station. */
  function stationOverview() returns array of {
    stationNo : Integer; name : String; kind : String;
    avgCycleSec : Decimal; samples : Integer; isBottleneck : Boolean;
    issueCount : Integer; issues : array of { kat : String; text : String; };
  };

  /** Fertiggestellte Aufträge (Früh- + Spätschicht übergreifend) für die Schicht-Übersicht. */
  function completedOrders() returns array of {
    order : String; clock : String; shiftKey : String; shiftLabel : String;
  };

  /** Buchungen an einem Takt (wer hat wann gebucht). Namen werden für Nicht-Meister maskiert. */
  function taktBookings(stationNo : Integer) returns array of {
    worker : String; pernr : String; orderNo : String; shift : String; confirmedAt : Timestamp;
  };

  /** Mitarbeiter-Fehlerquote je auffälligem Takt (Qualität/Leistungsbewertung). Nur Meister. */
  @(requires: 'Supervisor')
  function workerQuality() returns array of {
    worker : String; pernr : String; takt : Integer; rate : Integer; fail : Integer; total : Integer;
  };

  /** Auftragszettel: Konfiguration/Sonderausstattung eines Fertigungsauftrags (digitaler Zettel). */
  action orderDetail(order : String) returns {
    order : String; model : String; sn : String;
    requiredValve : String; installedValve : String; valveMismatch : Boolean;
    market : String; installedMarket : String; marketMismatch : Boolean;
    voltage : String; power : String; dryer : Boolean; wrg : Boolean;
  };

  /** Live-Linienmonitor: laufende Schicht, Ausstoß, WIP je Station und Ereignis-Ticker. */
  function liveStatus() returns {
    shift : String; shiftLabel : String; plant : String; line : String; clock : String;
    unitsThisShift : Integer; taktMin : Integer; shiftTarget : Integer; wipCount : Integer;
    wip : array of { compressorSN : String; orderNo : String; stationNo : Integer; stationName : String; };
    events : array of String;
  };

  /** Aktuelle Identität/Rolle für die UI (steuert die abgespeckte Sicht). */
  function whoami() returns { user : String; isSupervisor : Boolean; isWorker : Boolean; };

  /** Zeitmodus des Live-Monitors umschalten: 'demo' (beschleunigt) | 'real' (Echtzeit). */
  action setTimeMode(mode : String) returns { mode : String; };

  /** Welcher KI-Pfad bedient den Copilot (Anzeige im Chat-Fenster). */
  function copilotProvider() returns {
    provider : String; short : String; label : String; switchable : Boolean;
    options : array of { id : String; short : String; label : String; };
  };
  /** KI-Pfad zur Laufzeit wechseln: 'local' | 'subscription' | 'api' (nur Meister, nur lokal). */
  action setCopilotProvider(provider : String) returns {
    provider : String; short : String; label : String; switchable : Boolean;
    options : array of { id : String; short : String; label : String; };
  };

  // --- Präventiver Abgleich beim Einbau (Poka-Yoke, Echtzeit) ---
  action validateInstall(orderNo : String, partNo : String, installedSpec : String) returns {
    ok : Boolean; message : String;
  };

  // --- Der Copilot (für alle authentifizierten Nutzer; Werker erhalten gefilterte Tools) ---
  action askCopilot(question : String) returns {
    answer : String; usedTool : String; grounding : String;
  };
}
