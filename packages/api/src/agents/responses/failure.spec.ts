import { finishFailedResponseStream } from './failure';

describe('failed Responses streams', () => {
  it('emits a machine-readable error before DONE instead of silently closing', () => {
    const frames: string[] = [];
    const res = {
      write: jest.fn((frame: string) => {
        frames.push(frame);
      }),
      end: jest.fn(),
    };
    finishFailedResponseStream(res);
    const payload = JSON.parse(frames[0].split('data: ')[1]);
    expect(payload.error.code).toBe('agent_execution_failed');
    expect(frames[0].startsWith('event: error\n')).toBe(true);
    expect(frames[1]).toBe('data: [DONE]\n\n');
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it.each([{ destroyed: true }, { writableEnded: true }])(
    'does not write to a closed transport: %j',
    (state) => {
      const res = { ...state, write: jest.fn(), end: jest.fn() };
      finishFailedResponseStream(res);
      expect(res.write).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    },
  );

  it('uses static safe error text rather than accepting a provider payload', () => {
    const frames: string[] = [];
    finishFailedResponseStream({
      write: (frame) => {
        frames.push(frame);
      },
      end: () => {},
    });
    expect(JSON.parse(frames[0].split('data: ')[1])).toEqual({
      type: 'error',
      error: {
        type: 'server_error',
        code: 'agent_execution_failed',
        message:
          'Agent execution ended before a final result was available. Inspect the current task state before continuing.',
      },
    });
  });
});
