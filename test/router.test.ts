// Проверка роутера на поддельном Telegram: две сессии одновременно, настоящий бот не трогаем.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { connect, type Socket } from 'net'
import type { Subprocess } from 'bun'

const GROUP = '-1001'
const USER = 555
const dir = mkdtempSync(join(tmpdir(), 'tele-test-'))
let fake: ReturnType<typeof Bun.serve>
let router: Subprocess
const calls: Array<{ method: string; body: any }> = []
let updates: any[] = []
let nextThread = 100
let nextMsg = 1000

function fakeUpdate(text: string, thread?: number, from = USER) {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: nextMsg++, date: 1700000000, text,
      chat: { id: Number(GROUP), type: 'supergroup' },
      from: { id: from, is_bot: false, first_name: 'u', username: 'u' },
      ...(thread ? { message_thread_id: thread, is_topic_message: true } : {}),
    },
  }
}

beforeAll(async () => {
  fake = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop()!
      let body: any = {}
      try { body = await req.json() } catch {}
      if (method !== 'getUpdates') calls.push({ method, body })
      const ok = (result: any) => Response.json({ ok: true, result })
      switch (method) {
        case 'getMe': return ok({ id: 1, is_bot: true, first_name: 'b', username: 'testbot' })
        case 'getUpdates': {
          if (updates.length === 0) { await Bun.sleep(150); return ok([]) }
          const r = updates; updates = []; return ok(r)
        }
        case 'createForumTopic': return ok({ message_thread_id: nextThread++, name: body.name })
        case 'sendMessage': return ok({ message_id: nextMsg++, date: 1, chat: { id: Number(GROUP), type: 'supergroup' } })
        default: return ok(true)
      }
    },
  })
  mkdirSync(join(dir, 'proj', 'alpha'), { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ chat_id: GROUP }))
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ allowFrom: [String(USER)] }))
  router = Bun.spawn(['bun', join(import.meta.dir, '../router/router.ts')], {
    env: {
      ...process.env,
      TELE_STATE_DIR: dir, TELE_BOT_TOKEN: 'TEST:TOKEN', TELE_API_ROOT: `http://localhost:${fake.port}`,
      TELE_NEW_ROOT: join(dir, 'proj'), TELE_ACCESS_FILE: join(dir, 'access.json'), TELE_PROJECTS_DIR: join(dir, 'projects'),
    },
    stderr: process.env.DEBUG_ROUTER ? 'inherit' : 'ignore',
  })
  for (let i = 0; i < 50 && !existsSync(join(dir, 'router.sock')); i++) await Bun.sleep(100)
})

afterAll(() => { router?.kill(); fake?.stop(true) })

class TestClient {
  sock!: Socket; buf = ''; id = 1
  events: any[] = []
  pending = new Map<number, (m: any) => void>()
  static async open(): Promise<TestClient> {
    const c = new TestClient()
    c.sock = connect(join(dir, 'router.sock')); c.sock.setEncoding('utf8')
    c.sock.on('data', (d: string) => {
      c.buf += d
      let i: number
      while ((i = c.buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(c.buf.slice(0, i)); c.buf = c.buf.slice(i + 1)
        if (m.id != null && c.pending.has(m.id)) { c.pending.get(m.id)!(m); c.pending.delete(m.id) } else c.events.push(m)
      }
    })
    await new Promise(r => c.sock.once('connect', r))
    return c
  }
  call(m: any): Promise<any> {
    return new Promise(r => { const id = this.id++; this.pending.set(id, r); this.sock.write(JSON.stringify({ ...m, id }) + '\n') })
  }
  async waitEvent(n = 1, ms = 3000) {
    for (let t = 0; t < ms / 50 && this.events.length < n; t++) await Bun.sleep(50)
    return this.events
  }
}

test('две сессии получают разные темы, сообщения идут только по адресу', async () => {
  const a = await TestClient.open(), b = await TestClient.open()
  const ra = await a.call({ op: 'register', key: '/p/a::main', name: 'main', dir: '/p/a' })
  const rb = await b.call({ op: 'register', key: '/p/b::main', name: 'main', dir: '/p/b' })
  expect(ra.ok && rb.ok).toBe(true)
  expect(ra.result.thread_id).not.toBe(rb.result.thread_id)
  expect(ra.result.title).toBe('a')

  updates.push(fakeUpdate('привет A', ra.result.thread_id))
  updates.push(fakeUpdate('привет B', rb.result.thread_id))
  const ea = await a.waitEvent(), eb = await b.waitEvent()
  expect(ea.length).toBe(1); expect(eb.length).toBe(1)
  expect(ea[0].content).toBe('привет A'); expect(eb[0].content).toBe('привет B')
  expect(ea[0].meta.thread_id).toBe(String(ra.result.thread_id))
})

test('ответ сессии уходит в её тему', async () => {
  const a = await TestClient.open()
  const r = await a.call({ op: 'register', key: '/p/a::main', name: 'main', dir: '/p/a' })
  calls.length = 0
  const res = await a.call({ op: 'reply', text: 'ответ' })
  expect(res.ok).toBe(true)
  const sent = calls.find(c => c.method === 'sendMessage')!
  expect(sent.body.message_thread_id).toBe(r.result.thread_id)
  expect(String(sent.body.chat_id)).toBe(GROUP)
})

test('повторная регистрация переиспользует тему, а не создаёт новую', async () => {
  const before = calls.filter(c => c.method === 'createForumTopic').length
  const a = await TestClient.open()
  await a.call({ op: 'register', key: '/p/a::main', name: 'main', dir: '/p/a' })
  expect(calls.filter(c => c.method === 'createForumTopic').length).toBe(before)
})

test('чужой отправитель игнорируется', async () => {
  const c = await TestClient.open()
  const r = await c.call({ op: 'register', key: '/p/c::main', name: 'main', dir: '/p/c' })
  updates.push(fakeUpdate('я чужой', r.result.thread_id, 999))
  await Bun.sleep(600)
  expect(c.events.length).toBe(0)
})

test('сообщение в тему без запущенной сессии не доходит и вызывает подсказку', async () => {
  const c = await TestClient.open()
  const r = await c.call({ op: 'register', key: '/p/d::main', name: 'main', dir: '/p/d' })
  c.sock.destroy()
  await Bun.sleep(300)
  calls.length = 0
  updates.push(fakeUpdate('есть кто?', r.result.thread_id))
  await Bun.sleep(600)
  const notice = calls.find(x => x.method === 'sendMessage' && x.body.message_thread_id === r.result.thread_id)
  expect(notice?.body.text).toContain('не запущена')
})

test('/sessions в общей теме отвечает списком', async () => {
  calls.length = 0
  updates.push(fakeUpdate('/sessions'))
  await Bun.sleep(600)
  const m = calls.find(x => x.method === 'sendMessage')
  expect(m?.body.text).toMatch(/(🟢|⚪️) a(\n|$)/)
})

test('статус: читает журнал сессии, показывает действия и снимает по end_turn', async () => {
  const c = await TestClient.open()
  const r = await c.call({ op: 'register', key: '/p/w::main', name: 'main', dir: '/p/w' })
  const pd = join(dir, 'projects', '-p-w'); mkdirSync(pd, { recursive: true })
  const tr = join(pd, 's1.jsonl'); writeFileSync(tr, '')
  calls.length = 0
  updates.push(fakeUpdate('сделай', r.result.thread_id))
  await c.waitEvent()
  appendFileSync(tr, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/p/w/a.ts' } }] } }) + '\n')
  await Bun.sleep(2500)
  const texts = calls.filter(x => x.method === 'sendMessage' || x.method === 'editMessageText').map(x => x.body.text)
  expect(texts.some(t => String(t).includes('Читаю a.ts'))).toBe(true)
  appendFileSync(tr, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } }) + '\n')
  await Bun.sleep(1500)
  expect(calls.some(x => x.method === 'deleteMessage')).toBe(true)
})

test('вопрос с выбором (AskUserQuestion) приходит в тему кнопками', async () => {
  const c = await TestClient.open()
  const r = await c.call({ op: 'register', key: '/p/q::main', name: 'main', dir: '/p/q' })
  const pd = join(dir, 'projects', '-p-q'); mkdirSync(pd, { recursive: true })
  const tr = join(pd, 's1.jsonl'); writeFileSync(tr, '')
  updates.push(fakeUpdate('спроси меня', r.result.thread_id))
  await c.waitEvent()
  calls.length = 0
  const input = { questions: [{ question: 'Что делать?', header: 'Выбор', multiSelect: false, options: [{ label: 'Первое', description: 'a' }, { label: 'Второе' }] }] }
  appendFileSync(tr, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input }] } }) + '\n')
  await Bun.sleep(2500)
  const m = calls.find(x => x.method === 'sendMessage' && String(x.body.text).includes('Что делать?'))!
  expect(m).toBeTruthy()
  expect(m.body.message_thread_id).toBe(r.result.thread_id)
  const kb = JSON.stringify(m.body.reply_markup)
  expect(kb).toContain('Первое'); expect(kb).toContain('Другое')
})

test('/new: показывает папки, просит имя новой и не принимает плохое имя', async () => {
  calls.length = 0
  updates.push(fakeUpdate('/new'))
  await Bun.sleep(700)
  const m = calls.find(x => x.method === 'sendMessage' && String(x.body.text).includes('Шаг 1'))!
  expect(m).toBeTruthy()
  const kb = JSON.stringify(m.body.reply_markup)
  expect(kb).toContain('alpha'); expect(kb).toContain('Создать новую папку')
  updates.push({ update_id: 7, callback_query: { id: 'c1', chat_instance: 'x', data: 'nw:c', from: { id: USER, is_bot: false, first_name: 'u' },
    message: { message_id: 5, date: 1, chat: { id: Number(GROUP), type: 'supergroup' }, text: 'x' } } })
  await Bun.sleep(600)
  calls.length = 0
  updates.push(fakeUpdate('плохое имя с пробелами'))
  await Bun.sleep(700)
  expect(calls.some(x => x.method === 'sendMessage' && String(x.body.text).includes('латинские буквы'))).toBe(true)
  expect(existsSync(join(dir, 'proj', 'плохое имя с пробелами'))).toBe(false)
})
