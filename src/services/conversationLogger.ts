/**
 * Conversation Logger Service for Claude Code
 *
 * Captures every LLM turn's complete input and output to JSONL files,
 * matching the coverage of the OpenCode implementation.
 *
 * Configuration:
 * - Enable via settings.json: { "conversationLogging": { "enabled": true } }
 * - Or via environment variable: CLAUDE_CODE_LOG_CONVERSATION=true
 *
 * Output format is compatible with the OpenCode visualizer.
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  getSessionId,
  getProjectRoot,
  getOriginalCwd,
} from '../bootstrap/state.js'
import { getSessionSettingsCache } from '../utils/settings/settingsCache.js'
import { isEnvTruthy } from '../utils/envUtils.js'

// ── JSONL Output Records ────────────────────────────────────────────────────────

export interface TurnStartRecord {
  type: 'turn_start'
  timestamp: string
  sessionID: string
  conversationID: string
  turnIndex: number
  input: {
    system: string[]
    messages: unknown[]
  }
}

export interface TurnCompleteRecord {
  type: 'turn_complete'
  timestamp: string
  sessionID: string
  conversationID: string
  turnIndex: number
  output: {
    message: MessageInfo
    parts: OutputPart[]
    retries?: RetryRecord[]
    error?: string
  }
}

// ── Supporting Types ────────────────────────────────────────────────────────────

export interface MessageInfo {
  id: string
  sessionID: string
  role: 'assistant'
  model: { providerID: string; id: string; variant: string }
  agent: string
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  cost: number
  finish: string
}

export type OutputPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-invocation'; tool: string; input: unknown; output?: unknown; state: string }

export interface RetryRecord {
  attempt: number
  error: { message: string; statusCode?: number; isRetryable: boolean }
}

// ── Internal State Types ────────────────────────────────────────────────────────

interface ToolCallState {
  callID: string
  name: string
  input: unknown
  providerExecuted: boolean
  result?: unknown
  error?: unknown
}

interface ActiveTurn {
  startedAt: string
  model: { id: string; providerID: string; variant: string }
  agent: string
  snapshot?: string
  input: {
    system: string[]
    messages: unknown[]
  }
  text: string
  reasoningBlocks: Array<{ reasoningID: string; text: string }>
  toolCalls: Map<string, ToolCallState>
  retries: RetryRecord[]
}

interface SessionState {
  filePath: string
  pendingInput: {
    system: string[]
    messages: unknown[]
  } | null
  currentTurn: ActiveTurn | null
  conversationID: string
  turnIndex: number
}

// ── Configuration ────────────────────────────────────────────────────────────────

interface ConversationLoggingConfig {
  enabled: boolean
  outputDir: string
  maxTextLength: number
  // thinking, tool results, system prompts are always logged (not configurable)
}

const DEFAULT_CONFIG: ConversationLoggingConfig = {
  enabled: false,
  outputDir: '.logs',
  maxTextLength: 50000,
}

/**
 * Get conversation logging configuration from settings and environment.
 * Priority: settings.json > environment variable > defaults
 */
export function getConversationLoggingConfig(): ConversationLoggingConfig {
  const settingsCache = getSessionSettingsCache()
  const loggingSettings = settingsCache?.settings?.conversationLogging as
    | Record<string, unknown>
    | undefined

  // Environment variable override
  const envEnabled = isEnvTruthy(process.env.CLAUDE_CODE_LOG_CONVERSATION)

  return {
    ...DEFAULT_CONFIG,
    ...loggingSettings,
    enabled: (loggingSettings?.enabled as boolean | undefined) ?? envEnabled ?? false,
  }
}

/**
 * Check if conversation logging is enabled.
 */
export function isConversationLoggingEnabled(): boolean {
  return getConversationLoggingConfig().enabled
}

// ── Session Management ────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionState>()

function getSession(sessionID: string, outputDir: string): SessionState {
  let s = sessions.get(sessionID)
  if (!s) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const safeID = sessionID.replace(/[^a-zA-Z0-9_-]/g, '_')
    // Use project root for the log directory
    const projectRoot = getProjectRoot() || getOriginalCwd()
    const logDir = join(projectRoot, outputDir)

    // Ensure directory exists
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true })
    }

    const fp = join(logDir, `${safeID}_${ts}.jsonl`)
    s = {
      filePath: fp,
      pendingInput: null,
      currentTurn: null,
      conversationID: '',
      turnIndex: 0,
    }
    sessions.set(sessionID, s)
  }
  return s
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + `\n\n... [truncated ${text.length - maxLength} chars]`
}

function shortId(): string {
  return randomUUID().slice(0, 8)
}

function buildOutputParts(turn: ActiveTurn, maxTextLength: number): OutputPart[] {
  const parts: OutputPart[] = []

  // Reasoning blocks (thinking parts) — may be multiple per turn
  for (const rb of turn.reasoningBlocks) {
    parts.push({ type: 'thinking', text: truncate(rb.text, maxTextLength) })
  }

  // Text output
  if (turn.text) {
    parts.push({ type: 'text', text: truncate(turn.text, maxTextLength) })
  }

  // Tool calls with results
  for (const [, tc] of turn.toolCalls) {
    const part: OutputPart & { type: 'tool-invocation' } = {
      type: 'tool-invocation',
      tool: tc.name,
      input: tc.input,
      state: tc.error ? 'error' : tc.result ? 'completed' : 'pending',
    }
    if (tc.result) part.output = tc.result
    if (tc.error) part.output = tc.error
    parts.push(part)
  }

  return parts
}

function writeLine(session: SessionState, record: TurnStartRecord | TurnCompleteRecord): void {
  try {
    appendFileSync(session.filePath, JSON.stringify(record) + '\n', 'utf-8')
  } catch {
    // Never crash Claude Code over logging
  }
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Set the pending input for the next turn.
 * Called before each LLM call to capture system prompt and messages.
 */
export function setPendingInput(system: string[], messages: unknown[]): void {
  if (!isConversationLoggingEnabled()) return
  const sessionID = getSessionId()
  const config = getConversationLoggingConfig()
  const session = getSession(sessionID, config.outputDir)

  session.pendingInput = {
    system,
    messages,
  }
}

/**
 * Log the start of a turn.
 * Called when a new LLM request begins.
 */
export function logTurnStart(
  model: { id: string; providerID: string; variant: string },
  agent: string,
): void {
  if (!isConversationLoggingEnabled()) return
  const sessionID = getSessionId()
  const config = getConversationLoggingConfig()
  const session = getSession(sessionID, config.outputDir)

  if (!session.conversationID) {
    session.conversationID = shortId()
  }

  session.turnIndex++
  const timestamp = new Date().toISOString()

  session.currentTurn = {
    startedAt: timestamp,
    model,
    agent,
    input: session.pendingInput ?? { system: [], messages: [] },
    text: '',
    reasoningBlocks: [],
    toolCalls: new Map(),
    retries: [],
  }

  // Write turn_start immediately
  const record: TurnStartRecord = {
    type: 'turn_start',
    timestamp,
    sessionID,
    conversationID: session.conversationID,
    turnIndex: session.turnIndex,
    input: {
      system: session.currentTurn.input.system,
      messages: session.currentTurn.input.messages,
    },
  }
  writeLine(session, record)

  // Clear pending input
  session.pendingInput = null
}

/**
 * Log text output from the model.
 * Called when text content is streamed.
 */
export function logTextOutput(text: string): void {
  if (!isConversationLoggingEnabled()) return
  const sessionID = getSessionId()
  const config = getConversationLoggingConfig()
  const session = getSession(sessionID, config.outputDir)

  if (session.currentTurn) {
    session.currentTurn.text = text
  }
}

/**
 * Log thinking/reasoning output from the model.
 * Called when thinking content is streamed.
 */
export function logThinkingOutput(reasoningID: string, text: string): void {
  if (!isConversationLoggingEnabled()) return
  const sessionID = getSessionId()
  const config = getConversationLoggingConfig()
  const session = getSession(sessionID, config.outputDir)

  if (session.currentTurn) {
    session.currentTurn.reasoningBlocks.push({ reasoningID, text })
  }
}

/**
 * Log a tool call.
 * Called when the model invokes a tool.
 */
export function logToolCall(callID: string, name: string, input: unknown): void {
  if (!isConversationLoggingEnabled()) return
  const sessionID = getSessionId()
  const config = getConversationLoggingConfig()
  const session = getSession(sessionID, config.outputDir)

  if (session.currentTurn) {
    session.currentTurn.toolCalls.set(callID, {
      callID,
      name,
      input,
      providerExecuted: false,
    })
  }
}

/**
 * Log a tool result.
 * Called when a tool execution completes successfully.
 */
export function logToolResult(callID: string, result: unknown): void {
  if (!isConversationLoggingEnabled()) return
  const sessionID = getSessionId()
  const config = getConversationLoggingConfig()
  const session = getSession(sessionID, config.outputDir)

  if (session.currentTurn) {
    const tc = session.currentTurn.toolCalls.get(callID)
    if (tc) {
      tc.result = result
    }
  }
}

/**
 * Log a tool error.
 * Called when a tool execution fails.
 */
export function logToolError(callID: string, error: unknown): void {
  if (!isConversationLoggingEnabled()) return
  const sessionID = getSessionId()
  const config = getConversationLoggingConfig()
  const session = getSession(sessionID, config.outputDir)

  if (session.currentTurn) {
    const tc = session.currentTurn.toolCalls.get(callID)
    if (tc) {
      tc.error = error
    }
  }
}

/**
 * Log a retry event.
 * Called when an API call is retried.
 */
export function logRetry(attempt: number, error: Error, statusCode?: number): void {
  if (!isConversationLoggingEnabled()) return
  const sessionID = getSessionId()
  const config = getConversationLoggingConfig()
  const session = getSession(sessionID, config.outputDir)

  if (session.currentTurn) {
    session.currentTurn.retries.push({
      attempt,
      error: {
        message: error.message,
        statusCode,
        isRetryable: true,
      },
    })
  }
}

/**
 * Log the completion of a turn.
 * Called when the LLM response is complete.
 */
export function logTurnComplete(
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  },
  stopReason: string | null | undefined,
  cost: number,
  messageId: string,
): void {
  if (!isConversationLoggingEnabled()) return
  const sessionID = getSessionId()
  const config = getConversationLoggingConfig()
  const session = getSession(sessionID, config.outputDir)

  if (!session.currentTurn) return

  const turn = session.currentTurn

  const record: TurnCompleteRecord = {
    type: 'turn_complete',
    timestamp: new Date().toISOString(),
    sessionID,
    conversationID: session.conversationID,
    turnIndex: session.turnIndex,
    output: {
      message: {
        id: messageId,
        sessionID,
        role: 'assistant',
        model: turn.model,
        agent: turn.agent,
        tokens: {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          reasoning: 0,
          cache: {
            read: usage.cache_read_input_tokens ?? 0,
            write: usage.cache_creation_input_tokens ?? 0,
          },
        },
        cost,
        finish: stopReason ?? 'unknown',
      },
      parts: buildOutputParts(turn, config.maxTextLength),
      retries: turn.retries.length > 0 ? turn.retries : undefined,
    },
  }

  writeLine(session, record)
  session.currentTurn = null
}

/**
 * Log a turn error.
 * Called when the LLM request fails.
 */
export function logTurnError(error: string): void {
  if (!isConversationLoggingEnabled()) return
  const sessionID = getSessionId()
  const config = getConversationLoggingConfig()
  const session = getSession(sessionID, config.outputDir)

  if (!session.currentTurn) return

  const turn = session.currentTurn

  const record: TurnCompleteRecord = {
    type: 'turn_complete',
    timestamp: new Date().toISOString(),
    sessionID,
    conversationID: session.conversationID,
    turnIndex: session.turnIndex,
    output: {
      message: {
        id: '',
        sessionID,
        role: 'assistant',
        model: turn.model,
        agent: turn.agent,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0,
        finish: 'error',
      },
      parts: buildOutputParts(turn, config.maxTextLength),
      retries: turn.retries.length > 0 ? turn.retries : undefined,
      error: truncate(error, config.maxTextLength),
    },
  }

  writeLine(session, record)
  session.currentTurn = null
}

/**
 * Log a compaction event.
 * Called when context compaction occurs.
 * This starts a new conversation boundary.
 */
export function logCompaction(): void {
  if (!isConversationLoggingEnabled()) return
  const sessionID = getSessionId()
  const config = getConversationLoggingConfig()
  const session = getSession(sessionID, config.outputDir)

  // Start a new conversation after compaction
  session.conversationID = shortId()
  session.turnIndex = 0
}

/**
 * Clear the current turn state.
 * Called when the conversation is cleared or reset.
 */
export function clearCurrentTurn(): void {
  if (!isConversationLoggingEnabled()) return
  const sessionID = getSessionId()
  const config = getConversationLoggingConfig()
  const session = getSession(sessionID, config.outputDir)

  session.currentTurn = null
  session.conversationID = ''
  session.turnIndex = 0
}

// Re-export types for external use
export type { TurnStartRecord as TurnStartRecordType, TurnCompleteRecord as TurnCompleteRecordType }
