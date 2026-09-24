import type * as t from './types';

const GOOGLE_DRIVE_SERVER = 'google-drive';
const GOOGLE_DRIVE_DOWNLOAD_TOOL = 'download_file_content';
const RESPONSE_BYTE_LIMIT_RE = /MCP response exceeded byte limit/i;

function errorText(error: unknown, depth = 0): string {
  if (depth > 3 || error == null) return '';
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return `${error.message}\n${errorText(cause, depth + 1)}`;
  }
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : '';
    return `${message}\n${errorText(record.cause, depth + 1)}`;
  }
  return String(error);
}

export function isOversizedGoogleDriveDownload(input: {
  serverName: string;
  toolName: string;
  error: unknown;
}): boolean {
  return (
    input.serverName === GOOGLE_DRIVE_SERVER &&
    input.toolName === GOOGLE_DRIVE_DOWNLOAD_TOOL &&
    RESPONSE_BYTE_LIMIT_RE.test(errorText(input.error))
  );
}

export function createGoogleDriveLargeFileRecovery(
  toolArguments?: Record<string, unknown>,
): t.FormattedToolResponse {
  const fileId =
    typeof toolArguments?.fileId === 'string' && toolArguments.fileId.trim()
      ? toolArguments.fileId.trim()
      : undefined;
  const exportMimeType =
    typeof toolArguments?.exportMimeType === 'string' && toolArguments.exportMimeType.trim()
      ? toolArguments.exportMimeType.trim()
      : undefined;

  const metadata = [
    fileId ? `fileId=${fileId}` : undefined,
    exportMimeType ? `exportMimeType=${exportMimeType}` : undefined,
  ]
    .filter(Boolean)
    .join(', ');

  const message = `[DBM_GOOGLE_DRIVE_LARGE_FILE_RECOVERY]
The Google Drive MCP response exceeded the MCP streamable-HTTP safety limit, so LibreChat stopped the payload before it could destabilize the agent run.

Do not retry download_file_content with the same arguments.
- For Google Docs, use the google-docs MCP and read only the needed document content.
- For Google Sheets, use the google-sheets MCP and request only the needed ranges.
- For Google Slides, use the google-slides MCP and request only the needed slides/content.
- For large binary files (PDFs, images, archives, video, etc.), use a purpose-built file-transfer/production tool instead of injecting the entire binary through an MCP tool result.
- If the file type is unknown, inspect Drive metadata first, then choose the appropriate tool.

${metadata ? `Original request: ${metadata}\n` : ''}The original oversized payload was intentionally not returned.`;

  return [message, undefined];
}
