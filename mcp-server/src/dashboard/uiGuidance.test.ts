import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');

function loadFunction(name: string, context: Record<string, unknown>) {
  const match = source.match(new RegExp(`^  function ${name}\\([\\s\\S]*?^  }`, 'm'));
  if (!match) throw new Error(`Missing browser function ${name}`);
  return vm.runInNewContext(`${match[0]}; ${name}`, context);
}

class Element {
  children: Element[] = [];
  hidden = false;
  textContent = '';
  type = '';
  click?: () => Promise<void>;

  appendChild(child: Element) { this.children.push(child); }
  addEventListener(_event: string, callback: () => Promise<void>) { this.click = callback; }
}

function renderGuidance(state: Record<string, unknown>) {
  const refs = { approvals: new Element(), approvalList: new Element() };
  const copied: string[] = [];
  const render = loadFunction('renderApprovals', {
    view: { state: { runId: 'run-123', pendingApprovals: [], ...state } },
    refs,
    document: { createElement: () => new Element() },
    el: (_tag: string, _className: string, text = '') => Object.assign(new Element(), { textContent: text }),
    clear: (element: Element) => { element.children = []; },
    words: (value: string) => value.replaceAll('_', ' '),
    navigator: { clipboard: { writeText: async (value: string) => { copied.push(value); } } },
    setTimeout: () => {},
  });
  render();
  return { refs, copied };
}

describe('dashboard decision guidance', () => {
  it.each([
    ['awaiting_acceptance', '/swarm-accept run-123'],
    ['interrupted', '/swarm-resume run-123'],
    ['paused_budget', '/swarm-status run-123'],
  ])('shows the next command for %s without requiring an approval record', (status, command) => {
    const { refs } = renderGuidance({ status });
    expect(refs.approvals.hidden).toBe(false);
    expect(refs.approvalList.children[0].children[1].textContent).toBe(command);
  });

  it('copies an approval-specific command without choosing a resolution', async () => {
    const { refs, copied } = renderGuidance({
      status: 'paused_human',
      pendingApprovals: [{ id: 'approval-456', kind: 'spend', description: 'Review budget' }],
    });
    const approval = refs.approvalList.children[1];
    await approval.children[3].click?.();
    expect(copied).toEqual(['/swarm-decide run-123 approval-456']);
  });

  it('does not imply that a connected stream is an executing run', () => {
    const connEl = { dataset: {}, textContent: '', title: '' };
    const view = { runId: null as string | null };
    const setConnection = loadFunction('setConnection', { connEl, view });
    setConnection('live');
    expect(connEl.textContent).toBe('Events connected');
    setConnection('idle');
    expect(connEl.textContent).toBe('No run selected');
    view.runId = 'run-123';
    setConnection('idle');
    expect(connEl.textContent).toBe('Saved record');
  });
});
