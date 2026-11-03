/**
 * A small top-level SQL scanner for the SQLite driver. It is deliberately not a parser: it only
 * needs to know where a statement ends, what its main verb is, and whether anything follows it,
 * without being fooled by string literals, quoted identifiers, comments or parentheses.
 */

export interface SqlToken {
  kind: 'word' | 'open' | 'close' | 'semicolon' | 'other';
  text: string;
  depth: number;
  /** Source offsets [from, to) of the token. */
  from: number;
  to: number;
}

/** Split SQL into tokens, dropping whitespace and comments and collapsing literals/identifiers. */
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let depth = 0;
  let index = 0;
  const skipQuoted = (close: string, start: number) => {
    let end = start + 1;
    while (end < sql.length) {
      if (sql.charAt(end) === close) {
        // A doubled quote is an escaped quote inside the literal or identifier.
        if (close !== ']' && sql.charAt(end + 1) === close) {
          end += 2;
          continue;
        }
        return end + 1;
      }
      end += 1;
    }
    return sql.length;
  };
  while (index < sql.length) {
    const start = index;
    const character = sql.charAt(index);
    const pair = sql.slice(index, index + 2);
    const push = (kind: SqlToken['kind'], text: string, at = depth) =>
      tokens.push({ kind, text, depth: at, from: start, to: index });
    if (/\s/.test(character)) {
      index += 1;
    } else if (pair === '--') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end + 1;
    } else if (pair === '/*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
    } else if (character === "'" || character === '"' || character === '`') {
      index = skipQuoted(character, index);
      push('other', 'literal');
    } else if (character === '[') {
      index = skipQuoted(']', index);
      push('other', 'literal');
    } else if (character === '(') {
      index += 1;
      push('open', '(');
      depth += 1;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
      index += 1;
      push('close', ')');
    } else if (character === ';') {
      index += 1;
      push('semicolon', ';');
    } else if (/[A-Za-z_\u0080-\uffff]/.test(character)) {
      // SQLite treats every non-ASCII character as an identifier character.
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$\u0080-\uffff]/.test(sql.charAt(end))) end += 1;
      index = end;
      push('word', sql.slice(start, end).toLowerCase());
    } else if (/[0-9]/.test(character)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_.]/.test(sql.charAt(end))) end += 1;
      index = end;
      push('other', 'number');
    } else {
      index += 1;
      push('other', character);
    }
  }
  return tokens;
}

export interface SqlInspection {
  /** Lower-case first keyword of the statement ('' when empty). */
  verb: string;
  /** Lower-case main verb after any WITH clause ('' when it cannot be determined). */
  mainVerb: string;
  /** True when anything other than whitespace and comments follows the statement terminator. */
  hasTail: boolean;
  /** True only when the statement is certainly read-only. Anything uncertain is a write. */
  readOnly: boolean;
}

const MAIN_VERBS = new Set(['select', 'values', 'insert', 'update', 'delete', 'replace']);
const READ_ONLY_PRAGMAS = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'foreign_key_check',
  'database_list',
  'collation_list',
  'function_list',
  'compile_options',
  'integrity_check',
  'quick_check',
]);

/**
 * Index of the token that terminates the statement starting at tokens[0] (a top-level `;`), or
 * tokens.length. CREATE [TEMP] TRIGGER bodies contain semicolons: they are tracked from BEGIN to
 * the trigger's own END (CASE ... END pairs are matched), so a tail after that END is still a tail.
 */
function statementEnd(tokens: readonly SqlToken[]): number {
  const first = tokens[0];
  const second = tokens[1];
  const third = tokens[2];
  const isWord = (token: SqlToken | undefined, ...texts: string[]) =>
    token?.kind === 'word' && texts.includes(token.text);
  const isTrigger =
    isWord(first, 'create') &&
    (isWord(second, 'trigger') ||
      (isWord(second, 'temp', 'temporary') && isWord(third, 'trigger')));
  let inBody = false;
  let caseDepth = 0;
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position] as SqlToken;
    // `AS end` and `x.end` name something; they do not open or close a block.
    const previous = tokens[position - 1];
    const isName = isWord(previous, 'as') || (previous?.kind === 'other' && previous.text === '.');
    if (isTrigger && token.depth === 0 && token.kind === 'word' && !isName) {
      if (!inBody && token.text === 'begin') inBody = true;
      else if (inBody && token.text === 'case') caseDepth += 1;
      else if (inBody && token.text === 'end') {
        if (caseDepth > 0) caseDepth -= 1;
        else inBody = false;
      }
    }
    if (token.kind === 'semicolon' && token.depth === 0 && !inBody) return position;
  }
  return tokens.length;
}

/** Split a script (such as a migration file) into statements using the same scanner. */
export function splitStatements(sql: string): string[] {
  const all = tokenizeSql(sql);
  const statements: string[] = [];
  let rest = all;
  while (rest.length > 0) {
    const end = statementEnd(rest);
    const last = rest[Math.min(end, rest.length - 1)] as SqlToken;
    statements.push(sql.slice((rest[0] as SqlToken).from, last.to));
    rest = rest.slice(end + 1);
  }
  return statements;
}

const cache = new Map<string, SqlInspection>();

/** Memoized inspection; the same SQL strings are executed repeatedly. */
export function inspectSql(sql: string): SqlInspection {
  let inspection = cache.get(sql);
  if (!inspection) {
    inspection = inspectUncached(sql);
    if (cache.size >= 1_024) cache.clear();
    cache.set(sql, inspection);
  }
  return inspection;
}

function inspectUncached(sql: string): SqlInspection {
  const tokens = tokenizeSql(sql);
  const first = tokens[0];
  const verb = first?.kind === 'word' ? first.text : '';

  const end = statementEnd(tokens);
  const terminated = end < tokens.length;
  const hasTail = terminated && tokens.slice(end + 1).length > 0;
  const body = tokens.slice(0, end);

  let mainVerb = verb;
  if (verb === 'with') {
    const found = body.find(
      (token, position) =>
        position > 0 && token.kind === 'word' && token.depth === 0 && MAIN_VERBS.has(token.text),
    );
    mainVerb = found?.text ?? '';
  }

  let readOnly = false;
  if (mainVerb === 'select' || mainVerb === 'values' || verb === 'explain') {
    readOnly = true;
  } else if (verb === 'pragma') {
    // Only the unqualified `PRAGMA name` or `PRAGMA name(...)` forms can be certain reads.
    const name = body[1];
    const next = body[2];
    readOnly =
      name?.kind === 'word' &&
      READ_ONLY_PRAGMAS.has(name.text) &&
      (next === undefined || next.kind === 'open');
  }
  return { verb, mainVerb, hasTail, readOnly };
}
