namespace shopfloor;

using { cuid, managed } from '@sap/cds/common';

/**
 * Fertigungslinie für Baukompressoren – Datenmodell für den Shopfloor-Copilot.
 *
 * Bildet ab:
 *  - getaktete Montagelinie: 8 Montage + Inline-Prüfung (St.9) + Prüfraum + Versand
 *  - drei Rückverfolgbarkeits-Stufen (serialisiert / chargengeführt / Kanban)
 *  - Soll-Spezifikation je Auftrag -> Abgleich verbauter Teile (z.B. Ventil-Druckstufe)
 *  - Prüfsequenz: Inline-Checks (Dichtheit, VDE/PE, 10-min-Testlauf) + Prüfraum (Langzeit)
 *  - Drehstrommotor: Stromaufnahme je Phase (L1/L2/L3) -> Asymmetrie als Fehler-Signal
 *  - Störungshistorie als Grundlage für RAG
 */


// ---------------------------------------------------------------------------
// Stammdaten
// ---------------------------------------------------------------------------

/** Stationen: 1–8 Montage, 9 Inline-Prüfung, 10 Prüfraum, 11 Versand/Kundenanpassung. */
entity Stations : cuid {
  stationNo   : Integer;            // 1..8 Montage, 9 Inline, 10 Prüfraum, 11 Versand
  name        : String(60);
  kind        : String(15) enum { ASSEMBLY; INLINE_TEST; TEST_ROOM; FINISHING; };
  confirmations : Association to many Confirmations on confirmations.station = $self;
}

/**
 * Materialstamm. `traceability` steuert die RCA-Logik:
 *  SERIALIZED – eigene Seriennummer je Stück (Sicherheitsventil, Ölabscheider)
 *  BATCH      – nur Chargennummer (vorgebauter Kabelbaum)
 *  KANBAN     – nur Teilenummer, kein Tracking (Schüttgut) -> blinder Fleck
 *
 * `spec` hält die technische Kenngröße, die abgeglichen werden muss
 *  (z.B. "10 bar" beim Sicherheitsventil). Leer, wo irrelevant.
 */
entity Materials : cuid {
  partNo       : String(40);
  description  : String(120);
  traceability : String(12) enum { SERIALIZED; BATCH; KANBAN; };
  spec         : String(40) null;   // z.B. "10 bar", "8 bar"
  supplier     : Association to Suppliers;
  stockQty     : Integer default 0; // aktueller Lagerbestand (Stück) -> Werker-Frage "haben wir X?"
  reorderPoint : Integer default 0; // Meldebestand; stockQty <= reorderPoint => KNAPP
}

/** Lieferanten / vorgelagerte Fertigung (Kabelbaum, Schaltschrank, extern). */
entity Suppliers : cuid {
  name      : String(80);
  kind      : String(20) enum { EXTERNAL; INHOUSE_PREASSEMBLY; };
  materials : Association to many Materials on materials.supplier = $self;
}


// ---------------------------------------------------------------------------
// Auftrag = ein Kompressor (inkl. Soll-Spezifikation für Validierung)
// ---------------------------------------------------------------------------

entity ProductionOrders : cuid, managed {
  orderNo        : String(20);
  compressorSN   : String(30);      // Seriennummer des fertigen Kompressors
  material       : String(40);      // Kompressor-Typ
  status         : String(15) enum { RUNNING; FINISHED; SCRAPPED; REWORK; };
  startedAt      : Timestamp;
  finishedAt     : Timestamp;

  // Soll-Vorgaben für den Poka-Yoke-Abgleich (präventiver Modus):
  requiredValveSpec : String(40);   // z.B. "10 bar" -> 8-bar-Ventil = Mismatch
  destinationMarket : String(3) enum { EU; US; };  // Soll-Variante Anschlüsse/Ventile (stiller Fehler!)

  // Kundenoptionen / Sonderausstattung (Variantenkonfiguration) -> mehr Montagezeit
  // an bestimmten Stationen (Trockner = Verrohrung St.7, WRG = Elektrik St.6 + Verrohrung St.7):
  hasDryer        : Boolean default false;  // integrierter Kältetrockner (Drucklufttrocknung)
  hasHeatRecovery : Boolean default false;  // Wärmerückgewinnung – Abwärme heizt Hallen/Brauchwasser

  confirmations  : Association to many Confirmations    on confirmations.order  = $self;
  components     : Association to many InstalledParts    on components.order     = $self;
  testResults    : Association to many TestMeasurements  on testResults.order    = $self;
  repairs        : Association to many Repairs           on repairs.order        = $self;
  finalResult    : String(10) enum { PASS; FAIL; OPEN; } default 'OPEN';
}


// ---------------------------------------------------------------------------
// Rückmeldungen je Station
// ---------------------------------------------------------------------------

entity Confirmations : cuid {
  order        : Association to ProductionOrders;
  station      : Association to Stations;
  worker       : String(40);
  shift        : String(10) enum { EARLY; LATE; NIGHT; };
  confirmedAt  : Timestamp;         // real oft verspätet/gesammelt gebucht
  cycleTimeSec : Integer;           // Ist-Taktzeit -> Engpass-Erkennung
  scrapQty     : Integer default 0;
}


// ---------------------------------------------------------------------------
// Verbaute Teile = Rückverfolgbarkeits-Schicht (Herzstück der RCA)
// ---------------------------------------------------------------------------

/**
 * Welches Teil wurde an welcher Station in welchen Kompressor verbaut.
 * Bei SERIALIZED ist serialNo gefüllt (Scan), bei BATCH die batchNo,
 * bei KANBAN keins von beidem -> nur über partNo bekannt = Blindstelle.
 *
 * `installedSpec` = die tatsächliche Kenngröße des verbauten Teils.
 * Stimmt sie nicht mit ProductionOrders.requiredValveSpec überein,
 * liegt ein Mismatch vor -> der Fehler, den das alte System NICHT meldete.
 */
entity InstalledParts : cuid {
  order         : Association to ProductionOrders;
  station       : Association to Stations;
  material      : Association to Materials;
  serialNo      : String(30) null;  // nur bei SERIALIZED (QR-Scan)
  batchNo       : String(30) null;  // nur bei BATCH
  installedSpec : String(40) null;  // tatsächliche Kenngröße, z.B. "8 bar"
  installedAt   : Timestamp;
}


// ---------------------------------------------------------------------------
// Prüfung – zweistufig: Inline + Prüfraum
// ---------------------------------------------------------------------------

entity TestMeasurements : cuid {
  order        : Association to ProductionOrders;
  phase        : String(12) enum { INLINE; TEST_ROOM; };
  measureType  : String(20) enum {
    LEAKAGE;          // kurze Dichtheitsprüfung (Inline)
    VDE_PE;           // VDE-Prüfung PE-Kabel an mehreren Stellen (Inline)
    FIRST_RUN;        // 10-min-Testlauf (Inline)
    CURRENT_L1;       // Stromaufnahme Phase L1 (Prüfraum, Drehstrom)
    CURRENT_L2;       // Stromaufnahme Phase L2
    CURRENT_L3;       // Stromaufnahme Phase L3 -> Asymmetrie = einphasiger Fehler
    NOISE;            // Geräuschpegel (Prüfraum)
    PRESSURE;         // Druckaufbau
    TEMPERATURE;      // Temperatur
  };
  value        : Decimal(10,3);
  unit         : String(10);
  lowerLimit   : Decimal(10,3);
  upperLimit   : Decimal(10,3);
  passed       : Boolean;
  measuredAt   : Timestamp;
}


// ---------------------------------------------------------------------------
// Reparaturen – kleine Inline-Reparatur vs. Ausschleusung
// ---------------------------------------------------------------------------

entity Repairs : cuid, managed {
  order        : Association to ProductionOrders;
  kind         : String(15) enum { MINOR_INLINE; MAJOR_OFFLINE; };
  description  : String(300);
  resolvedBy   : String(40);
}


// ---------------------------------------------------------------------------
// Störungshistorie – strukturiert + Textfeld als RAG-Quelle
// ---------------------------------------------------------------------------

entity IssueHistory : cuid, managed {
  order           : Association to ProductionOrders null;
  symptom         : String(120);    // z.B. "Druck baut nicht auf"
  rootCause       : String(200);    // dokumentierte Ursache
  resolution      : String(500);    // wie behoben -> RAG-Wissen
  relatedStation  : Association to Stations null;
  relatedMaterial : Association to Materials null;
}


// ---------------------------------------------------------------------------
// Copilot-Audit-Log (Governance) – jeder KI-Aufruf wird protokolliert.
// `managed` liefert createdAt (Zeitstempel) + createdBy (Nutzer) automatisch.
// ---------------------------------------------------------------------------

entity CopilotAudit : cuid, managed {
  question    : String(500);   // gestellte Frage
  usedTool    : String(120);   // verwendete Analyse-Tools
  answerChars : Integer;       // Antwortlänge (Indikator; kein Volltext gespeichert)
  role        : String(20);    // Rolle des Aufrufers
}
