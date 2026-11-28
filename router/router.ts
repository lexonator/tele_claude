#!/usr/bin/env bun
/**
 * tele_claude router — единственный держатель токена бота.
 *
 * - long polling getUpdates (одно место на весь Mac);
 * - сессии Claude Code подключаются по unix-сокету (JSON-строки), регистрируются,
 *   и для каждой создаётся тема (forum topic) в супергруппе;
 * - входящее из темы уходит только в свою сессию; исходящее идёт в свою тему.
 *
 * Токен читается из файла и нигде не печатается.
 */
import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { createServer, connect, type Socket } from 'net'
import {
  readdirSync, openSync, readSync, closeSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync,
  statSync, realpathSync, chmodSync,
} from 'fs'
import { homedir } from 'os'
import { join, extname, sep } from 'path'
import { spawnSync } from 'child_process'
import { chunk, parseEnv, describeTool, PERMISSION_REPLY_RE, PHOTO_EXTS, type Msg } from '../shared.ts'

const HOME = homedir()
const STATE_DIR = process.env.TELE_STATE_DIR ?? join(HOME, '.tele_claude')
const SOCK = process.env.TELE_SOCK ?? join(STATE_DIR, 'router.sock')
const CONFIG_FILE = join(STATE_DIR, 'config.json')
const cfg0: { chat_id?: string; token_file?: string; access_file?: string; projects_dir?: string; allow_from?: Array<string | number> } = (() => { try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch { return {} } })()
const expand = (p: string) => p.replace(/^~(?=\/|$)/, HOME)
// Токен: ~/.tele_claude/.env (TELEGRAM_BOT_TOKEN=...) или другой файл из config.json (token_file).
const TOKEN_FILE = process.env.TELE_TOKEN_FILE ?? expand(cfg0.token_file ?? join(STATE_DIR, '.env'))
const ACCESS_FILE = process.env.TELE_ACCESS_FILE ?? (cfg0.access_file ? expand(cfg0.access_file) : '')
const PROJECTS_DIR = process.env.TELE_NEW_ROOT ?? expand(cfg0.projects_dir ?? join(HOME, 'Documents', 'Projects'))
const ROOT_DIR = join(import.meta.dir, '..')
const SESSIONS_FILE = join(STATE_DIR, 'sessions.json')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const API_ROOT = process.env.TELE_API_ROOT // для тестов с поддельным Telegram
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

const log = (s: string) => process.stderr.write(`[router ${new Date().toISOString()}] ${s}\n`)

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })

// ---------- конфиг, токен, доступ ----------
const TOKEN = process.env.TELE_BOT_TOKEN ?? parseEnv(readFileSync(TOKEN_FILE, 'utf8')).TELEGRAM_BOT_TOKEN
if (!TOKEN) { log(`нет TELEGRAM_BOT_TOKEN в ${TOKEN_FILE}`); process.exit(1) }

type Config = { chat_id: string }
const config: Config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
if (!config.chat_id) { log('в config.json нет chat_id'); process.exit(1) }
const GROUP = String(config.chat_id)

function allowedUsers(): string[] {
  // Кому можно писать боту: allow_from в config.json (id пользователей Telegram) или файл access.json с полем allowFrom.
  if (cfg0.allow_from?.length) return cfg0.allow_from.map(String)
  if (!ACCESS_FILE) return []
  try { return (JSON.parse(readFileSync(ACCESS_FILE, 'utf8')).allowFrom ?? []).map(String) } catch { return [] }
}

type Session = { key: string; name: string; dir: string; thread_id: number; created: number; title?: string; model?: string; local?: boolean }
let sessions: Record<string, Session> = {}
try { sessions = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) } catch {}
function saveSessions() {
  const tmp = SESSIONS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(sessions, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, SESSIONS_FILE)
}

// ---------- бот ----------
const bot = new Bot(TOKEN, API_ROOT ? { client: { apiRoot: API_ROOT } } : undefined)
let botUsername = ''

// ---------- подключённые клиенты ----------
type Client = { sock: Socket; key: string; buf: string; general?: boolean }
const clients = new Map<string, Client>() // key -> client
let generalKey = '' // главная сессия: её чат — общая тема (General)
const permOwner = new Map<string, string>() // request_id -> key
const offlineNoticeAt = new Map<number, number>() // thread_id -> ts

function send(sock: Socket, m: Msg) { if (!sock.destroyed) sock.write(JSON.stringify(m) + '\n') }
function pushTo(key: string, m: Msg): boolean {
  const c = clients.get(key)
  if (!c) return false
  send(c.sock, m)
  return true
}
const sessionByThread = (tid: number) => Object.values(sessions).find(s => s.thread_id === tid)

// ---------- темы ----------
function threadOf(c: Client): number | undefined {
  if (!c.key) throw new Error('not registered')
  if (c.general) return undefined
  const s = sessions[c.key]
  if (!s) throw new Error('not registered')
  return s.thread_id
}

// Название темы: своё (после /rename или ручного переименования) или имя папки, плюс «· модель».
function baseTitle(s: { name: string; dir: string; title?: string }) {
  const project = s.dir.split('/').filter(Boolean).pop() ?? 'session'
  return s.title ?? (s.name === 'main' ? project : `${project} — ${s.name}`)
}
// Название темы: имя проекта + модель. Переименовываем только при смене модели (каждое переименование Telegram пишет в тему служебную строку).
const topicTitle = (s: { name: string; dir: string; title?: string; model?: string }) => (s.model ? `${baseTitle(s)} · ${s.model}` : baseTitle(s)).slice(0, 128)
const stripModel = (t: string) => t.replace(/^(🟢|🔵|🟡|⚪️?)\s*/u, '').replace(/ · [^·]+$/, '')
const touchStatus = (_key: string) => {}

async function ensureTopic(key: string, name: string, dir: string): Promise<Session> {
  const existing = sessions[key]
  if (existing) {
    // Название темы не трогаем (пользователь мог переименовать), и в Telegram лишний раз не ходим:
    // иначе при перезапуске роутера 20 сессий разом упираются в лимит запросов.
    sessions[key] = { ...existing, name, dir }
    saveSessions()
    return sessions[key]!
  }
  const t = await bot.api.createForumTopic(GROUP, topicTitle({ name, dir }))
  const s: Session = { key, name, dir, thread_id: t.message_thread_id, created: Date.now() }
  sessions[key] = s
  saveSessions()
  log(`создана тема ${s.thread_id} для ${key}`)
  return s
}

// ---------- запрещённые для отправки файлы ----------
function assertSendable(f: string) {
  let real: string
  try { real = realpathSync(f) } catch { return } // statSync сам упадёт
  const guarded = [STATE_DIR, join(HOME, '.claude/channels')]
  for (const g of guarded) {
    let gr: string
    try { gr = realpathSync(g) } catch { continue }
    const inbox = join(gr, 'inbox')
    if (real.startsWith(gr + sep) && !real.startsWith(inbox + sep)) {
      throw new Error(`refusing to send channel state: ${f}`)
    }
  }
}

// ---------- «живой» статус сессии: анимация печати и что она сейчас делает ----------
type Act = { watch?: ReturnType<typeof setInterval>; hooked?: boolean; thread?: number; typing: ReturnType<typeof setInterval>; kill: ReturnType<typeof setTimeout>; msgId?: number; text: string; lastEdit: number; pending?: string; frame?: number; bumpAt?: number; bumpT?: ReturnType<typeof setTimeout> }
const activity = new Map<string, Act>()

// Номера сообщений-статусов храним на диске: если роутер перезапустят посреди работы,
// при старте удаляем «осиротевшие» строки статуса, чтобы они не оставались мусором в чате.
const STATUS_FILE = join(STATE_DIR, 'status-msgs.json')
const statusMsgs: Record<string, number> = {}
function saveStatus() { try { writeFileSync(STATUS_FILE, JSON.stringify(statusMsgs)) } catch {} }
function cleanOrphanStatuses() {
  try {
    const old = JSON.parse(readFileSync(STATUS_FILE, 'utf8')) as Record<string, number>
    for (const id of Object.values(old)) void bot.api.deleteMessage(GROUP, id).catch(() => {})
    writeFileSync(STATUS_FILE, '{}')
  } catch {}
}

// Строка статуса начинается с 🔵; анимация — «печатает…» в шапке и обновление текста действия.
const SPIN = ['🔵']
const modelTail = (key: string) => (sessions[key]?.model ? ` · ${sessions[key]!.model}` : '')
// Анимированный (custom) эмодзи для начала строки статуса: id хранится в ~/.tele_claude/status-emoji.id, задаётся командой /statusemoji.
const EMOJI_FILE = join(STATE_DIR, 'status-emoji.id')
let statusEmojiId = ''
try { statusEmojiId = readFileSync(EMOJI_FILE, 'utf8').trim() } catch {}
// Анимированные эмодзи под вид активности: берём из набора значков тем Telegram (они доступны ботам, многие анимированы).
const noVS = (x: string) => x.replace(/\uFE0F/g, '')
const iconIds = new Map<string, string>() // эмодзи -> custom_emoji_id
void bot.api.getForumTopicIconStickers().then(r => { if (Array.isArray(r)) for (const st of r) if (st.emoji && st.custom_emoji_id) iconIds.set(noVS(st.emoji), st.custom_emoji_id) }).catch(() => {})
// эмодзи в тексте статуса -> эмодзи из набора значков
const ACT_ICON: Array<[string, string]> = [['📖', '📚'], ['✏️', '✍️'], ['📝', '📝'], ['⚙️', '💻'], ['🔎', '🔎'], ['🌐', '🔭'], ['🤖', '🤖'], ['📋', '✅'], ['🔧', '⚡️'], ['💭', '🧠'], ['🟡', '❓'], ['🔐', '❗️'], ['❓', '❓']]
// Без своего значка: анимированные точки «•••» рядом с сообщением рисует сам Telegram («печатает…»), лишние картинки не нужны.
function renderStatusMsg(key: string, a: Act): { text: string; entities?: Array<{ type: 'custom_emoji'; offset: number; length: number; custom_emoji_id: string }> } {
  const tail = modelTail(key)
  if (statusEmojiId) return { text: `${SPIN[0]} ${a.text.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '')}${tail}`, entities: [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: statusEmojiId }] }
  return { text: `${a.text.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '')}${tail}` }
}

// Сообщение-«хвост», когда сессия не работает: стоит в самом низу темы и уходит, когда начинается новая работа.
const restMsgs = new Map<string, number>()
function restClear(key: string) {
  const id = restMsgs.get(key)
  if (id == null) return
  restMsgs.delete(key); delete statusMsgs['rest:' + key]; saveStatus()
  void bot.api.deleteMessage(GROUP, id).catch(() => {})
}
function restShow(key: string, thread: number | undefined, text: string) {
  restClear(key)
  void bot.api.sendMessage(GROUP, text, { ...withThread(thread), disable_notification: true })
    .then(m => {
      if (activity.has(key)) { void bot.api.deleteMessage(GROUP, m.message_id).catch(() => {}); return } // за это время началась новая работа
      restMsgs.set(key, m.message_id); statusMsgs['rest:' + key] = m.message_id; saveStatus()
    }).catch(() => {})
}
// Статус всегда последним: после нового сообщения в теме пересоздаём его внизу.
function bumpStatus(key: string) {
  const a = activity.get(key)
  if (!a || a.msgId == null || a.msgId < 0) return
  if (Date.now() - (a.bumpAt ?? 0) < 1600) { if (!a.bumpT) a.bumpT = setTimeout(() => { a.bumpT = undefined; bumpStatus(key) }, 1700); return }
  a.bumpAt = Date.now()
  const old = a.msgId, text = a.text
  a.msgId = undefined; a.text = ''
  void bot.api.deleteMessage(GROUP, old).catch(() => {})
  actSet(key, text)
}

const threadForKey = (key: string): number | undefined => clients.get(key)?.general ? undefined : sessions[key]?.thread_id
const withThread = (t?: number) => (t != null ? { message_thread_id: t } : {})

function actStart(key: string, text = '💭 Думаю…') {
  const prev = activity.get(key)
  if (prev) { actSet(key, text); return }
  restClear(key)
  const thread = threadForKey(key)
  const typing = setInterval(() => void bot.api.sendChatAction(GROUP, 'typing', withThread(thread)).catch(() => {}), 4000)
  const kill = setTimeout(() => actStop(key), 15 * 60_000) // страховка, если «стоп» не пришёл
  const a: Act = { thread, typing, kill, text: '', lastEdit: 0, hooked: true }
  activity.set(key, a)
  touchStatus(key)
  a.watch = watchTranscript(key)
  void bot.api.sendChatAction(GROUP, 'typing', withThread(thread)).catch(() => {})
  actSet(key, text)
}

function actSet(key: string, text: string) {
  const a = activity.get(key)
  if (process.env.TELE_DEBUG) log(`actSet ${key.split('/').pop()} active=${!!a} text=${text.slice(0, 60)}`)
  if (!a || a.text === text) return
  a.text = text
  const now = Date.now()
  if (a.msgId == null) {
    a.lastEdit = now
    a.msgId = -1 // занято: сообщение создаётся
    void bot.api.sendMessage(GROUP, renderStatusMsg(key, a).text, { ...withThread(a.thread), entities: renderStatusMsg(key, a).entities, disable_notification: true, reply_markup: stopKb(a.thread != null ? String(a.thread) : 'g') })
      .then(m => {
        const cur = activity.get(key)
        if (cur === a) { a.msgId = m.message_id; statusMsgs[key] = m.message_id; saveStatus(); if (a.text !== text) flushStatus(key) }
        else void bot.api.deleteMessage(GROUP, m.message_id).catch(() => {})
      })
      .catch(e => { log(`статус: sendMessage не удался: ${e}`); if (activity.get(key) === a) a.msgId = undefined })
    return
  }
  if (a.msgId < 0 || now - a.lastEdit < 1500) {
    a.pending = text
    setTimeout(() => flushStatus(key), 1600)
    return
  }
  flushStatus(key)
}

function flushStatus(key: string) {
  const a = activity.get(key)
  if (!a || a.msgId == null || a.msgId < 0) return
  if (Date.now() - a.lastEdit < 1500) return
  a.lastEdit = Date.now()
  a.pending = undefined
  void bot.api.editMessageText(GROUP, a.msgId, renderStatusMsg(key, a).text, { entities: renderStatusMsg(key, a).entities, reply_markup: stopKb(a.thread != null ? String(a.thread) : 'g') }).catch(e => { if (!/not modified/i.test(String(e))) log(`статус: edit не удался: ${e}`) })
}

// Читаем «хвост» журнала сессии Claude Code (jsonl): оттуда видно, какие инструменты вызываются,
// а иногда и ход рассуждений. Работает без хуков и без перезапуска сессии.
function newestTranscript(dir: string): string | undefined {
  const pd = join(process.env.TELE_PROJECTS_DIR ?? join(HOME, '.claude', 'projects'), dir.replace(/[^A-Za-z0-9]/g, '-'))
  try {
    let best: { f: string; t: number } | undefined
    for (const n of readdirSync(pd)) {
      if (!n.endsWith('.jsonl')) continue
      const f = join(pd, n), t = statSync(f).mtimeMs
      if (!best || t > best.t) best = { f, t }
    }
    return best?.f
  } catch { return undefined }
}

function watchTranscript(key: string): ReturnType<typeof setInterval> {
  const dir = key.split('::')[0]!
  let file = newestTranscript(dir)
  let offset = 0
  try { if (file) offset = statSync(file).size } catch {}
  let rest = ''
  return setInterval(() => {
    try {
      const latest = newestTranscript(dir)
      if (latest && latest !== file) { file = latest; try { offset = statSync(latest).size } catch { offset = 0 }; rest = '' } // новый файл читаем с конца, чтобы не проигрывать старое
      if (!file) return
      const size = statSync(file).size
      if (size <= offset) return
      const fd = openSync(file, 'r')
      const buf = Buffer.alloc(Math.min(size - offset, 1 << 20))
      readSync(fd, buf, 0, buf.length, offset); closeSync(fd)
      offset += buf.length
      const lines = (rest + buf.toString('utf8')).split('\n'); rest = lines.pop() ?? ''
      for (const line of lines) {
        let e: any; try { e = JSON.parse(line) } catch { continue }
        const msg = e?.message
        if (e?.type === 'assistant' && Array.isArray(msg?.content)) {
          for (const b of msg.content) {
            if (b.type === 'tool_use' && b.name === 'AskUserQuestion') { actSet(key, '❓ Жду вашего ответа'); askShow(key, String(b.id), b.input) }
            else if (b.type === 'tool_use') { const d = describeTool(b.name, b.input); if (d) actSet(key, d) }
            else if (b.type === 'thinking' && b.thinking) actSet(key, '💭 ' + String(b.thinking).replace(/\s+/g, ' ').trim().slice(-240))
          }
          if (msg.stop_reason === 'end_turn') actStop(key)
        } else if (e?.type === 'user' && JSON.stringify(msg?.content ?? '').includes('Request interrupted')) {
          actStop(key, 'int') // ход прерван (Esc)
        } else if (e?.type === 'user' && Array.isArray(msg?.content) && msg.content.some((b: any) => b.type === 'tool_result')) {
          // результат инструмента получен — модель снова думает (если не пришло ничего нового, строка останется как есть)
          for (const b of msg.content) if (b.type === 'tool_result') askDone(String(b.tool_use_id))
        }
      }
    } catch {}
  }, 700)
}

function actStop(key: string, rest: 'idle' | 'int' | 'off' = 'idle') {
  const a = activity.get(key)
  if (!a) return
  activity.delete(key)
  if (a.bumpT) clearTimeout(a.bumpT)
  clearInterval(a.typing); clearTimeout(a.kill); if (a.watch) clearInterval(a.watch)
  if (a.msgId != null && a.msgId > 0) void bot.api.deleteMessage(GROUP, a.msgId).catch(() => {})
  if (statusMsgs[key] != null) { delete statusMsgs[key]; saveStatus() }
}

// ---------- вопросы с выбором (AskUserQuestion): показываем кнопками, выбор жмём в терминале ----------
type AskQ = { question?: string; header?: string; multiSelect?: boolean; options?: Array<{ label?: string; description?: string }> }
type Ask = { key: string; toolId: string; thread?: number; q: AskQ; msgId?: number; other?: boolean }
const asks = new Map<number, Ask>()
let askSeq = 0

function askShow(key: string, toolId: string, input: any) {
  const qs: AskQ[] = Array.isArray(input?.questions) ? input.questions : []
  if (!qs.length) return
  const thread = threadForKey(key)
  const fmt = (q: AskQ) => `❓ ${q.header ? q.header + '\n' : ''}${q.question ?? ''}\n\n` +
    (q.options ?? []).map((o, i) => `${i + 1}. ${o.label ?? ''}${o.description ? ' — ' + o.description : ''}`).join('\n')
  if (qs.length !== 1 || qs[0]!.multiSelect) {
    // сложные формы (несколько вопросов или множественный выбор) кнопками пока не поддерживаем
    const text = qs.map(fmt).join('\n\n———\n\n') + '\n\nОтветьте в окне сессии: /show'
    void bot.api.sendMessage(GROUP, text.slice(0, 4000), withThread(thread)).then(() => { actSet(key, '🟡 Жду вашего решения'); bumpStatus(key) }).catch(() => {})
    return
  }
  const q = qs[0]!
  const id = ++askSeq
  const ask: Ask = { key, toolId, thread, q }
  asks.set(id, ask)
  touchStatus(key)
  const kb = new InlineKeyboard()
  ;(q.options ?? []).forEach((o, i) => kb.text(`${i + 1}. ${(o.label ?? '').slice(0, 50)}`, `ask:${id}:${i}`).row())
  kb.text('✍️ Другое (напишу текстом)', `ask:${id}:${(q.options ?? []).length}`)
  void bot.api.sendMessage(GROUP, fmt(q).slice(0, 4000), { ...withThread(thread), reply_markup: kb })
    .then(m => { ask.msgId = m.message_id; actSet(key, '🟡 Жду вашего решения'); bumpStatus(key) }).catch(e => log(`вопрос: не отправился: ${e}`))
}

// Ответили (в терминале или кнопкой): убираем кнопки.
function askDone(toolId: string, note = '✅ Отвечено') {
  for (const [id, a] of asks) {
    if (a.toolId !== toolId) continue
    asks.delete(id); touchStatus(a.key)
    if (a.msgId != null) void bot.api.editMessageReplyMarkup(GROUP, a.msgId, { reply_markup: new InlineKeyboard() }).catch(() => {})
    if (a.msgId != null) void bot.api.sendMessage(GROUP, note, { ...withThread(a.thread), reply_to_message_id: a.msgId, disable_notification: true }).catch(() => {})
  }
}

// Нажали кнопку: проверяем, что вопрос ещё на экране, и жмём стрелки + Enter в tmux-окне.
function askPress(id: number, idx: number): string {
  const a = asks.get(id)
  if (!a) return 'Вопрос уже закрыт'
  const name = tmuxNameFor({ dir: a.key.split('::')[0]! })
  if (!teleTmuxSessions().includes(name)) return 'У сессии нет tmux-окна, ответьте в терминале'
  const squash = (x: string) => x.replace(/\s+/g, '')
  const screen = squash(tmux('capture-pane', '-p', '-t', name).stdout ?? '')
  const probe = squash(a.q.options?.[0]?.label ?? a.q.question ?? '').slice(0, 15)
  if (!probe || !screen.includes(probe)) return 'Вопрос уже не на экране'
  const n = a.q.options?.length ?? 0
  const keys = [...Array(Math.min(idx, n)).fill('Down'), 'Enter']
  tmux('send-keys', '-t', name, ...keys)
  if (idx >= n) { a.other = true; return 'Напишите ответ следующим сообщением' }
  askDone(a.toolId, `✅ Выбрано: ${a.q.options![idx]!.label ?? idx + 1}`)
  return 'Выбрано'
}

// Следующее сообщение после «Другое» — это текст ответа.
function askText(key: string, text: string): boolean {
  for (const [id, a] of asks) {
    if (a.key !== key || !a.other) continue
    const name = tmuxNameFor({ dir: key.split('::')[0]! })
    if (!teleTmuxSessions().includes(name)) return false
    tmux('send-keys', '-t', name, '-l', text)
    tmux('send-keys', '-t', name, 'Enter')
    asks.delete(id); touchStatus(a.key)
    if (a.msgId != null) void bot.api.editMessageReplyMarkup(GROUP, a.msgId, { reply_markup: new InlineKeyboard() }).catch(() => {})
    return true
  }
  return false
}

// ---------- обработка запросов клиента ----------
async function handleOp(c: Client, m: Msg): Promise<unknown> {
  switch (m.op) {
    case 'register': {
      const key = String(m.key), name = String(m.name), dir = String(m.dir)
      const old = clients.get(key)
      if (old && old.sock !== c.sock) {
        log(`сессия ${key} подключилась повторно — старое соединение закрыто`)
        old.sock.destroy()
      }
      c.key = key
      if (m.general) {
        // главная сессия живёт в общей теме, своей темы не создаём
        c.general = true
        generalKey = key
        clients.set(key, c)
        log(`сессия ${key} онлайн как главная (General)`)
        return { chat_id: GROUP, thread_id: null, title: 'General' }
      }
      const s = await ensureTopic(key, name, dir)
      clients.set(key, c)
      touchStatus(key)
      log(`сессия ${key} онлайн (тема ${s.thread_id})`)
      return { chat_id: GROUP, thread_id: s.thread_id, title: topicTitle(s) }
    }
    case 'reply': {
      const thread = threadOf(c)
      const text = String(m.text ?? '')
      const files = (m.files as string[] | undefined) ?? []
      const replyTo = m.reply_to != null ? Number(m.reply_to) : undefined
      const parse_mode = m.format === 'markdownv2' ? ('MarkdownV2' as const) : undefined
      for (const f of files) {
        assertSendable(f)
        const st = statSync(f)
        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`file too large: ${f} (${(st.size / 1048576).toFixed(1)}MB, max 50MB)`)
        }
      }
      const ids: number[] = []
      const parts = chunk(text, 4096, 'length')
      try {
        for (let i = 0; i < parts.length; i++) {
          const sent = await bot.api.sendMessage(GROUP, parts[i]!, {
            ...(thread != null ? { message_thread_id: thread } : {}),
            ...(replyTo != null && i === 0 ? { reply_parameters: { message_id: replyTo } } : {}),
            ...(parse_mode ? { parse_mode } : {}),
          })
          ids.push(sent.message_id)
        }
      } catch (e) {
        throw new Error(`reply failed after ${ids.length} of ${parts.length} chunk(s) sent: ${e instanceof Error ? e.message : e}`)
      }
      for (const f of files) {
        const input = new InputFile(f)
        const opts = thread != null ? { message_thread_id: thread } : {}
        const sent = PHOTO_EXTS.has(extname(f).toLowerCase())
          ? await bot.api.sendPhoto(GROUP, input, opts)
          : await bot.api.sendDocument(GROUP, input, opts)
        ids.push(sent.message_id)
      }
      { const a = activity.get(c.key); if (a && !a.hooked) actStop(c.key) } // у сессии нет хуков — снимаем статус по ответу
      bumpStatus(c.key)
      return { ids }
    }
    case 'react': {
      // Реакции («лайки») отключены: ничего не ставим, но сессии отвечаем, что всё в порядке.
      return {}
    }
    case 'edit': {
      const parse_mode = m.format === 'markdownv2' ? ('MarkdownV2' as const) : undefined
      const r = await bot.api.editMessageText(GROUP, Number(m.message_id), String(m.text), parse_mode ? { parse_mode } : undefined)
      return { id: typeof r === 'object' ? r.message_id : m.message_id }
    }
    case 'download': {
      return { path: await downloadFile(String(m.file_id)) }
    }
    case 'permission_request': {
      const thread = threadOf(c)
      const id = String(m.request_id)
      permOwner.set(id, c.key); touchStatus(c.key)
      permDetails.set(id, { tool_name: String(m.tool_name), description: String(m.description), input_preview: String(m.input_preview) })
      const kb = new InlineKeyboard()
        .text('See more', `perm:more:${id}`)
        .text('✅ Allow', `perm:allow:${id}`)
        .text('❌ Deny', `perm:deny:${id}`)
      await bot.api.sendMessage(GROUP, `🔐 Permission: ${m.tool_name}`, { ...(thread != null ? { message_thread_id: thread } : {}), reply_markup: kb })
      actSet(c.key, `🟡 Жду разрешения: ${m.tool_name}`); bumpStatus(c.key)
      return {}
    }
    case 'activity': {
      // Приходит от хуков Claude Code (bin/tele-hook): сокет без регистрации, ключ в сообщении.
      const key = String(m.key ?? c.key)
      if (!clients.has(key)) return {}
      if (m.kind === 'stop') actStop(key)
      else { actStart(key, String(m.text || '💭 Думаю…').slice(0, 300)); const a = activity.get(key); if (a) a.hooked = true }
      return {}
    }
    case 'ping':
      return { pong: true }
    default:
      throw new Error(`unknown op: ${m.op}`)
  }
}
const permDetails = new Map<string, { tool_name: string; description: string; input_preview: string }>()

async function downloadFile(file_id: string, uniqueHint = 'dl'): Promise<string> {
  const file = await bot.api.getFile(file_id)
  if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
  const base = API_ROOT ?? 'https://api.telegram.org'
  const res = await fetch(`${base}/file/bot${TOKEN}/${file.file_path}`)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const ext = (file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin').replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const uid = (file.file_unique_id ?? uniqueHint).replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
  const path = join(INBOX_DIR, `${Date.now()}-${uid}.${ext}`)
  writeFileSync(path, buf)
  return path
}

// ---------- unix-сокет ----------
async function socketAlive(): Promise<boolean> {
  if (!existsSync(SOCK)) return false
  return new Promise(res => {
    const s = connect(SOCK)
    s.once('connect', () => { s.destroy(); res(true) })
    s.once('error', () => res(false))
  })
}
// Замок: если много клиентов одновременно запускают роутер, живёт только один.
const LOCK = join(STATE_DIR, 'router.lock')
for (let tries = 0; ; tries++) {
  try { writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); break } catch {}
  let holder = 0
  try { holder = parseInt(readFileSync(LOCK, 'utf8'), 10) } catch {}
  let alive = false
  if (holder > 1 && holder !== process.pid) { try { process.kill(holder, 0); alive = true } catch {} }
  if (alive) { log(`роутер уже запущен (pid ${holder}) — выхожу`); process.exit(0) }
  try { unlinkSync(LOCK) } catch {}
  if (tries > 5) { log('не удалось взять замок'); process.exit(1) }
}
if (await socketAlive()) { log('роутер уже запущен — выхожу'); process.exit(0) }
try { unlinkSync(SOCK) } catch {}

const server = createServer(sock => {
  const c: Client = { sock, key: '', buf: '' }
  sock.setEncoding('utf8')
  sock.on('data', (d: string) => {
    c.buf += d
    let i: number
    while ((i = c.buf.indexOf('\n')) >= 0) {
      const line = c.buf.slice(0, i); c.buf = c.buf.slice(i + 1)
      if (!line.trim()) continue
      let m: Msg
      try { m = JSON.parse(line) } catch { continue }
      handleOp(c, m).then(
        result => send(sock, { id: m.id, ok: true, result }),
        err => send(sock, { id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
      )
    }
  })
  const drop = () => {
    if (c.key && clients.get(c.key) === c) { actStop(c.key, 'off'); clients.delete(c.key); if (generalKey === c.key) generalKey = ''; log(`сессия ${c.key} отключилась`) }
  }
  sock.on('close', drop)
  sock.on('error', drop)
})
server.listen(SOCK, () => { chmodSync(SOCK, 0o600); log(`сокет ${SOCK}`) })
writeFileSync(join(STATE_DIR, 'router.pid'), String(process.pid))
cleanOrphanStatuses() // только после того, как взяли замок: единственный живой роутер

// ---------- входящее из Telegram ----------
const isAllowed = (id: number | undefined) => id != null && allowedUsers().includes(String(id))

async function handleInbound(ctx: any, text: string, dl?: () => Promise<string | undefined>, att?: Record<string, string>) {
  const from = ctx.from
  if (!isAllowed(from?.id)) return // чужим молча не отвечаем
  const chatType = ctx.chat?.type
  const chatId = String(ctx.chat.id)
  const tid: number | undefined = ctx.message?.message_thread_id

  const isGroup = (chatType === 'supergroup' || chatType === 'group') && chatId === GROUP
  const isDm = chatType === 'private'
  if (!isGroup && !isDm) return

  const rn = /^\/rename(@\w+)?\s+(.+)$/is.exec(text.trim())
  if (rn) {
    const say = (t: string) => bot.api.sendMessage(GROUP, t, withThread(tid)).catch(() => {})
    if (tid == null) return void (await say('Переименовать можно тему сессии: напишите /rename Новое название внутри неё. Общую тему General Telegram переименовать не даёт.'))
    const title = stripModel(rn[2]!.trim()).slice(0, 100)
    const ses = sessionByThread(tid)
    if (ses) { sessions[ses.key]!.title = title; saveSessions() }
    const full = ses ? topicTitle(sessions[ses.key]!) : title
    try { await bot.api.editForumTopic(GROUP, tid, { name: full }); return void (await say(`Переименовал: «${full}»`)) }
    catch (e) { return void (await say(`Не получилось переименовать: ${e}`)) }
  }
  if (/^\/rename(@\w+)?\s*$/i.test(text.trim())) return void (await bot.api.sendMessage(GROUP, 'Напишите новое название: /rename Новое название. Или переименуйте тему вручную (нажмите на название темы сверху → «Изменить»): бот это название не трогает.', withThread(tid)).catch(() => {}))
  if (/^\/statusemoji(@\w+)?(\s|$)/i.test(text)) {
    const say = (t: string) => bot.api.sendMessage(GROUP, t, withThread(tid)).catch(() => {})
    const ce = (ctx.message?.entities ?? []).find((e: any) => e.type === 'custom_emoji') as any
    if (/\boff\b/i.test(text)) { statusEmojiId = ''; try { unlinkSync(EMOJI_FILE) } catch {}; return void (await say('Вернул обычный 🔵 в строке статуса.')) }
    if (!ce) return void (await say('Отправьте команду вместе с анимированным эмодзи: /statusemoji и сразу за ним нужный эмодзи (нужен Telegram Premium). Вернуть обычный: /statusemoji off'))
    statusEmojiId = String(ce.custom_emoji_id); writeFileSync(EMOJI_FILE, statusEmojiId)
    return void (await say('Запомнил. Теперь строка статуса начинается с этого эмодзи (анимация видна в самой теме).'))
  }
  const mi = /^\/mirror(@\w+)?(?:\s+(on|off))?\s*$/i.exec(text.trim())
  if (mi) {
    const arg = mi[2]?.toLowerCase()
    if (arg === 'off') writeFileSync(MIRROR_OFF, '1'); else if (arg === 'on' || !arg) { try { unlinkSync(MIRROR_OFF) } catch {} }
    return void (await bot.api.sendMessage(GROUP, mirrorOn() ? '🖥 Зеркало включено: что набрано в окне терминала и ответы на это дублируются сюда. Отключить: /mirror off' : 'Зеркало выключено. Включить: /mirror on', withThread(tid)).catch(() => {}))
  }
  if (/^\/model(@\w+)?(\s|$)/i.test(text)) {
    const key = keyFor(tid)
    if (!key || !clients.has(key)) return void (await bot.api.sendMessage(GROUP, 'Для этой темы нет запущенной сессии.', withThread(tid)).catch(() => {}))
    const p = modelPanel(key, Number(ctx.chat.id), tid)
    return void (await bot.api.sendMessage(GROUP, p.text, { ...withThread(tid), reply_markup: p.kb }).catch(() => {}))
  }
  if (/^\/new(@\w+)?(\s|$)/i.test(text)) return void (await newCommand(Number(ctx.chat.id), tid))
  if (!text.startsWith('/') && !att && !dl && newFlow?.awaitName && (tid ?? undefined) === newFlow.thread && await newFolderName(text)) return

  if (/^\/(stop|esc)(@\w+)?(\s|$)/i.test(text)) {
    const key = keyFor(tid)
    const opts = tid != null ? { message_thread_id: tid } : {}
    const msg = key && clients.has(key) ? interrupt(key) : 'Для этой темы нет запущенной сессии.'
    if (key) actStop(key, 'int')
    return void (await bot.api.sendMessage(GROUP, msg, opts).catch(() => {}))
  }
  if (/^\/(screen|browser)(@\w+)?(\s|$)/i.test(text)) {
    const key = keyFor(tid)
    const opts = tid != null ? { message_thread_id: tid } : {}
    if (!key || !clients.has(key)) return void (await bot.api.sendMessage(GROUP, 'Для этой темы нет запущенной сессии.', opts).catch(() => {}))
    browserAsk(key, 'shot', from)
    await bot.api.sendMessage(GROUP, 'Браузер этой сессии. Делаю скриншот. Кнопки ниже управляют вкладкой, а любое действие можно написать словами: «нажми Войти», «введи …».', { ...opts, reply_markup: browserPanel(tid != null ? String(tid) : 'g') }).catch(() => {})
    return
  }
  if (/^\/windows(@\w+)?(\s|$)/i.test(text) || (/^\/(show|hide)(@\w+)?\s*$/i.test(text) && tid == null)) {
    const p = windowsPanel()
    return void (await bot.api.sendMessage(ctx.chat.id, p.text, { ...(tid != null ? { message_thread_id: tid } : {}), reply_markup: p.kb }).catch(() => {}))
  }
  if (/^\/(show|hide|hideall)(@\w+)?(\s|$)/i.test(text)) return void (await windowCommand(ctx, text, tid))

  // служебные команды: в общей теме или в личке
  if (isDm || tid == null || !sessionByThread(tid)) {
    if (/^\/(sessions|help|start)(@\w+)?\b/.test(text)) return void (await serviceCommand(ctx, text, tid))
    // обычное сообщение в General — главной сессии
    if (isGroup && tid == null && generalKey && clients.has(generalKey)) {
      if (!att && !dl && askText(generalKey, text)) return
      actStart(generalKey)
      const imagePath = dl ? await dl() : undefined
      pushTo(generalKey, {
        event: 'inbound', content: text,
        meta: {
          chat_id: GROUP, message_id: String(ctx.message.message_id),
          user: from.username ?? String(from.id), user_id: String(from.id),
          ts: new Date((ctx.message.date ?? 0) * 1000).toISOString(),
          ...(imagePath ? { image_path: imagePath } : {}), ...(att ?? {}),
        },
      })
      return
    }
    if (isGroup && tid != null) return // тема без сессии (чужая тема) — молчим
    if (isDm) {
      await ctx.reply('Пишите в темы группы: у каждой сессии Claude своя тема. Команда /sessions покажет список.')
    }
    return
  }

  const s = sessionByThread(tid)!
  const msgId = ctx.message.message_id as number

  const perm = PERMISSION_REPLY_RE.exec(text)
  if (perm && clients.has(s.key)) {
    const behavior = perm[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
    pushTo(s.key, { event: 'permission', request_id: perm[2]!.toLowerCase(), behavior })
    permOwner.delete(perm[2]!.toLowerCase()); touchStatus(s.key)
    return
  }

  if (!clients.has(s.key)) {
    const last = offlineNoticeAt.get(tid) ?? 0
    if (Date.now() - last > 60_000) {
      offlineNoticeAt.set(tid, Date.now())
      await bot.api.sendMessage(GROUP, 'Эта сессия сейчас не запущена. Запустите её: tele-claude ' + s.dir + (s.name !== 'main' ? ` --name ${s.name}` : ''), { message_thread_id: tid }).catch(() => {})
    }
    return
  }

  if (!att && !dl && askText(s.key, text)) return
  actStart(s.key)
  const imagePath = dl ? await dl() : undefined
  pushTo(s.key, {
    event: 'inbound',
    content: text,
    meta: {
      chat_id: GROUP,
      thread_id: String(tid),
      message_id: String(msgId),
      user: from.username ?? String(from.id),
      user_id: String(from.id),
      ts: new Date((ctx.message.date ?? 0) * 1000).toISOString(),
      ...(imagePath ? { image_path: imagePath } : {}),
      ...(att ?? {}),
    },
  })
}

// ---------- окна терминала (tmux) ----------
const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find(p => existsSync(p)) ?? 'tmux'
const tmux = (...a: string[]) => spawnSync(TMUX, a, { encoding: 'utf8' })
function teleTmuxSessions(): string[] {
  const r = tmux('list-sessions', '-F', '#{session_name}')
  return r.status === 0 ? r.stdout.split('\n').filter(n => n.startsWith('tele-')) : []
}
function attachedClients(name: string): number {
  const r = tmux('list-clients', '-t', name)
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean).length : 0
}
function tmuxNameFor(s: { dir: string }) {
  return 'tele-' + (s.dir.split('/').filter(Boolean).pop() ?? 'main').replace(/[^A-Za-z0-9_-]/g, '_')
}
// Ищем tmux-сессию по аргументу (часть имени) или по теме, откуда пришла команда.
function resolveWindow(arg: string, tid?: number): { name?: string; error?: string } {
  const all = teleTmuxSessions()
  const a = arg.trim().toLowerCase().replace(/^tele-/, '')
  if (a) {
    const hit = all.filter(n => n.toLowerCase().includes(a))
    const exact = all.find(n => n.toLowerCase() === 'tele-' + a)
    if (exact) return { name: exact }
    if (hit.length === 1) return { name: hit[0] }
    if (hit.length > 1) return { error: 'Подходит несколько: ' + hit.join(', ') }
    return { error: `Нет сессии «${arg}». Доступные: ${all.join(', ') || 'пока нет'}` }
  }
  const s = tid != null ? sessionByThread(tid) : generalKey ? { dir: generalKey.split('::')[0]! } : undefined
  if (!s) return { error: 'Укажите имя: /show <имя>. Доступные: ' + (all.join(', ') || 'пока нет') }
  const name = tmuxNameFor(s)
  return all.includes(name) ? { name } : { error: `У этой сессии нет tmux-окна (${name}). Она запущена не через tmux.` }
}
// ---------- /new: пошаговый запуск сессии в нужной папке ----------
type NewFlow = { chat: number; thread?: number; dirs: string[]; dir?: string; awaitName?: boolean }
let newFlow: NewFlow | undefined
const shq = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`
const fmtDate = (ms: number) => new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

function projectDirs(): string[] {
  try {
    return readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => { const p = join(PROJECTS_DIR, d.name); const t = newestTranscript(p); let m = 0; try { if (t) m = statSync(t).mtimeMs } catch {}; return { p, m } })
      .sort((a, b) => b.m - a.m || a.p.localeCompare(b.p))
      .map(x => x.p)
  } catch { return [] }
}
const isRunning = (dir: string) => teleTmuxSessions().includes(tmuxNameFor({ dir }))

function newFolderPanel(page: number): { text: string; kb: InlineKeyboard } {
  const f = newFlow!
  f.dirs = projectDirs(); f.dir = undefined; f.awaitName = false
  const per = 8, pages = Math.max(1, Math.ceil(f.dirs.length / per))
  page = Math.min(Math.max(0, page), pages - 1)
  const kb = new InlineKeyboard()
  f.dirs.slice(page * per, page * per + per).forEach((d, i) => {
    kb.text(`${isRunning(d) ? '🟢' : '📁'} ${d.split('/').pop()}`, `nw:d:${page * per + i}`)
    if (i % 2 === 1) kb.row()
  })
  kb.row()
  if (page > 0) kb.text('◀️', `nw:p:${page - 1}`)
  kb.text(`${page + 1}/${pages}`, 'nw:p:' + page)
  if (page < pages - 1) kb.text('▶️', `nw:p:${page + 1}`)
  kb.row().text('➕ Создать новую папку', 'nw:c').text('✖️ Отмена', 'nw:x')
  return { text: `Шаг 1. В какой папке запустить сессию?\n(папки из ${PROJECTS_DIR.replace(HOME, '~')}; 🟢 — уже запущена, сначала те, где недавно работали)`, kb }
}

function newModePanel(dir: string): { text: string; kb: InlineKeyboard } {
  const kb = new InlineKeyboard()
  const t = newestTranscript(dir)
  let text = `Шаг 2. Папка ${dir.replace(HOME, '~')}.\n`
  if (t) {
    let m = 0; try { m = statSync(t).mtimeMs } catch {}
    text += `Здесь уже была сессия (последняя работа ${fmtDate(m)}). Продолжить её с прежним контекстом или начать с нуля?`
    kb.text('▶️ Продолжить прошлую', 'nw:s:r').row().text('🆕 Начать с нуля', 'nw:s:n')
  } else {
    text += 'Сессий здесь ещё не было. Запускаю новую?'
    kb.text('🚀 Запустить', 'nw:s:n')
  }
  kb.row().text('◀️ Назад', 'nw:p:0').text('✖️ Отмена', 'nw:x')
  return { text, kb }
}

async function newLaunch(dir: string, resume: boolean, o: { model?: string; local?: boolean; key?: string } = {}): Promise<string> {
  const name = tmuxNameFor({ dir })
  if (teleTmuxSessions().includes(name)) return `Сессия ${name} уже запущена. Её тема в группе; окно: /show ${name.replace(/^tele-/, '')}`
  const t = newestTranscript(dir)
  const sid = resume && t ? t.split('/').pop()!.replace(/\.jsonl$/, '') : ''
  const sname = o.key?.split('::')[1]
  const env = o.local && o.model
    ? `env ANTHROPIC_BASE_URL=http://127.0.0.1:11434 ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY= ANTHROPIC_CUSTOM_MODEL_OPTION=${shq(o.model)} ANTHROPIC_CUSTOM_MODEL_OPTION_NAME=${shq(o.model)} ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES=thinking ANTHROPIC_DEFAULT_SONNET_MODEL=${shq(o.model)} ANTHROPIC_DEFAULT_OPUS_MODEL=${shq(o.model)} ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen-fast:latest CLAUDE_CODE_SUBAGENT_MODEL=qwen-fast:latest CLAUDE_CODE_MAX_CONTEXT_TOKENS=65536 DISABLE_AUTOUPDATER=1 `
    : ''
  const cmd = `${env}${shq(join(ROOT_DIR, 'bin', 'tele-claude'))} ${shq(dir)}${sname && sname !== 'main' ? ' --name ' + shq(sname) : ''}${o.key && o.key === generalKey ? ' --main' : ''}${sid ? ' --resume ' + sid : ''}${o.model ? ' --model ' + shq(o.model) : ''}`
  const r = tmux('new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', dir, cmd)
  if (r.status !== 0) return `Не получилось запустить: ${(r.stderr || '').trim().slice(0, 200)}`
  // Отвечаем на стартовые вопросы Claude Code по тому, что видно на экране (вслепую Enter мог выбрать «Нет, выйти»).
  let seenChannel = false
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(1500)
    if (!teleTmuxSessions().includes(name)) return 'Сессия сразу закрылась. Запустите вручную и посмотрите, что пишет: tele-claude ' + dir
    const scr = tmux('capture-pane', '-p', '-t', name).stdout ?? ''
    if (/trust this folder/.test(scr)) tmux('send-keys', '-t', name, 'Down', 'Enter') // курсор стоит на «No, exit»
    else if (/I am using this for local development/.test(scr)) { tmux('send-keys', '-t', name, 'Enter'); seenChannel = true }
    else if (seenChannel) break
    else if (/\? for shortcuts|bypass permissions|auto mode on/.test(scr)) break
  }
  return `Запустил ${dir.replace(HOME, '~')}${sid ? ' (с прежним контекстом)' : ''}. Тема «${dir.split('/').pop()} — main» появится в группе через пару секунд. Окно: /show ${name.replace(/^tele-/, '')}`
}

async function newCommand(chat: number, thread?: number) {
  newFlow = { chat, thread, dirs: [] }
  const p = newFolderPanel(0)
  await bot.api.sendMessage(chat, p.text, { ...withThread(thread), reply_markup: p.kb }).catch(() => {})
}

// Имя новой папки пришло текстом.
async function newFolderName(text: string): Promise<boolean> {
  const f = newFlow
  if (!f?.awaitName) return false
  const say = (t: string, extra: object = {}) => bot.api.sendMessage(f.chat, t, { ...withThread(f.thread), ...extra }).catch(() => {})
  const name = text.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(name)) { await say('Имя папки: латинские буквы, цифры, точка, дефис, подчёркивание, без пробелов. Напишите другое или нажмите «Отмена» в сообщении выше.'); return true }
  const dir = join(PROJECTS_DIR, name)
  if (existsSync(dir)) { await say(`Папка ${name} уже есть. Напишите другое имя.`); return true }
  try { mkdirSync(dir, { recursive: true }) } catch (e) { await say(`Не смог создать папку: ${e}`); return true }
  f.awaitName = false
  await say(`Создал ${dir.replace(HOME, '~')}. Запускаю…`)
  await say(await newLaunch(dir, false))
  newFlow = undefined
  return true
}

async function newCallback(ctx: any, d: string) {
  const f = newFlow
  const ans = (t?: string) => ctx.answerCallbackQuery({ text: t }).catch(() => {})
  if (!f) return void (await ans('Начните заново: /new'))
  const edit = (p: { text: string; kb: InlineKeyboard }) => ctx.editMessageText(p.text, { reply_markup: p.kb }).catch(() => {})
  const [, act, arg] = d.split(':') as [string, string, string]
  if (act === 'x') { newFlow = undefined; await ctx.editMessageText('Отменено.').catch(() => {}); return void (await ans()) }
  if (act === 'p') { await edit(newFolderPanel(Number(arg))); return void (await ans()) }
  if (act === 'c') {
    f.awaitName = true
    await ctx.editMessageText(`Шаг 2. Напишите имя новой папки одним сообщением (латиницей, без пробелов). Создам её в ${PROJECTS_DIR.replace(HOME, '~')} и запущу там сессию.`, { reply_markup: new InlineKeyboard().text('✖️ Отмена', 'nw:x') }).catch(() => {})
    return void (await ans())
  }
  if (act === 'd') {
    const dir = f.dirs[Number(arg)]
    if (!dir) return void (await ans('Список устарел, начните заново: /new'))
    if (isRunning(dir)) { await ctx.editMessageText(`${dir.replace(HOME, '~')}: сессия уже запущена, её тема в группе. Окно: /show ${tmuxNameFor({ dir }).replace(/^tele-/, '')}`).catch(() => {}); newFlow = undefined; return void (await ans()) }
    f.dir = dir
    await edit(newModePanel(dir)); return void (await ans())
  }
  if (act === 's' && f.dir) {
    const dir = f.dir
    await ctx.editMessageText(`Запускаю ${dir.replace(HOME, '~')}… (около 10 секунд)`).catch(() => {})
    await ans('Запускаю')
    const msg = await newLaunch(dir, arg === 'r')
    newFlow = undefined
    await bot.api.sendMessage(f.chat, msg, withThread(f.thread)).catch(() => {})
    return
  }
  await ans()
}

// ---------- зеркало: переписка в окне терминала дублируется в тему ----------
// Ход, начатый из Telegram, уже виден в теме (ответ идёт через reply), поэтому дублируем только то, что набрано в терминале.
const MIRROR_OFF = join(STATE_DIR, 'mirror.off')
const mirrorOn = () => !existsSync(MIRROR_OFF)
type Mir = { file?: string; offset: number; rest: string; mode: 'tg' | 'term' }
const mirrors = new Map<string, Mir>()
const mirrorQueue: Array<{ key: string; thread?: number; text: string }> = []
setInterval(() => {
  const m = mirrorQueue.shift()
  if (!m) return
  bot.api.sendMessage(GROUP, m.text, { ...withThread(m.thread), disable_notification: true }).then(() => bumpStatus(m.key)).catch(e => {
    if (/retry after|Too Many/i.test(String(e))) mirrorQueue.unshift(m); else log(`зеркало: ${e}`)
  })
}, 1300)
function mirrorSend(key: string, text: string) {
  const thread = threadForKey(key)
  for (const part of chunk(text, 3900, 'newline')) mirrorQueue.push({ key, thread, text: part })
}
function mirrorText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  if (content.some((b: any) => b?.type === 'tool_result')) return ''
  return content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
}
function mirrorTick() {
  const on = mirrorOn()
  for (const key of clients.keys()) {
    try {
      const dir = key.split('::')[0]!
      let m = mirrors.get(key)
      const file = newestTranscript(dir)
      if (!file) continue
      if (!m) { m = { file, offset: statSync(file).size, rest: '', mode: 'tg' }; mirrors.set(key, m); continue } // первое знакомство: историю не пересылаем
      if (m.file !== file) { m.file = file; m.offset = 0; m.rest = '' } // новый файл журнала читаем с начала
      const size = statSync(file).size
      if (size <= m.offset) continue
      const fd = openSync(file, 'r'); const buf = Buffer.alloc(Math.min(size - m.offset, 1 << 20))
      readSync(fd, buf, 0, buf.length, m.offset); closeSync(fd); m.offset += buf.length
      const lines = (m.rest + buf.toString('utf8')).split('\n'); m.rest = lines.pop() ?? ''
      let busy: boolean | undefined, what: string | undefined
      for (const line of lines) {
        let e: any; try { e = JSON.parse(line) } catch { continue }
        if (e?.isSidechain || e?.isMeta) continue
        // Видим, что сессия работает, даже если задание дали не через Telegram (терминал, цикл, подагенты).
        if (e?.type === 'assistant') {
          busy = e.message?.stop_reason === 'end_turn' ? false : true
          for (const b of Array.isArray(e.message?.content) ? e.message.content : []) if (b?.type === 'tool_use') what = describeTool(b.name, b.input) ?? what
        }
        else if (e?.type === 'user' && Array.isArray(e.message?.content) && e.message.content.some((b: any) => b?.type === 'tool_result')) busy = true
        else if (e?.type === 'user' && JSON.stringify(e.message?.content ?? '').includes('Request interrupted')) busy = false
        if (!on) continue
        if (e?.type === 'user') {
          const t = mirrorText(e.message?.content).trim()
          if (!t) continue
          if (t.includes('<channel source=')) { m.mode = 'tg'; continue }
          if (t.startsWith('<') || t.startsWith('[Request interrupted') || t.startsWith('Caveat:')) continue
          m.mode = 'term'
          mirrorSend(key, `🖥 Из терминала:\n${t}`)
          actStart(key)
        } else if (e?.type === 'assistant' && m.mode === 'term' && Array.isArray(e.message?.content)) {
          for (const b of e.message.content) if (b?.type === 'text' && String(b.text ?? '').trim()) mirrorSend(key, `🤖 ${String(b.text).trim()}`)
        }
      }
      if (busy && !activity.has(key)) actStart(key, what ?? '💭 Думаю…')
    } catch {}
  }
}
setInterval(mirrorTick, 1500)

// ---------- модель сессии: подпись в названии темы и команда /model ----------
function modelShort(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  if (m) return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`
  return id.replace(/^.*\//, '').split(':')[0]!
}
function readModel(dir: string): string | undefined {
  const f = newestTranscript(dir)
  if (!f) return undefined
  try {
    const size = statSync(f).size, len = Math.min(size, 300_000)
    const fd = openSync(f, 'r'); const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, size - len); closeSync(fd)
    const all = [...buf.toString('utf8').matchAll(/"model":"([^"]+)"/g)].map(x => x[1]!).filter(x => !x.startsWith('<'))
    return all[all.length - 1]
  } catch { return undefined }
}
const renameQueue: string[] = []
function queueRename(key: string) { if (!renameQueue.includes(key)) renameQueue.push(key) }
setInterval(() => {
  const key = renameQueue.shift()
  const s = key ? sessions[key] : undefined
  if (!key || !s || key === generalKey || clients.get(key)?.general) return
  bot.api.editForumTopic(GROUP, s.thread_id, { name: topicTitle(s) }).catch(e => {
    const m = /retry after (\d+)/.exec(String(e))
    if (m) { renameQueue.unshift(key); setTimeout(() => {}, 0) }
    else if (!/NOT_MODIFIED/.test(String(e))) log(`переименование темы: ${e}`)
  })
}, 2500)
function refreshModels() {
  for (const key of clients.keys()) {
    const s = sessions[key]
    if (!s || clients.get(key)?.general) continue
    touchStatus(key)
    const id = readModel(s.dir)
    if (!id) continue
    const short = modelShort(id)
    if (s.model !== short) { s.model = short; s.local = !id.startsWith('claude'); saveSessions(); queueRename(key) }
  }
}
setInterval(refreshModels, 20_000)
setTimeout(refreshModels, 8_000)

// Если название темы поменял человек, запоминаем его как основное (без подписи модели).
bot.on('message:forum_topic_edited', ctx => {
  const name = ctx.message.forum_topic_edited?.name
  const tid = ctx.message.message_thread_id
  if (!name || tid == null || ctx.from?.is_bot) return
  const ses = sessionByThread(tid)
  if (ses) { sessions[ses.key]!.title = stripModel(name); saveSessions() }
})

type ModelOpt = { label: string; id: string; local: boolean }
let modelFlow: { key: string; chat: number; thread?: number; opts: ModelOpt[] } | undefined
const CLOUD_MODELS: ModelOpt[] = [
  { label: 'Opus 5.5', id: 'claude-opus-5-5', local: false },
  { label: 'Sonnet 5.5', id: 'claude-sonnet-5-5', local: false },
  { label: 'Haiku 5.5', id: 'claude-haiku-5-5', local: false },
  { label: 'Fable 5.2', id: 'claude-fable-5-2', local: false },
]
function localModels(): ModelOpt[] {
  const r = spawnSync('ollama', ['list'], { encoding: 'utf8', env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` } })
  if (r.status !== 0) return []
  return r.stdout.split('\n').slice(1).map(l => l.split(/\s+/)[0]!).filter(Boolean).map(id => ({ label: id.replace(/^.*\//, ''), id, local: true }))
}
function modelPanel(key: string, chat: number, thread?: number): { text: string; kb: InlineKeyboard } {
  const s = sessions[key]
  const opts = [...CLOUD_MODELS, ...localModels()]
  modelFlow = { key, chat, thread, opts }
  const kb = new InlineKeyboard()
  opts.forEach((o, i) => { kb.text(`${o.local ? '🏠' : '☁️'} ${o.label}`, `md:${i}`); if (i % 2 === 1 || i === CLOUD_MODELS.length - 1) kb.row() })
  kb.row().text('✖️ Отмена', 'md:x')
  const cur = s?.model ? `${s.local ? '🏠' : '☁️'} ${s.model}` : 'пока неизвестна (появится после первого ответа)'
  return { text: `Модель этой сессии: ${cur}.\n\n☁️ Claude: переключается на лету командой /model в окне сессии (лучше, когда сессия не занята).\n🏠 Локальные (Ollama) и возврат с локальной на Claude: сессия перезапускается с тем же контекстом, около 15 секунд.`, kb }
}

async function modelSwitch(opt: ModelOpt): Promise<string> {
  const f = modelFlow!
  const s = sessions[f.key]
  const dir = f.key.split('::')[0]!
  const name = tmuxNameFor({ dir })
  if (!teleTmuxSessions().includes(name)) return 'У сессии нет tmux-окна. Запустите её через /new.'
  if (!opt.local && !s?.local) {
    tmux('send-keys', '-t', name, '-l', `/model ${opt.id}`); tmux('send-keys', '-t', name, 'Enter')
    if (s) { s.model = modelShort(opt.id); saveSessions(); queueRename(f.key) }
    return `Отправил в окно: /model ${opt.id}. Если сессия была занята, команда сработает после ответа.`
  }
  if (opt.local && spawnSync('curl', ['-sf', '-m', '3', 'http://127.0.0.1:11434/api/version']).status !== 0) {
    spawnSync('open', ['-a', 'Ollama']); await Bun.sleep(6000)
    if (spawnSync('curl', ['-sf', '-m', '3', 'http://127.0.0.1:11434/api/version']).status !== 0) return 'Ollama не отвечает. Запустите приложение Ollama и повторите.'
  }
  tmux('kill-session', '-t', name)
  await Bun.sleep(1500)
  const msg = await newLaunch(dir, true, { model: opt.id, local: opt.local, key: f.key })
  if (s) { s.model = modelShort(opt.id); s.local = opt.local; saveSessions(); queueRename(f.key) }
  return msg
}

// ---------- управление вкладкой Chrome через Telegram ----------
const BROWSER_ACTIONS: Record<string, [string, string]> = {
  shot: ['📸 Скриншот', 'Сделай скриншот текущей вкладки в Chrome'],
  up: ['⬆️ Вверх', 'Прокрути текущую вкладку в Chrome вверх на экран, затем сделай скриншот'],
  down: ['⬇️ Вниз', 'Прокрути текущую вкладку в Chrome вниз на экран, затем сделай скриншот'],
  back: ['◀️ Назад', 'В текущей вкладке Chrome вернись назад по истории, затем сделай скриншот'],
  reload: ['🔁 Обновить', 'Перезагрузи текущую вкладку в Chrome, подожди загрузки, затем сделай скриншот'],
}
function browserPanel(ref: string): InlineKeyboard {
  const kb = new InlineKeyboard()
  const ks = Object.keys(BROWSER_ACTIONS)
  ks.forEach((k, i) => { kb.text(BROWSER_ACTIONS[k]![0], `br:${k}:${ref}`); if (i === 2) kb.row() })
  return kb
}
// Просим сессию выполнить действие в браузере (инструменты Claude in Chrome есть у самой сессии).
function browserAsk(key: string, act: string, from: { id: number; username?: string }): boolean {
  const a = BROWSER_ACTIONS[act]
  if (!a) return false
  const text = `[Telegram: управление браузером] ${a[1]} и пришли его картинкой через reply (files). Одной строкой скажи, что на странице и что можно сделать дальше. Если вкладки нет, скажи об этом.`
  actStart(key)
  return pushTo(key, {
    event: 'inbound', content: text,
    meta: { chat_id: GROUP, ...(sessions[key] && !clients.get(key)?.general ? { thread_id: String(sessions[key]!.thread_id) } : {}),
      user: from.username ?? String(from.id), user_id: String(from.id), ts: new Date().toISOString() },
  })
}
function keyFor(tid?: number): string | undefined {
  if (tid != null) return sessionByThread(tid)?.key
  return generalKey || undefined
}

// Аналог Esc: отправляем клавишу Escape в tmux-окно сессии — Claude Code прерывает текущий ход.
function interrupt(key: string): string {
  const dir = key.split('::')[0]!
  const name = tmuxNameFor({ dir })
  if (!teleTmuxSessions().includes(name)) return 'У этой сессии нет tmux-окна, прервать не могу.'
  tmux('send-keys', '-t', name, 'Escape')
  return 'Отправил Esc: сессия прервёт текущее действие.'
}
const stopKb = (ref: string) => new InlineKeyboard().text('⛔ Прервать', `stop:${ref}`)

function windowsPanel(): { text: string; kb: InlineKeyboard } {
  const all = teleTmuxSessions().filter(n => n.length <= 55)
  const kb = new InlineKeyboard()
  const open = all.filter(n => attachedClients(n) > 0).length
  all.forEach((n, i) => {
    kb.text(`${attachedClients(n) > 0 ? '🪟' : '▫️'} ${n.replace(/^tele-/, '')}`, `win:t:${n}`)
    if (i % 2 === 1) kb.row()
  })
  kb.row().text('🔄 Обновить', 'win:r').text('🙈 Скрыть все', 'win:h')
  const text = all.length
    ? `Окна сессий. Нажмите на имя, чтобы открыть или скрыть.\n🪟 открыто: ${open}   ▫️ скрыто: ${all.length - open}`
    : 'Сессий в tmux пока нет.'
  return { text, kb }
}

async function windowCommand(ctx: any, text: string, tid?: number) {
  const m = /^\/(show|hide|hideall)(?:@\w+)?(?:\s+(.+))?$/i.exec(text.trim())!
  const cmd = m[1]!.toLowerCase(), arg = m[2] ?? ''
  const say = (t: string) => bot.api.sendMessage(ctx.chat.id, t, tid != null ? { message_thread_id: tid } : {}).catch(() => {})
  if (cmd === 'hideall') {
    const all = teleTmuxSessions().filter(n => attachedClients(n) > 0)
    for (const n of all) tmux('detach-client', '-s', n)
    return void (await say(all.length ? `Скрыл окна: ${all.length}. Сессии работают.` : 'Открытых окон нет.'))
  }
  if (cmd !== 'hideall' && !arg.trim() && (tid == null || !sessionByThread(tid)) && !generalKey) {
    const p = windowsPanel()
    return void (await bot.api.sendMessage(ctx.chat.id, p.text, { ...(tid != null ? { message_thread_id: tid } : {}), reply_markup: p.kb }).catch(() => {}))
  }
  const r = resolveWindow(arg, tid)
  if (!r.name) return void (await say(r.error!))
  if (cmd === 'hide') {
    if (!attachedClients(r.name)) return void (await say(`Окно ${r.name} и так не открыто.`))
    tmux('detach-client', '-s', r.name)
    return void (await say(`Скрыл окно ${r.name}. Сессия работает.`))
  }
  if (attachedClients(r.name)) return void (await say(`Окно ${r.name} уже открыто.`))
  const script = `tell application "Terminal"\nactivate\ndo script "${TMUX} attach -t ${r.name}; exit"\nend tell`
  const o = spawnSync('osascript', ['-e', script], { encoding: 'utf8' })
  await say(o.status === 0 ? `Открыл окно ${r.name}.` : `Не получилось открыть окно: ${(o.stderr || '').trim().slice(0, 200)}`)
}

async function serviceCommand(ctx: any, text: string, tid?: number) {
  const opts = tid != null ? { message_thread_id: tid } : {}
  const chatId = ctx.chat.id
  if (/^\/sessions/.test(text)) {
    const list = Object.values(sessions)
    const lines = list.length
      ? list.map(s => `${clients.has(s.key) ? '🟢' : '⚪️'} ${topicTitle(s)}`).join('\n')
      : 'Сессий пока нет.'
    await bot.api.sendMessage(chatId, lines + '\n\n🟢 запущена, ⚪️ не запущена', opts)
  } else {
    await bot.api.sendMessage(chatId, 'У каждой сессии Claude Code своя тема. Пишите в тему, и сообщение попадёт только в эту сессию.\n\n/mirror on|off — дублировать переписку из терминала\n/model — сменить модель (Claude или локальная)\n/rename <название> — переименовать тему\n/new — запустить сессию в нужной папке (по шагам)\n/windows — окна кнопками\n/sessions — список сессий\n/show <имя> — открыть окно терминала с сессией (в теме сессии имя не нужно)\n/hide <имя> — скрыть окно, сессия продолжит работать\n/hideall — скрыть все окна', opts)
  }
}

const safeName = (s?: string) => s?.replace(/[<>\[\]\r\n;]/g, '_')

bot.on('message:text', ctx => handleInbound(ctx, ctx.message.text))
bot.on('message:photo', ctx => {
  const best = ctx.message.photo[ctx.message.photo.length - 1]!
  return handleInbound(ctx, ctx.message.caption ?? '(photo)', async () => {
    try { return await downloadFile(best.file_id, best.file_unique_id) } catch (e) { log(`photo download failed: ${e}`); return undefined }
  })
})
const fileKinds: Array<[string, (m: any) => any, (m: any) => string]> = [
  ['document', m => m.document, m => `(document: ${safeName(m.document.file_name) ?? 'file'})`],
  ['voice', m => m.voice, () => '(voice message)'],
  ['audio', m => m.audio, m => `(audio: ${safeName(m.audio.title) ?? safeName(m.audio.file_name) ?? 'audio'})`],
  ['video', m => m.video, () => '(video)'],
  ['video_note', m => m.video_note, () => '(video note)'],
  ['sticker', m => m.sticker, m => `(sticker${m.sticker.emoji ? ' ' + m.sticker.emoji : ''})`],
]
for (const [kind, get, label] of fileKinds) {
  bot.on(`message:${kind}` as 'message:document', ctx => {
    const f = get(ctx.message)
    return handleInbound(ctx, ctx.message.caption ?? label(ctx.message), undefined, {
      attachment_kind: kind,
      attachment_file_id: f.file_id,
      ...(f.file_size != null ? { attachment_size: String(f.file_size) } : {}),
      ...(f.mime_type ? { attachment_mime: f.mime_type } : {}),
      ...(f.file_name ? { attachment_name: safeName(f.file_name)! } : {}),
    })
  })
}

bot.on('callback_query:data', async ctx => {
  if (ctx.callbackQuery.data.startsWith('stop:')) {
    if (!isAllowed(ctx.from.id)) return void ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    const ref = ctx.callbackQuery.data.slice(5)
    const key = keyFor(ref === 'g' ? undefined : Number(ref))
    const note = key && clients.has(key) ? interrupt(key) : 'Сессия не запущена'
    if (key) actStop(key, 'int') // строка статуса уходит сразу
    return void ctx.answerCallbackQuery({ text: note }).catch(() => {})
  }
  if (ctx.callbackQuery.data.startsWith('md:')) {
    if (!isAllowed(ctx.from.id)) return void ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    const arg = ctx.callbackQuery.data.slice(3)
    const f = modelFlow
    if (arg === 'x' || !f) { modelFlow = undefined; await ctx.editMessageText('Отменено.').catch(() => {}); return void ctx.answerCallbackQuery().catch(() => {}) }
    const opt = f.opts[Number(arg)]
    if (!opt) return void ctx.answerCallbackQuery({ text: 'Список устарел, /model заново' }).catch(() => {})
    modelFlow = undefined
    await ctx.answerCallbackQuery({ text: 'Переключаю…' }).catch(() => {})
    await ctx.editMessageText(`Переключаю на ${opt.label}…`).catch(() => {})
    const msg = await modelSwitch(opt)
    return void (await bot.api.sendMessage(GROUP, msg, withThread(f.thread)).catch(() => {}))
  }
  if (ctx.callbackQuery.data.startsWith('nw:')) {
    if (!isAllowed(ctx.from.id)) return void ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return void (await newCallback(ctx, ctx.callbackQuery.data))
  }
  if (ctx.callbackQuery.data.startsWith('ask:')) {
    if (!isAllowed(ctx.from.id)) return void ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    const [, id, idx] = ctx.callbackQuery.data.split(':') as [string, string, string]
    return void ctx.answerCallbackQuery({ text: askPress(Number(id), Number(idx)) }).catch(() => {})
  }
  if (ctx.callbackQuery.data.startsWith('br:')) {
    if (!isAllowed(ctx.from.id)) return void ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    const [, act, ref] = ctx.callbackQuery.data.split(':') as [string, string, string]
    const key = keyFor(ref === 'g' ? undefined : Number(ref))
    const ok = !!key && clients.has(key) && browserAsk(key, act!, ctx.from)
    return void ctx.answerCallbackQuery({ text: ok ? 'Передал сессии…' : 'Сессия не запущена' }).catch(() => {})
  }
  if (ctx.callbackQuery.data.startsWith('win:')) {
    if (!isAllowed(ctx.from.id)) return void ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    const d = ctx.callbackQuery.data
    let note = ''
    if (d === 'win:h') {
      const n = teleTmuxSessions().filter(x => attachedClients(x) > 0)
      n.forEach(x => tmux('detach-client', '-s', x))
      note = n.length ? `Скрыто окон: ${n.length}` : 'Открытых окон нет'
    } else if (d.startsWith('win:t:')) {
      const name = d.slice(6)
      if (!teleTmuxSessions().includes(name)) note = 'Сессия не найдена'
      else if (attachedClients(name) > 0) { tmux('detach-client', '-s', name); note = 'Скрыто' }
      else {
        const script = `tell application "Terminal"\nactivate\ndo script "${TMUX} attach -t ${name}; exit"\nend tell`
        note = spawnSync('osascript', ['-e', script], { encoding: 'utf8' }).status === 0 ? 'Открыто' : 'Не удалось открыть окно'
      }
    }
    await Bun.sleep(400) // дать tmux/Terminal обновить число клиентов
    const p = windowsPanel()
    await ctx.editMessageText(p.text, { reply_markup: p.kb }).catch(() => {})
    return void ctx.answerCallbackQuery({ text: note || undefined }).catch(() => {})
  }
  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(ctx.callbackQuery.data)
  if (!m || !isAllowed(ctx.from.id)) return void ctx.answerCallbackQuery({ text: m ? 'Not authorized.' : undefined }).catch(() => {})
  const [, behavior, id] = m as unknown as [string, string, string]
  if (behavior === 'more') {
    const d = permDetails.get(id)
    if (!d) return void ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
    let pretty = d.input_preview
    try { pretty = JSON.stringify(JSON.parse(d.input_preview), null, 2) } catch {}
    const kb = new InlineKeyboard().text('✅ Allow', `perm:allow:${id}`).text('❌ Deny', `perm:deny:${id}`)
    await ctx.editMessageText(`🔐 Permission: ${d.tool_name}\n\ndescription: ${d.description}\ninput_preview:\n${pretty}`, { reply_markup: kb }).catch(() => {})
    return void ctx.answerCallbackQuery().catch(() => {})
  }
  const owner = permOwner.get(id)
  if (owner) pushTo(owner, { event: 'permission', request_id: id, behavior })
  permOwner.delete(id); permDetails.delete(id); if (owner) touchStatus(owner)
  const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const msg = ctx.callbackQuery.message
  if (msg && 'text' in msg && msg.text) await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
})

bot.catch(err => log(`handler error (polling continues): ${err.error}`))

// ---------- запуск и остановка ----------
let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  log('останавливаюсь')
  try { if (parseInt(readFileSync(join(STATE_DIR, 'router.pid'), 'utf8'), 10) === process.pid) unlinkSync(SOCK) } catch {}
  try { if (parseInt(readFileSync(join(STATE_DIR, 'router.pid'), 'utf8'), 10) === process.pid) unlinkSync(join(STATE_DIR, 'router.pid')) } catch {}
  try { if (parseInt(readFileSync(LOCK, 'utf8'), 10) === process.pid) unlinkSync(LOCK) } catch {}
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, shutdown)
process.on('unhandledRejection', e => log(`unhandled rejection: ${e}`))
process.on('uncaughtException', e => log(`uncaught exception: ${e}`))

for (let attempt = 1; !stopping; attempt++) {
  try {
    await bot.start({
      onStart: info => {
        attempt = 0; botUsername = info.username; log(`polling as @${info.username}`)
        const cmds = [
          { command: 'statusemoji', description: 'Анимированный эмодзи в строке статуса: /statusemoji 🔵' },
          { command: 'mirror', description: 'Дублировать переписку из терминала сюда: on/off' },
          { command: 'model', description: 'Сменить модель сессии (Claude или локальная)' },
          { command: 'rename', description: 'Переименовать эту тему: /rename Название' },
          { command: 'new', description: 'Запустить новую сессию: выбрать или создать папку' },
          { command: 'stop', description: 'Прервать текущее действие сессии (как Esc)' },
          { command: 'screen', description: 'Браузер сессии: скриншот и кнопки управления' },
          { command: 'windows', description: 'Окна сессий: открыть/скрыть кнопками' },
          { command: 'show', description: 'Открыть окно сессии: /show <имя>' },
          { command: 'hide', description: 'Скрыть окно сессии: /hide <имя>' },
          { command: 'hideall', description: 'Скрыть все окна' },
          { command: 'sessions', description: 'Список сессий и их состояние' },
          { command: 'help', description: 'Что умеет бот' },
        ]
        for (const scope of [{ type: 'all_group_chats' as const }, { type: 'chat' as const, chat_id: Number(GROUP) }, { type: 'all_private_chats' as const }]) {
          void bot.api.setMyCommands(cmds, { scope }).catch(e => log(`setMyCommands: ${e}`))
        }
      },
    })
    break
  } catch (err) {
    if (stopping) break
    if (err instanceof Error && err.message === 'Aborted delay') break
    const is409 = err instanceof GrammyError && err.error_code === 409
    const delay = Math.min(1000 * attempt, 15000)
    log(`${is409 ? '409 Conflict — другой процесс читает обновления бота' : `polling error: ${err}`}, повтор через ${delay / 1000}с`)
    await new Promise(r => setTimeout(r, delay))
  }
}
