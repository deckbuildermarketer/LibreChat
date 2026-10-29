/** A terminal transport error must survive even after HTTP headers are sent. */
export function finishFailedResponseStream(res: {
  destroyed?: boolean;
  writableEnded?: boolean;
  write: (frame: string) => boolean | void;
  end: () => void;
}): void {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  // Never forward an arbitrary tool/provider exception, arguments or private
  // source content. The client can reconcile a possibly started execution.
  const payload = {
    type: 'error',
    error: {
      type: 'server_error',
      code: 'agent_execution_failed',
      message:
        'Agent execution ended before a final result was available. Inspect the current task state before continuing.',
    },
  };
  res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
