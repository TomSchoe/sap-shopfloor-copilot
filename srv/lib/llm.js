/**
 * Dual-Path LLM-Layer für den Shopfloor-Copilot.
 *
 * LOKAL GRATIS  (CLAUDE_USE_SUBSCRIPTION=true):
 *   Claude Agent SDK (@anthropic-ai/claude-agent-sdk) mit Subscription-Auth
 *   aus ~/.claude/ (Claude-Code-Login) — KEINE Pay-per-Token-Kosten.
 *   Die Analyse-Tools laufen als In-Process-MCP-Server; ihre Handler rufen
 *   die echten CAP-DB-Funktionen (impl) auf. Das LLM führt den Tool-Loop.
 *   Trick: ANTHROPIC_API_KEY während des Calls entfernen — sonst zieht das
 *   SDK ihn vor ("credit balance too low"). Im finally wiederhergestellt.
 *   Voraussetzung: die `claude`-CLI ist lokal eingeloggt.
 *
 * API / FALLBACK  (CLAUDE_USE_SUBSCRIPTION != 'true'):
 *   Offizielles @anthropic-ai/sdk mit ANTHROPIC_API_KEY (Pay-per-Token).
 *   Manueller Tool-Loop über die Messages-API.
 *
 * SAP BTP (Phase 3): durch llm.btp.js (Gen AI Hub) ersetzen — gleiche
 *   runCopilot-Signatur, der Rest des Service bleibt unverändert.
 */

const SUB_MODEL = process.env.LLM_MODEL     || 'opus'            // Agent-SDK-Alias (opus|sonnet|haiku)
const API_MODEL = process.env.LLM_MODEL_API || 'claude-sonnet-5'  // Anthropic-API Modell-ID (Sonnet: günstiger, near-Opus)
const MCP_NAME  = 'shopfloor-tools'
const MAX_TURNS = 6

// --- Aktiver LLM-Pfad: aus .env vorbelegt, zur Laufzeit per UI umschaltbar -----
// Anzeige-Metadaten je Pfad (short = Umschalter-Label, label = ausführlich).
const PROVIDERS = {
  local:        { short: 'Lokal', label: 'On-Prem (Ollama)' },
  subscription: { short: 'Abo',   label: 'Claude-Abo (SDK)' },
  api:          { short: 'API',   label: 'Anthropic API' },
}
let providerOverride = null  // gesetzt vom UI-Umschalter; null = Vorgabe aus .env

// In der Cloud (BTP) UND im öffentlichen Demo-Host gibt es weder ~/.claude noch Ollama
// -> immer API-Pfad, Provider-Umschalter aus.
const IS_CLOUD = !!process.env.VCAP_APPLICATION || process.env.DEMO_PUBLIC === 'true'

function envProvider() {
  if (process.env.LLM_PROVIDER === 'local')          return 'local'
  if (process.env.CLAUDE_USE_SUBSCRIPTION === 'true') return 'subscription'
  return 'api'
}
function activeProvider() {
  if (IS_CLOUD) return 'api'                       // Cloud kann nur den API-Pfad
  return providerOverride || envProvider()
}
function modelOf(p) {
  if (p === 'local')        return process.env.LLM_LOCAL_MODEL || 'qwen2.5'
  if (p === 'subscription') return SUB_MODEL
  return API_MODEL
}
// Setzt den Laufzeit-Pfad (UI-Umschalter). Unbekannt/leer -> zurück zur .env-Vorgabe.
function setProvider(p) {
  providerOverride = PROVIDERS[p] ? p : null
  return providerInfo()
}
// Status für die UI: aktiver Pfad, Modell, Auswahlliste, ob umschaltbar.
function providerInfo() {
  const p = activeProvider()
  return {
    provider:   p,
    short:      PROVIDERS[p].short,
    label:      `${PROVIDERS[p].label} · ${modelOf(p)}`,
    switchable: !IS_CLOUD,
    options:    Object.entries(PROVIDERS).map(([id, v]) => ({ id, short: v.short, label: v.label })),
  }
}

// --- JSON-Schema (aus service.js TOOLS) -> zod-Shape für das Agent SDK ---------
function toZodShape(z, inputSchema) {
  const props    = (inputSchema && inputSchema.properties) || {}
  const required = new Set((inputSchema && inputSchema.required) || [])
  const shape = {}
  for (const [key, def] of Object.entries(props)) {
    let field = (def.type === 'number' || def.type === 'integer') ? z.number() : z.string()
    if (def.description) field = field.describe(def.description)
    if (!required.has(key)) field = field.optional()
    shape[key] = field
  }
  // MCP-Tools brauchen mind. ein Feld -> Platzhalter für parameterlose Tools.
  if (Object.keys(shape).length === 0) shape._noargs = z.string().optional()
  return shape
}

// =============================================================================
// Abo-Pfad: Claude Agent SDK + In-Process-MCP-Server (kostenfrei lokal)
// =============================================================================
async function runViaSubscription({ system, question, tools, impl }) {
  const { query, createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')

  const usedTools = []
  const sdkTools = tools.map(spec =>
    tool(spec.name, spec.description, toZodShape(z, spec.input_schema), async (input) => {
      const { _noargs, ...args } = input || {}
      const result = await impl[spec.name](args)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    })
  )
  const mcp     = createSdkMcpServer({ name: MCP_NAME, tools: sdkTools })
  const allowed = tools.map(t => `mcp__${MCP_NAME}__${t.name}`)

  // Subscription-Auth erzwingen (siehe Header-Kommentar).
  const savedApiKey = process.env.ANTHROPIC_API_KEY
  if (savedApiKey) delete process.env.ANTHROPIC_API_KEY

  try {
    const q = query({
      prompt: question,
      options: {
        systemPrompt: system,
        mcpServers:   { [MCP_NAME]: mcp },
        allowedTools: allowed,
        // Built-in Claude-Code-Tools sperren — der Copilot darf nur unsere Tools nutzen.
        // ToolSearch ist unnötig, da unsere Tools via allowedTools direkt freigegeben sind.
        disallowedTools: ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'TodoWrite', 'Task', 'WebFetch', 'WebSearch', 'ToolSearch'],
        model:    SUB_MODEL,
        maxTurns: MAX_TURNS,
      },
    })

    let answer = ''
    for await (const event of q) {
      if (event.type === 'assistant') {
        for (const b of event.message?.content ?? []) {
          if (b.type === 'text' && b.text) answer += b.text
          // Nur unsere Analyse-Tools erfassen (SDK-interne Tools ignorieren).
          else if (b.type === 'tool_use' && b.name.startsWith(`mcp__${MCP_NAME}__`)) {
            usedTools.push(b.name.replace(/^mcp__[^_]+__/, ''))
          }
        }
      } else if (event.type === 'result') {
        break
      }
    }
    return { answer: answer.trim(), usedTool: [...new Set(usedTools)].join(', ') || '(keins)' }
  } catch (err) {
    throw new Error(
      `Abo-Modus fehlgeschlagen: ${err.message || err}. `
      + `Stelle sicher, dass die 'claude'-CLI lokal eingeloggt ist (Claude-Code-Auth).`
    )
  } finally {
    if (savedApiKey) process.env.ANTHROPIC_API_KEY = savedApiKey
  }
}

// =============================================================================
// API-Pfad: offizielles @anthropic-ai/sdk + manueller Tool-Loop (Pay-per-Token)
// =============================================================================
async function runViaApi({ system, question, tools, impl }) {
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error(
    'ANTHROPIC_API_KEY fehlt. Für den kostenfreien Abo-Pfad CLAUDE_USE_SUBSCRIPTION=true setzen, '
    + 'oder einen API-Key in .env hinterlegen.'
  )
  const client = new Anthropic({ apiKey })

  const apiTools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
  const messages = [{ role: 'user', content: question }]
  let usedTool = '(keins)'

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await client.messages.create({
      model: API_MODEL, max_tokens: 1024, system, tools: apiTools, messages,
    })
    const toolUses = res.content.filter(b => b.type === 'tool_use')
    if (res.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      return { answer: text.trim(), usedTool }
    }
    messages.push({ role: 'assistant', content: res.content })
    const results = []
    for (const tu of toolUses) {
      usedTool = tu.name
      const data = await impl[tu.name](tu.input || {})
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(data).slice(0, 6000) })
    }
    messages.push({ role: 'user', content: results })
  }
  return { answer: 'Abbruch: zu viele Tool-Schritte ohne finale Antwort.', usedTool }
}

// =============================================================================
// LOKALER Pfad: On-Prem-LLM über Ollama – kein Datum verlässt das Haus (Datensicherheit).
// Voraussetzung: Ollama läuft + Modell geladen. Modell muss Function-Calling können (Qwen 2.5 / Llama 3.x).
//   .env:  LLM_PROVIDER=local · LLM_LOCAL_MODEL=qwen2.5 · LLM_LOCAL_URL=http://localhost:11434/v1
//          LLM_LOCAL_CTX=16384  (Kontextfenster; s.u.)
// WICHTIG – native /api/chat statt OpenAI-Route: Nur die native Ollama-API akzeptiert
// `options.num_ctx`. Über /v1/chat/completions wird num_ctx IGNORIERT (Ollama lädt dann
// mit Default 4096) → bei System-Prompt + 9 Tool-Defs + Tool-Ergebnissen läuft der
// Kontext über und wird vorne abgeschnitten → falsche Antworten. Darum hier nativ.
// =============================================================================
async function runViaLocal({ system, question, tools, impl }) {
  // LLM_LOCAL_URL endet i.d.R. auf /v1 (OpenAI-Stil) – für die native Route abschneiden.
  const root   = (process.env.LLM_LOCAL_URL || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '')
  const model  = process.env.LLM_LOCAL_MODEL || 'qwen2.5'
  const numCtx = Number(process.env.LLM_LOCAL_CTX || 16384)
  const oaTools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
  const messages = [{ role: 'system', content: system }, { role: 'user', content: question }]
  let usedTool = '(keins)'

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let res
    try {
      res = await fetch(`${root}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, tools: oaTools, stream: false, options: { temperature: 0.2, num_ctx: numCtx } })
      })
    } catch (e) {
      throw new Error(`Lokales LLM nicht erreichbar (${root}). Läuft Ollama? (ollama serve / ollama run ${model})`)
    }
    if (!res.ok) throw new Error(`Lokales LLM (${model}) HTTP ${res.status}. Modell geladen? (ollama pull ${model})`)
    const msg = (await res.json()).message
    if (!msg) throw new Error('Lokales LLM: leere Antwort.')
    const calls = msg.tool_calls || []
    if (!calls.length) return { answer: (msg.content || '').trim(), usedTool }
    messages.push(msg)
    for (const c of calls) {
      usedTool = c.function?.name
      // Native API liefert arguments bereits als Objekt (OpenAI-Route lieferte JSON-String) – beides abfangen.
      let args = c.function?.arguments || {}
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch (e) { args = {} } }
      const data = impl[usedTool] ? await impl[usedTool](args) : { error: `Tool ${usedTool} unbekannt` }
      messages.push({ role: 'tool', tool_name: usedTool, content: JSON.stringify(data).slice(0, 6000) })
    }
  }
  return { answer: 'Abbruch: zu viele Tool-Schritte ohne finale Antwort.', usedTool }
}

// =============================================================================
// Öffentliche Schnittstelle: führt eine Copilot-Anfrage end-to-end aus.
//   { system, question, tools:[{name,description,input_schema}], impl:{name:fn} }
//   -> { answer, usedTool }
// =============================================================================
async function runCopilot(args) {
  const p = activeProvider()
  if (p === 'local')        return runViaLocal(args)        // On-Prem (Ollama)
  if (p === 'subscription') return runViaSubscription(args) // Claude-Abo (SDK)
  return runViaApi(args)                                    // Anthropic API
}

module.exports = { runCopilot, providerInfo, setProvider }
