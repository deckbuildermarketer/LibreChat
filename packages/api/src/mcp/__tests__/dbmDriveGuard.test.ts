import {
  createGoogleDriveLargeFileRecovery,
  isOversizedGoogleDriveDownload,
} from '../dbmDriveGuard';

describe('DBM Google Drive oversized-response guard', () => {
  it('detects the Google Drive download_file_content byte-limit failure', () => {
    const error = new Error(
      '[MCP] MCP response exceeded byte limit (limit=16777216 bytes, observed=16788125 bytes, chunks=7375)',
    );

    expect(
      isOversizedGoogleDriveDownload({
        serverName: 'google-drive',
        toolName: 'download_file_content',
        error,
      }),
    ).toBe(true);
  });

  it('does not intercept other MCP servers or unrelated Drive errors', () => {
    const byteLimit = new Error('MCP response exceeded byte limit (limit=16777216 bytes)');
    expect(
      isOversizedGoogleDriveDownload({
        serverName: 'google-docs',
        toolName: 'download_file_content',
        error: byteLimit,
      }),
    ).toBe(false);
    expect(
      isOversizedGoogleDriveDownload({
        serverName: 'google-drive',
        toolName: 'search_files',
        error: byteLimit,
      }),
    ).toBe(false);
    expect(
      isOversizedGoogleDriveDownload({
        serverName: 'google-drive',
        toolName: 'download_file_content',
        error: new Error('401 Unauthorized'),
      }),
    ).toBe(false);
  });

  it('detects the byte-limit message through nested causes', () => {
    const cause = new Error('MCP response exceeded byte limit');
    const outer = new Error('tool call failed', { cause });
    expect(
      isOversizedGoogleDriveDownload({
        serverName: 'google-drive',
        toolName: 'download_file_content',
        error: outer,
      }),
    ).toBe(true);
  });

  it('returns an actionable compact recovery result without the payload', () => {
    const [content, artifacts] = createGoogleDriveLargeFileRecovery({
      fileId: 'file-123',
      exportMimeType: 'text/plain',
    });

    expect(artifacts).toBeUndefined();
    expect(content).toContain('DBM_GOOGLE_DRIVE_LARGE_FILE_RECOVERY');
    expect(content).toContain('Do not retry download_file_content');
    expect(content).toContain('google-docs MCP');
    expect(content).toContain('google-sheets MCP');
    expect(content).toContain('google-slides MCP');
    expect(content).toContain('fileId=file-123');
    expect(content).toContain('exportMimeType=text/plain');
  });
});
