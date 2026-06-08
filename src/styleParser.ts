import * as vscode from "vscode";

export type PathTokenKind = "use" | "forward" | "import" | "url";

export interface PathToken {
  kind: PathTokenKind;
  rawPath: string;
  range: vscode.Range;
}

export interface PathCompletionContext {
  kind: PathTokenKind;
  rawPath: string;
  range: vscode.Range;
  quote: "\"" | "'" | undefined;
}

interface MatchPattern {
  regex: RegExp;
  kind: PathTokenKind;
  pathGroup: number[];
}

const DIRECTIVE_WITH_QUOTES: MatchPattern = {
  // @use "..." | @forward '...' | @import "..."
  regex: /@(use|forward|import)\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)')/g,
  kind: "import",
  pathGroup: [2, 3]
};

const DIRECTIVE_IMPORT_URL_UNQUOTED: MatchPattern = {
  // @import url(path/to/file.css)
  regex: /@import\s+url\(\s*([^'")\s][^)]*?)\s*\)/g,
  kind: "import",
  pathGroup: [1]
};

const URL_PATTERN: MatchPattern = {
  // url("...") | url('...') | url(...)
  regex: /url\(\s*(?:"([^"]+)"|'([^']+)'|([^'")\s][^)]*?))\s*\)/g,
  kind: "url",
  pathGroup: [1, 2, 3]
};

const PATTERNS: MatchPattern[] = [
  DIRECTIVE_WITH_QUOTES,
  DIRECTIVE_IMPORT_URL_UNQUOTED,
  URL_PATTERN
];

const DIRECTIVE_COMPLETION_QUOTED = /@(use|forward|import)\s+(?:url\(\s*)?(["'])([^"']*)$/;
const DIRECTIVE_IMPORT_URL_UNQUOTED_COMPLETION = /@import\s+url\(\s*([^'")\s][^)\r\n]*)?$/;
const URL_COMPLETION_QUOTED = /url\(\s*(["'])([^"']*)$/;
const URL_COMPLETION_UNQUOTED = /url\(\s*([^'")\s][^)\r\n]*)?$/;

function getDirectiveKind(matchText: string, fallback: PathTokenKind): PathTokenKind {
  if (fallback !== "import") {
    return fallback;
  }

  if (matchText.startsWith("@use")) {
    return "use";
  }

  if (matchText.startsWith("@forward")) {
    return "forward";
  }

  return "import";
}

function pickPath(match: RegExpExecArray, groups: number[]): { value: string; index: number } | undefined {
  for (const groupIndex of groups) {
    const value = match[groupIndex];
    if (!value) {
      continue;
    }

    const offsetInMatch = match[0].indexOf(value);
    if (offsetInMatch >= 0) {
      return {
        value,
        index: offsetInMatch
      };
    }
  }

  return undefined;
}

function overlaps(existing: PathToken[], start: number, end: number, document: vscode.TextDocument): boolean {
  for (const token of existing) {
    const tokenStart = document.offsetAt(token.range.start);
    const tokenEnd = document.offsetAt(token.range.end);

    if (start < tokenEnd && end > tokenStart) {
      return true;
    }
  }

  return false;
}

function getRangeForColumns(
  line: number,
  startColumn: number,
  endColumn: number
): vscode.Range {
  return new vscode.Range(new vscode.Position(line, startColumn), new vscode.Position(line, endColumn));
}

function findUnquotedEndOffset(lineAfterCursor: string): number {
  let endOffset = 0;
  while (endOffset < lineAfterCursor.length) {
    const char = lineAfterCursor[endOffset];
    if (/\s/.test(char) || char === ")" || char === "\"" || char === "'" || char === ";" || char === ",") {
      break;
    }

    endOffset += 1;
  }

  return endOffset;
}

function findQuotedEndOffset(lineAfterCursor: string, quote: "\"" | "'"): number {
  const quoteIndex = lineAfterCursor.indexOf(quote);
  if (quoteIndex >= 0) {
    return quoteIndex;
  }

  return findUnquotedEndOffset(lineAfterCursor);
}

function createCompletionContext(
  position: vscode.Position,
  kind: PathTokenKind,
  rawPath: string,
  startColumn: number,
  endColumn: number,
  quote: "\"" | "'" | undefined
): PathCompletionContext {
  const safeStart = Math.max(0, startColumn);
  const safeEnd = Math.max(safeStart, endColumn);

  return {
    kind,
    rawPath,
    range: getRangeForColumns(position.line, safeStart, safeEnd),
    quote
  };
}

export function parsePathTokens(document: vscode.TextDocument): PathToken[] {
  const text = document.getText();
  const tokens: PathToken[] = [];

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;

    for (;;) {
      const match = pattern.regex.exec(text);
      if (!match || typeof match.index !== "number") {
        break;
      }

      const pickedPath = pickPath(match, pattern.pathGroup);
      if (!pickedPath) {
        continue;
      }

      const startOffset = match.index + pickedPath.index;
      const endOffset = startOffset + pickedPath.value.length;

      if (overlaps(tokens, startOffset, endOffset, document)) {
        continue;
      }

      const kind = getDirectiveKind(match[0], pattern.kind);
      const range = new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset));

      tokens.push({
        kind,
        rawPath: pickedPath.value.trim(),
        range
      });
    }
  }

  tokens.sort((a, b) => document.offsetAt(a.range.start) - document.offsetAt(b.range.start));
  return tokens;
}

export function getTokenAtPosition(document: vscode.TextDocument, position: vscode.Position): PathToken | undefined {
  const offset = document.offsetAt(position);
  const tokens = parsePathTokens(document);

  for (const token of tokens) {
    const start = document.offsetAt(token.range.start);
    const end = document.offsetAt(token.range.end);

    if (offset >= start && offset <= end) {
      return token;
    }
  }

  return undefined;
}

export function getPathCompletionContextAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): PathCompletionContext | undefined {
  const lineText = document.lineAt(position.line).text;
  const beforeCursor = lineText.slice(0, position.character);
  const afterCursor = lineText.slice(position.character);

  const directiveQuoted = DIRECTIVE_COMPLETION_QUOTED.exec(beforeCursor);
  if (directiveQuoted) {
    const directiveKind = directiveQuoted[1] as PathTokenKind;
    const quote = directiveQuoted[2] as "\"" | "'";
    const rawPath = directiveQuoted[3] ?? "";
    const startColumn = beforeCursor.length - rawPath.length;
    const endColumn = position.character + findQuotedEndOffset(afterCursor, quote);

    return createCompletionContext(position, directiveKind, rawPath, startColumn, endColumn, quote);
  }

  const importUrlUnquoted = DIRECTIVE_IMPORT_URL_UNQUOTED_COMPLETION.exec(beforeCursor);
  if (importUrlUnquoted) {
    const rawPath = importUrlUnquoted[1] ?? "";
    const startColumn = beforeCursor.length - rawPath.length;
    const endColumn = position.character + findUnquotedEndOffset(afterCursor);

    return createCompletionContext(position, "import", rawPath, startColumn, endColumn, undefined);
  }

  const urlQuoted = URL_COMPLETION_QUOTED.exec(beforeCursor);
  if (urlQuoted) {
    const quote = urlQuoted[1] as "\"" | "'";
    const rawPath = urlQuoted[2] ?? "";
    const startColumn = beforeCursor.length - rawPath.length;
    const endColumn = position.character + findQuotedEndOffset(afterCursor, quote);

    return createCompletionContext(position, "url", rawPath, startColumn, endColumn, quote);
  }

  const urlUnquoted = URL_COMPLETION_UNQUOTED.exec(beforeCursor);
  if (urlUnquoted) {
    const rawPath = urlUnquoted[1] ?? "";
    const startColumn = beforeCursor.length - rawPath.length;
    const endColumn = position.character + findUnquotedEndOffset(afterCursor);

    return createCompletionContext(position, "url", rawPath, startColumn, endColumn, undefined);
  }

  return undefined;
}
