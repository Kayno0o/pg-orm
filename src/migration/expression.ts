import { PREDICATE_CAST_RE, PREDICATE_NOISE_RE, STRING_LITERAL_SPLIT_RE } from './regex'

// A parsed expression: an atom, or an operator with its operands. Parentheses are not kept, only the grouping they make.
type Node = string | { op: string, args: Node[] }

interface Token {
  kind: 'word' | 'number' | 'string' | 'op' | 'open' | 'close' | 'comma'
  text: string
}

const WORD_START_RE = /[a-z_]/i
const WORD_RE = /[\w$.]/
const DIGIT_RE = /\d/
const SPACE_RE = /\s/
const NUMBER_RE = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?/i
const QUOTED_TYPE_RE = /^\s*"[^"]*"/
const TYPE_NAME_RE = /^\s*[a-z_][\w.$]*/i
const TYPE_MODIFIER_RE = /^\s*\([\d,\s]*\)/
const ARRAY_BRACKETS_RE = /^(?:\[\d*\])+/
const OPERATOR_CHAR_RE = /[<>=!~+\-*/%|&^#@]/
// A type name Postgres prints after a cast, whose extra words (`character varying`, `timestamp with time zone`, `double precision`) follow its first.
const TYPE_TAIL_WORDS = new Set(['varying', 'precision', 'with', 'without', 'time', 'zone'])
const TYPE_HEADS = new Set(['character', 'bit', 'double', 'time', 'timestamp'])

const OR_PRECEDENCE = 1
const AND_PRECEDENCE = 2
const NOT_PRECEDENCE = 3
const COMPARISON_PRECEDENCE = 4
const ADDITIVE_PRECEDENCE = 5
const MULTIPLICATIVE_PRECEDENCE = 6
const UNARY_PRECEDENCE = 7

const COMPARISONS = new Set(['=', '<>', '!=', '<', '>', '<=', '>=', '~~', '!~~', '~~*', '!~~*', '~', '!~', '~*', '!~*', 'like', 'ilike'])
const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '||', '^'])
const NULL_TESTS = new Set(['null', 'true', 'false', 'unknown'])

class Unsupported extends Error {}

/**
 * Whether two predicates or generated expressions mean the same, read as Postgres prints them back: a redundant parenthesis, a cast, spacing or case is no difference, a different grouping is.
 * One beyond the small grammar read here is compared with every parenthesis and cast dropped, which cannot tell a change of grouping.
 */
export function sameExpression(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = canonicalExpression(a ?? '')
  const right = canonicalExpression(b ?? '')

  return left === undefined || right === undefined ? looseExpression(a) === looseExpression(b) : left === right
}

function canonicalExpression(expr: string): string | undefined {
  try {
    const parser = new Parser(tokenize(expr))
    const node = parser.expression(0)

    return parser.done() ? print(node) : undefined
  }
  catch (err) {
    if (err instanceof Unsupported)
      return undefined

    throw err
  }
}

/** An expression with its casts, quotes, parentheses and spacing dropped outside string literals: the form of what the grammar here does not read, and of a whole index definition. */
export function looseExpression(expr: string | null | undefined): string {
  return (expr ?? '').split(STRING_LITERAL_SPLIT_RE).map((part, i) => i % 2 === 1 ? part : part.toLowerCase().replace(PREDICATE_CAST_RE, '').replace(PREDICATE_NOISE_RE, '')).join('')
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < text.length) {
    const ch = text[i]!

    if (SPACE_RE.test(ch)) {
      i++
    }
    else if (ch === '\'') {
      let end = i + 1

      while (end < text.length && (text[end] !== '\'' || text[end + 1] === '\''))
        end += text[end] === '\'' ? 2 : 1

      if (end >= text.length)
        throw new Unsupported()

      tokens.push({ kind: 'string', text: text.slice(i, end + 1) })
      i = end + 1
    }
    else if (ch === '"') {
      const end = text.indexOf('"', i + 1)

      if (end < 0)
        throw new Unsupported()

      tokens.push({ kind: 'word', text: text.slice(i + 1, end).toLowerCase() })
      i = end + 1
    }
    else if (DIGIT_RE.test(ch)) {
      const match = NUMBER_RE.exec(text.slice(i))![0]

      tokens.push({ kind: 'number', text: match.toLowerCase() })
      i += match.length
    }
    else if (WORD_START_RE.test(ch)) {
      let end = i + 1

      while (end < text.length && WORD_RE.test(text[end]!))
        end++

      tokens.push({ kind: 'word', text: text.slice(i, end).toLowerCase() })
      i = end
    }
    else if (ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ kind: ch === '(' ? 'open' : ch === ')' ? 'close' : 'comma', text: ch })
      i++
    }
    else if (ch === ':' && text[i + 1] === ':') {
      i = skipCastType(text, i + 2)
    }
    else if (OPERATOR_CHAR_RE.test(ch)) {
      let end = i + 1

      while (end < text.length && OPERATOR_CHAR_RE.test(text[end]!))
        end++

      tokens.push({ kind: 'op', text: text.slice(i, end) })
      i = end
    }
    else {
      throw new Unsupported()
    }
  }

  return tokens
}

// Where the type a `::` casts to ends: its name, the words that complete it, a length or precision and its array brackets.
function skipCastType(text: string, from: number): number {
  let i = from
  const word = (): string | undefined => {
    const quoted = QUOTED_TYPE_RE.exec(text.slice(i))
    const plain = TYPE_NAME_RE.exec(text.slice(i))
    const found = quoted?.[0] ?? plain?.[0]

    if (found)
      i += found.length

    return found?.trim().toLowerCase()
  }
  const head = word()

  if (head === undefined)
    throw new Unsupported()

  for (let more = TYPE_HEADS.has(head); more;) {
    const save = i
    const next = word()

    more = next !== undefined && TYPE_TAIL_WORDS.has(next)

    if (!more)
      i = save
  }

  const modifier = TYPE_MODIFIER_RE.exec(text.slice(i))

  if (modifier)
    i += modifier[0].length

  const brackets = ARRAY_BRACKETS_RE.exec(text.slice(i))

  if (brackets)
    i += brackets[0].length

  return i
}

class Parser {
  private at = 0

  constructor(private readonly tokens: Token[]) {}

  done(): boolean {
    return this.at >= this.tokens.length
  }

  expression(minPrecedence: number): Node {
    let left = this.prefix()

    for (;;) {
      const token = this.tokens[this.at]

      if (token === undefined || token.kind === 'close' || token.kind === 'comma')
        return left

      const next = this.infix(left, token, minPrecedence)

      if (next === undefined)
        return left

      left = next
    }
  }

  private prefix(): Node {
    const token = this.take()

    switch (token.kind) {
      case 'number':
      case 'string':
        return token.text
      case 'open': {
        const items = this.list()

        return items.length === 1 ? items[0]! : { op: 'list', args: items }
      }
      case 'op':
        if (token.text === '-' || token.text === '+')
          return { op: `unary${token.text}`, args: [this.expression(UNARY_PRECEDENCE)] }

        throw new Unsupported()
      case 'word':
        if (token.text === 'not')
          return { op: 'not', args: [this.expression(NOT_PRECEDENCE)] }

        if (this.tokens[this.at]?.kind === 'open') {
          this.at++

          return { op: `call:${token.text}`, args: this.list() }
        }

        if (['case', 'array', 'cast', 'exists', 'select'].includes(token.text))
          throw new Unsupported()

        return token.text
      default:
        throw new Unsupported()
    }
  }

  // The comma-separated expressions up to the closing parenthesis, which it takes.
  private list(): Node[] {
    const items: Node[] = []

    if (this.tokens[this.at]?.kind === 'close') {
      this.at++

      return items
    }

    for (;;) {
      items.push(this.expression(0))

      const token = this.take()

      if (token.kind === 'close')
        return items

      if (token.kind !== 'comma')
        throw new Unsupported()
    }
  }

  private infix(left: Node, token: Token, minPrecedence: number): Node | undefined {
    const word = token.kind === 'word' ? token.text : undefined

    if (word === 'or' || word === 'and') {
      const precedence = word === 'or' ? OR_PRECEDENCE : AND_PRECEDENCE

      if (precedence < minPrecedence)
        return undefined

      this.at++

      const right = this.expression(precedence + 1)

      return { op: word, args: [...typeof left === 'object' && left.op === word ? left.args : [left], ...typeof right === 'object' && right.op === word ? right.args : [right]] }
    }

    if (COMPARISON_PRECEDENCE < minPrecedence)
      return undefined

    if (word === 'is')
      return this.isTest(left)

    if (word === 'not' || word === 'in' || word === 'between' || word === 'like' || word === 'ilike')
      return this.membership(left)

    const op = token.kind === 'op' ? token.text : word && COMPARISONS.has(word) ? word : undefined

    if (op === undefined || !(COMPARISONS.has(op) || ARITHMETIC.has(op)))
      throw new Unsupported()

    const precedence = COMPARISONS.has(op) ? COMPARISON_PRECEDENCE : op === '*' || op === '/' || op === '%' ? MULTIPLICATIVE_PRECEDENCE : ADDITIVE_PRECEDENCE

    if (precedence < minPrecedence)
      return undefined

    this.at++

    return { op: op === '!=' ? '<>' : op, args: [left, this.expression(precedence + 1)] }
  }

  private isTest(left: Node): Node {
    this.at++

    let negated = false

    if (this.tokens[this.at]?.text === 'not') {
      negated = true
      this.at++
    }

    const test = this.take()

    if (test.kind !== 'word' || !NULL_TESTS.has(test.text))
      throw new Unsupported()

    return { op: negated ? 'is not' : 'is', args: [left, test.text] }
  }

  // `x IN (...)`, `x BETWEEN a AND b`, `x LIKE y`, each with an optional NOT before.
  private membership(left: Node): Node {
    let negated = false

    if (this.tokens[this.at]?.text === 'not') {
      negated = true
      this.at++
    }

    const word = this.take().text
    const op = negated ? `not ${word}` : word

    if (word === 'in') {
      if (this.take().kind !== 'open')
        throw new Unsupported()

      return { op, args: [left, { op: 'list', args: this.list() }] }
    }

    if (word === 'between') {
      const low = this.expression(ADDITIVE_PRECEDENCE)

      if (this.take().text !== 'and')
        throw new Unsupported()

      const high = this.expression(ADDITIVE_PRECEDENCE)

      // Postgres prints it as the two comparisons it stands for.
      return negated
        ? { op: 'or', args: [{ op: '<', args: [left, low] }, { op: '>', args: [left, high] }] }
        : { op: 'and', args: [{ op: '>=', args: [left, low] }, { op: '<=', args: [left, high] }] }
    }

    if (word === 'like' || word === 'ilike')
      return { op, args: [left, this.expression(COMPARISON_PRECEDENCE + 1)] }

    throw new Unsupported()
  }

  private take(): Token {
    const token = this.tokens[this.at++]

    if (token === undefined)
      throw new Unsupported()

    return token
  }
}

function print(node: Node): string {
  return typeof node === 'string' ? node : `(${node.op} ${node.args.map(print).join(' ')})`
}
