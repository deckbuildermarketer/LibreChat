import { logger } from '@librechat/data-schemas';
import type * as t from './types';

const DEFAULT_MAX_CHARS = 24000;
const DEFAULT_TAIL_CHARS = 3000;
const DEFAULT_MAX_ARRAY_ITEMS = 30;

const NEVER_COMPACT_RE = /(?:^|_)(?:create|update|write|edit|delete|remove|send|copy|move|append|insert|format|batchupdate|apply)(?:_|$)/i;
const READ_LIKE_RE = /(?:^|_)(?:read|get|list|search|find|fetch|query|inspect|overview|ideas|related|serp)(?:_|$)/i;

function enabled(): boolean {
  const raw = String(process.env.DBM_MCP_RESULT_COMPACTION ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function shouldCompactTool(toolName: string): boolean {
  if (NEVER_COMPACT_RE.test(toolName)) return false;
  return READ_LIKE_RE.test(toolName);
}

function flattenGoogleDoc(node: unknown): { title?: string; headings: string[]; text: string } | null {
  if (!node || typeof node !== 'object') return null;
  const root = node as Record<string, unknown>;
  const title = typeof root.title === 'string' ? root.title : undefined;
  const textParts: string[] = [];
  const headings: string[] = [];

  const walk = (value: unknown, inheritedStyle?: string) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, inheritedStyle);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    const paragraph = obj.paragraph as Record<string, unknown> | undefined;
    const paragraphStyle = paragraph?.paragraphStyle as Record<string, unknown> | undefined;
    const style =
      typeof paragraphStyle?.namedStyleType === 'string'
        ? paragraphStyle.namedStyleType
        : inheritedStyle;

    const textRun = obj.textRun as Record<string, unknown> | undefined;
    if (textRun && typeof textRun.content === 'string') {
      const content = textRun.content;
      textParts.push(content);
      if (style && /^HEADING_[1-6]$/.test(style)) {
        const clean = content.replace(/\s+/g, ' ').trim();
        if (clean) headings.push(`${style}: ${clean}`);
      }
    }

    for (const [key, child] of Object.entries(obj)) {
      if (key === 'textRun' || key === 'paragraphStyle') continue;
      walk(child, style);
    }
  };

  walk(root);
  const text = textParts.join('').replace(/\n{3,}/g, '\n\n').trim();
  if (!text || textParts.length < 2) return null;
  return { ...(title ? { title } : {}), headings: [...new Set(headings)], text };
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

function compactText(content: string, serverName: string, toolName: string): string {
  const maxChars = positiveInt('DBM_MCP_RESULT_MAX_CHARS', DEFAULT_MAX_CHARS);
  if (content.length <= maxChars) return content;

  let compacted = content;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (/read[_-]?doc/i.test(toolName) || /google[-_ ]?docs?/i.test(serverName)) {
      const doc = flattenGoogleDoc(parsed);
      if (doc) {
        compacted = [
          doc.title ? `Title: ${doc.title}` : '',
          doc.headings.length ? `Headings:\n${doc.headings.join('\n')}` : '',
          `Plain text:\n${doc.text}`,
        ]
          .filter(Boolean)
          .join('\n\n');
      } else {
        compacted = JSON.stringify(pruneJson(parsed, positiveInt('DBM_MCP_RESULT_MAX_ITEMS', DEFAULT_MAX_ARRAY_ITEMS)));
      }
    } else {
      compacted = JSON.stringify(pruneJson(parsed, positiveInt('DBM_MCP_RESULT_MAX_ITEMS', DEFAULT_MAX_ARRAY_ITEMS)));
    }
  } catch {
    // Non-JSON read results are safely clipped below. The first portion carries
    // normal document/article content; a small tail preserves totals/cursors/errors.
  }

  if (compacted.length > maxChars) {
    const tailChars = Math.min(
      positiveInt('DBM_MCP_RESULT_TAIL_CHARS', DEFAULT_TAIL_CHARS),
      Math.floor(maxChars / 3),
    );
    const headChars = maxChars - tailChars - 220;
    compacted = `${compacted.slice(0, headChars)}\n\n[DBM_CONTEXT_COMPACTION: ${compacted.length - headChars - tailChars} characters omitted. Request a narrower range/query if the omitted section is required.]\n\n${compacted.slice(-tailChars)}`;
  }
  return compacted;
}

export function compactMCPResult(
  formatted: t.FormattedContentResult,
  context: { serverName: string; toolName: string },
): t.FormattedContentResult {
  if (!enabled() || !shouldCompactTool(context.toolName)) return formatted;
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
