// Общее для роутера и клиента.
export type Msg = Record<string, any>

// "yes abcde" / "no abcde" — ответ на запрос разрешения (5 букв a-z без 'l').
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// .jpg/.png/... уходят как фото, остальное как документы.
export const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m) out[m[1]!] = m[2]!
  }
  return out
}

// Telegram режет сообщения на 4096 символов.
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// Подробное описание вызова инструмента для строки статуса в Telegram. Первый эмодзи — «метка» вида активности:
// роутер заменяет его анимированным значком из набора Telegram и в текст не выводит.
export function describeTool(t: string, ti: Record<string, any> = {}): string | null {
  if (t.startsWith('mcp__tele__')) return null // свои ответы в статусе не показываем
  const short = (x: unknown, n = 70) => {
    const v = String(x ?? '').replace(/\s+/g, ' ').trim()
    return v.length > n ? v.slice(0, n - 1) + '…' : v
  }
  const base = (x: unknown) => String(x ?? '').split('/').slice(-2).join('/')
  const lines = (x: unknown) => (typeof x === 'string' && x ? x.split('\n').length : 0)
  if (t === 'Bash') {
    const d = short(ti.description, 90), c = short(ti.command, 130)
    return `⚙️ Команда: ${d ? d + (c ? ` (${c})` : '') : c}`
  }
  if (t === 'Read') {
    const rng = ti.offset != null || ti.limit != null ? `, строки ${ti.offset ?? 1}–${(Number(ti.offset ?? 1) + Number(ti.limit ?? 2000))}` : ''
    return `📖 Читаю файл ${base(ti.file_path)}${rng}`
  }
  if (t === 'Edit' || t === 'MultiEdit') {
    const o = ti.old_string ? short(ti.old_string, 50) : '', n = ti.new_string ? short(ti.new_string, 50) : ''
    return `✏️ Правлю ${base(ti.file_path)}${o || n ? `: «${o}» → «${n}»` : ''}`
  }
  if (t === 'Write') return `📝 Записываю файл ${base(ti.file_path)}${lines(ti.content) ? `, ${lines(ti.content)} строк` : ''}`
  if (t === 'Grep') return `🔎 Ищу «${short(ti.pattern, 50)}» ${ti.path ? 'в ' + base(ti.path) : ti.glob ? 'в ' + short(ti.glob, 30) : 'по проекту'}`
  if (t === 'Glob') return `🔎 Ищу файлы ${short(ti.pattern, 50)}${ti.path ? ' в ' + base(ti.path) : ''}`
  if (t === 'WebSearch') return `🌐 Ищу в сети: ${short(ti.query, 80)}`
  if (t === 'WebFetch') return `🌐 Открываю страницу ${short(ti.url, 80)}`
  if (t === 'Agent' || t === 'Task') return `🤖 Подагент: ${short(ti.description, 80)}`
  if (t === 'TodoWrite') {
    const cur = Array.isArray(ti.todos) ? ti.todos.find((x: any) => x?.status === 'in_progress') : undefined
    return `📋 Список задач${cur?.content ? ': сейчас «' + short(cur.content, 70) + '»' : ' обновляю'}`
  }
  if (t === 'AskUserQuestion') return '❓ Задаю вам вопрос'
  return `🔧 Вызываю ${t.replace(/^mcp__/, '').replace(/__/g, ': ')}`
}
