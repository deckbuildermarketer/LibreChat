import { AIMessage, HumanMessage } from '@librechat/agents/langchain/messages';
import {
  getDBMMemoryAssistantOutput,
  getDBMMemoryQuery,
  selectDBMMemoryAliases,
  selectRootDBMMemoryAlias,
} from './dbmMemoryRun';

describe('DBM memory createRun wrapper helpers', () => {
  it('uses the latest human message as recall query', () => {
    const messages = [
      new HumanMessage('older request'),
      new AIMessage('older answer'),
      new HumanMessage('current request'),
    ];
    expect(getDBMMemoryQuery(messages)).toBe('current request');
  });

  it('uses the latest AI message as extraction output', () => {
    const messages = [new HumanMessage('request'), new AIMessage('final answer')];
    expect(getDBMMemoryAssistantOutput(messages)).toBe('final answer');
  });

  it('selects only aliases present in the reachable graph', () => {
    const aliases = [
      { librechatAgentId: 'agent_a', memoryKey: 'agent:a' },
      { librechatAgentId: 'agent_b', memoryKey: 'agent:b' },
      { librechatAgentId: 'agent_other', memoryKey: 'agent:other' },
    ];
    expect(selectDBMMemoryAliases([{ id: 'agent_a' }, { id: 'agent_b' }], aliases, 8)).toEqual([
      aliases[0],
      aliases[1],
    ]);
  });

  it('prioritizes reachable graph order over gateway alias order', () => {
    const aliases = [
      { librechatAgentId: 'agent_child', memoryKey: 'agent:child' },
      { librechatAgentId: 'agent_root', memoryKey: 'agent:root' },
    ];
    expect(
      selectDBMMemoryAliases([{ id: 'agent_root' }, { id: 'agent_child' }], aliases, 1),
    ).toEqual([aliases[1]]);
  });

  it('selects only the exact root alias for PRE-RUN recall', () => {
    const aliases = [
      { librechatAgentId: 'agent_child', memoryKey: 'agent:child' },
      { librechatAgentId: 'agent_root', memoryKey: 'agent:root' },
    ];
    expect(selectRootDBMMemoryAlias({ id: 'agent_root' }, aliases)).toEqual(aliases[1]);
  });

  it('does not fall through to a child when the root has no registered alias', () => {
    const aliases = [{ librechatAgentId: 'agent_child', memoryKey: 'agent:child' }];
    expect(selectRootDBMMemoryAlias({ id: 'agent_unregistered_root' }, aliases)).toBeUndefined();
  });
});
