import { logger } from '@librechat/data-schemas';
import type * as t from './types';

const DEFAULT_MAX_CHARS = 24000;
const DEFAULT_TAIL_CHARS = 3000;
const DEFAULT_MAX_ARRAY_ITEMS = 30;
const DEFAULT_MAX_DOC_PARAGRAPHS = 140;
const DEFAULT_MAX_DOC_LINKS = 80;

const NEVER_COMPACT_RE =
  /(?:^|_)(?:create|update|write|edit|delete|remove|send|copy|move|append|insert|format|batchupdate|apply)(?:_|$)/i;
const READ_LIKE_RE =
  /(?:^|_)(?:read|get|list|search|find|fetch|query|inspect|overview|ideas|related|serp)(?:_|$)/i;
const RAW_MODE_KEYS = new Set([
  'raw',
  'full',
  'include_structure',
  'includestructure',
  'with_indexes',
  'withindexes',
  'return_raw',
  'returnraw',
  'detail',
  'mode',
  'view',
  'format',
]);
const RAW_MODE_VALUES = new Set(['raw', 'full', 'structure', 'structural', 'debug']);

type ToolArguments = Record<string, unknown> | string | undefined;

type CompactGoogleDoc = {
  title?: string;
  headings: string[];
  text: string;
  paragraphs: Array<{
    startIndex?: number;
    endIndex?: number;
    style?: string;
    text: string;
  }>;
  links: Array<{
    startIndex?: number;
    endIndex?: number;
    text: string;
    url: string;
  }>;
};

function enabled(): boolean {
  const raw = String(process.env.DBM_MCP_RESULT_COMPACTION ?? 'true')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeKey(value: string): string {
  return value.replace(/[-\s]/g, '').toLowerCase();
}

function requestsRawResult(toolArguments: ToolArguments): boolean {
  if (!toolArguments || typeof toolArguments === 'string') return false;

  const inspect = (value: unknown, depth = 0): boolean => {
    if (depth > 3 || value == null) return false;
    if (Array.isArray(value)) return value.some((item) => inspect(item, depth + 1));
    if (typeof value !== 'object') return false;

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeKey(key);
      if (RAW_MODE_KEYS.has(key.toLowerCase()) || RAW_MODE_KEYS.has(normalized)) {
        if (child === true) return true;
        if (typeof child === 'string' && RAW_MODE_VALUES.has(child.trim().toLowerCase())) return true;
      }
      if (inspect(child, depth + 1)) return true;
    }
    return false;
  };

  return inspect(toolArguments);
}

function shouldCompactTool(toolName: string, toolArguments?: ToolArguments): boolean {
  if (NEVER_COMPACT_RE.test(toolName)) return false;
  if (requestsRawResult(toolArguments)) return false;
  return READ_LIKE_RE.test(toolName);
}

function cleanInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractParagraphText(paragraph: Record<string, unknown>): string {
  const elements = Array.isArray(paragraph.elements) ? paragraph.elements : [];
  return elements
    .map((element) => {
      if (!element || typeof element !== 'object') return '';
      const textRun = (element as Record<string, unknown>).textRun;
      if (!textRun || typeof textRun !== 'object') return '';
      const content = (textRun as Record<string, unknown>).content;
      return typeof content === 'string' ? content : '';
    })
    .join('');
}

function extractParagraphLinks(
  paragraph: Record<string, unknown>,
  destination: CompactGoogleDoc['links'],
): void {
  const elements = Array.isArray(paragraph.elements) ? paragraph.elements : [];
  for (const element of elements) {
    if (!element || typeof element !== 'object') continue;
    const elementObject = element as Record<string, unknown>;
    const textRun = elementObject.textRun;
    if (!textRun || typeof textRun !== 'object') continue;
    const run = textRun as Record<string, unknown>;
    const style = run.textStyle;
    if (!style || typeof style !== 'object') continue;
    const link = (style as Record<string, unknown>).link;
    if (!link || typeof link !== 'object') continue;
    const url = (link as Record<string, unknown>).url;
    if (typeof url !== 'string' || !url) continue;
    const content = typeof run.content === 'string' ? cleanInlineText(run.content) : '';
    destination.push({
      ...(typeof elementObject.startIndex === 'number'
        ? { startIndex: elementObject.startIndex }
        : {}),
      ...(typeof elementObject.endIndex === 'number' ? { endIndex: elementObject.endIndex } : {}),
      text: content,
      url,
    });
  }
}

/**
 * Converts the extremely verbose Google Docs API tree into a compact representation that still
 * preserves the information DBM needs for *both* research and final mutation: readable text,
 * heading hierarchy, paragraph start/end indexes, and hyperlink ranges/URLs.
 *
 * This is deliberately richer than a plain-text extractor. The old full read_doc payload could
 * cost tens of thousands of tokens, but dropping indexes entirely would force a second raw read
 * during formatting. Keeping a small paragraph/index map avoids that regression.
 */
function flattenGoogleDoc(node: unknown): CompactGoogleDoc | null {
  if (!node || typeof node !== 'object') return null;
  const root = node as Record<string, unknown>;
  const title = typeof root.title === 'string' ? root.title : undefined;
  const textParts: string[] = [];
  const headings: string[] = [];
  const paragraphs: CompactGoogleDoc['paragraphs'] = [];
  const links: CompactGoogleDoc['links'] = [];

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;

    const obj = value as Record<string, unknown>;
    const paragraphValue = obj.paragraph;
    if (paragraphValue && typeof paragraphValue === 'object') {
      const paragraph = paragraphValue as Record<string, unknown>;
      const paragraphStyle = paragraph.paragraphStyle;
      const style =
        paragraphStyle &&
        typeof paragraphStyle === 'object' &&
        typeof (paragraphStyle as Record<string, unknown>).namedStyleType === 'string'
          ? String((paragraphStyle as Record<string, unknown>).namedStyleType)
          : undefined;
      const paragraphText = extractParagraphText(paragraph);
      textParts.push(paragraphText);

      const clean = cleanInlineText(paragraphText);
      if (clean) {
        paragraphs.push({
          ...(typeof obj.startIndex === 'number' ? { startIndex: obj.startIndex } : {}),
          ...(typeof obj.endIndex === 'number' ? { endIndex: obj.endIndex } : {}),
          ...(style ? { style } : {}),
          text: clean,
        });
        if (style && /^HEADING_[1-6]$/.test(style)) {
          headings.push(`${style}: ${clean}`);
        }
      }
      extractParagraphLinks(paragraph, links);
      return;
    }

    const textRun = obj.textRun;
    if (textRun && typeof textRun === 'object') {
      const content = (textRun as Record<string, unknown>).content;
      if (typeof content === 'string') textParts.push(content);
      return;
    }

    for (const child of Object.values(obj)) walk(child);
  };

  walk(root);
  const text = textParts.join('').replace(/\n{3,}/g, '\n\n').trim();
  if (!text || textParts.length < 2) return null;

  const dedupedLinks = links.filter(
    (link, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.url === link.url &&
          candidate.startIndex === link.startIndex &&
          candidate.endIndex === link.endIndex,
      ) === index,
  );

  return {
    ...(title ? { title } : {}),
    headings: [...new Set(headings)],
    text,
    paragraphs,
    links: dedupedLinks,
  };
}

function pruneJson(value: unknown, maxItems: number, depth = 0): unknown {
  if (depth > 7) return '[omitted: depth limit]';
  if (Array.isArray(value)) {
    const sliced = value.slice(0, maxItems).map((item) => pruneJson(item, maxItems, depth + 1));
    if (value.length > maxItems) {
      sliced.push(`[${value.length - maxItems} additional items omitted for context efficiency]`);
    }
    return sliced;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 8000) {
      return `${value.slice(0, 7000)}\n…[${value.length - 8000} chars omitted]…\n${value.slice(-1000)}`;
    }
    return value;
  }

  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const noisyKeys = new Set([
    'revisionId',
    'documentStyle',
    'namedStyles',
    'suggestedDocumentStyleChanges',
    'suggestedNamedStylesChanges',
    'inlineObjects',
    'positionedObjects',
  ]);
  for (const [key, child] of Object.entries(source)) {
    if (noisyKeys.has(key)) continue;
    output[key] = pruneJson(child, maxItems, depth + 1);
  }
  return output;
}

function clipInline(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return value.slice(0, Math.max(0, maxChars));
  return `${value.slice(0, Math.max(1, maxChars - 1))}…`;
}

function clipHeadTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars < 48) return clipInline(value, maxChars);
  const marker = ' … ';
  const head = Math.ceil((maxChars - marker.length) * 0.72);
  const tail = Math.max(1, maxChars - marker.length - head);
  return `${value.slice(0, head)}${marker}${value.slice(-tail)}`;
}

function renderGoogleDoc(doc: CompactGoogleDoc, maxChars: number): string {
  const maxParagraphs = positiveInt('DBM_MCP_DOC_MAX_PARAGRAPHS', DEFAULT_MAX_DOC_PARAGRAPHS);
  const maxLinks = positiveInt('DBM_MCP_DOC_MAX_LINKS', DEFAULT_MAX_DOC_LINKS);
  const blocks: string[] = [];

  const currentLength = (): number => blocks.join('\n\n').length;
  const remaining = (): number => Math.max(0, maxChars - currentLength());

  const appendSingle = (value: string): boolean => {
    if (!value) return true;
    const separatorCost = blocks.length ? 2 : 0;
    const available = remaining() - separatorCost;
    if (available <= 0) return false;
    blocks.push(clipInline(value, available));
    return value.length <= available;
  };

  const appendLines = (label: string, lines: string[], omittedLabel: string): void => {
    if (!lines.length || remaining() <= label.length + 6) return;
    const separatorCost = blocks.length ? 2 : 0;
    const available = remaining() - separatorCost;
    const prefix = `${label}:\n`;
    if (available <= prefix.length + 8) return;

    const selected: string[] = [];
    let used = prefix.length;
    for (const line of lines) {
      const separator = selected.length ? 1 : 0;
      if (used + separator + line.length > available) break;
      selected.push(line);
      used += separator + line.length;
    }

    if (selected.length < lines.length) {
      const marker = `[${lines.length - selected.length} additional ${omittedLabel} omitted]`;
      const separator = selected.length ? 1 : 0;
      if (used + separator + marker.length <= available) {
        selected.push(marker);
      }
    }

    if (selected.length) {
      blocks.push(prefix + selected.join('\n'));
    }
  };

  if (doc.title) appendSingle(`Title: ${doc.title}`);

  appendLines(
    'Headings',
    doc.headings.map((heading) => clipInline(heading, 240)),
    'headings',
  );

  // Hyperlinks are intentionally rendered before verbose paragraph/plain-text
  // content. They frequently carry Preview/Edit/source URLs that downstream
  // agents must not lose merely because the document body is long.
  const linkLines = doc.links.slice(0, maxLinks).map((link) => {
    const range =
      link.startIndex != null || link.endIndex != null
        ? `[${link.startIndex ?? '?'}:${link.endIndex ?? '?'}]`
        : '[?:?]';
    return `${range} ${clipInline(link.text || '(linked text)', 120)} -> ${link.url}`;
  });
  if (doc.links.length > maxLinks) {
    linkLines.push(`[${doc.links.length - maxLinks} additional links omitted]`);
  }
  appendLines('Hyperlinks', linkLines, 'links');

  const paragraphLines = doc.paragraphs.slice(0, maxParagraphs).map((paragraph) => {
    const range =
      paragraph.startIndex != null || paragraph.endIndex != null
        ? `[${paragraph.startIndex ?? '?'}:${paragraph.endIndex ?? '?'}]`
        : '[?:?]';
    return `${range} ${paragraph.style ?? 'NORMAL_TEXT'} | ${clipInline(paragraph.text, 220)}`;
  });
  if (doc.paragraphs.length > maxParagraphs) {
    paragraphLines.push(
      `[${doc.paragraphs.length - maxParagraphs} additional paragraph index entries omitted]`,
    );
  }
  appendLines('Paragraph index map', paragraphLines, 'paragraph entries');

  if (doc.text && remaining() > 32) {
    const separatorCost = blocks.length ? 2 : 0;
    const prefix = 'Plain text:\n';
    const available = remaining() - separatorCost - prefix.length;
    if (available > 16) {
      blocks.push(prefix + clipHeadTail(doc.text, available));
    }
  }

  const rendered = blocks.join('\n\n');
  return rendered.length <= maxChars ? rendered : rendered.slice(0, maxChars);
}

function compactText(content: string, serverName: string, toolName: string): string {
  const maxChars = positiveInt('DBM_MCP_RESULT_MAX_CHARS', DEFAULT_MAX_CHARS);
  if (content.length <= maxChars) return content;

  let compacted = content;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (/read[_-]?doc/i.test(toolName) || /google[-_ ]?docs?/i.test(serverName)) {
      const doc = flattenGoogleDoc(parsed);
      compacted = doc
        ? renderGoogleDoc(doc, maxChars)
        : JSON.stringify(
            pruneJson(parsed, positiveInt('DBM_MCP_RESULT_MAX_ITEMS', DEFAULT_MAX_ARRAY_ITEMS)),
          );
    } else {
      compacted = JSON.stringify(
        pruneJson(parsed, positiveInt('DBM_MCP_RESULT_MAX_ITEMS', DEFAULT_MAX_ARRAY_ITEMS)),
      );
    }
  } catch {
    // Non-JSON read results are safely clipped below. The first portion carries normal
    // document/article content; a small tail preserves totals, cursors, and terminal errors.
  }

  if (compacted.length > maxChars) {
    const tailChars = Math.min(
      positiveInt('DBM_MCP_RESULT_TAIL_CHARS', DEFAULT_TAIL_CHARS),
      Math.floor(maxChars / 3),
    );
    const headChars = Math.max(1, maxChars - tailChars - 260);
    compacted = `${compacted.slice(0, headChars)}\n\n[DBM_CONTEXT_COMPACTION: ${Math.max(0, compacted.length - headChars - tailChars)} characters omitted. Request a narrower range/query if the omitted section is required. For a precise structural/debug read, explicitly request raw/full/structure mode when that MCP supports it.]\n\n${compacted.slice(-tailChars)}`;
  }
  return compacted;
}

export function compactMCPResult(
  formatted: t.FormattedContentResult,
  context: { serverName: string; toolName: string; toolArguments?: ToolArguments },
): t.FormattedContentResult {
  if (!enabled() || !shouldCompactTool(context.toolName, context.toolArguments)) return formatted;
  const [content, artifacts] = formatted;
  if (typeof content !== 'string') return formatted;
  const compacted = compactText(content, context.serverName, context.toolName);
  if (compacted === content) return formatted;

  const rawChars = content.length;
  const compactChars = compacted.length;
  logger.info('[DBM Context Budget] Compacted MCP read result', {
    serverName: context.serverName,
    toolName: context.toolName,
    rawChars,
    compactChars,
    savedChars: rawChars - compactChars,
    savedPercent: Math.round(((rawChars - compactChars) / rawChars) * 100),
  });
  return [compacted, artifacts];
}
