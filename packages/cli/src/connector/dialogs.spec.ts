import { dialogResponse, dialogToQuestion, questionIdOf } from './dialogs';

const req = (extra: Record<string, unknown>) =>
  ({ type: 'extension_ui_request', id: 'r/1', ...extra }) as never;

describe('dialogs', () => {
  it('makes a plain token of the dialog id', () => {
    expect(questionIdOf('r/1 x')).toBe('omp-r_1_x');
  });

  it('ignores methods that wait for nobody', () => {
    expect(
      dialogToQuestion(req({ method: 'notify', message: 'hi' })),
    ).toBeNull();
  });

  it('turns a select into options and replies with the label', () => {
    const q = dialogToQuestion(
      req({ method: 'select', title: 'Pick', options: ['a', 'b'] }),
    )!;
    expect(q.items[0]!.options?.map((o) => o.label)).toEqual(['a', 'b']);
    expect(
      dialogResponse(q.dialog, {
        status: 'answered',
        answers: [{ id: 'dialog', selected: ['b'] }],
      }),
    ).toEqual({ value: 'b' });
  });

  it('falls back to free text for too many options', () => {
    const q = dialogToQuestion(
      req({ method: 'select', options: ['1', '2', '3', '4', '5', '6', '7'] }),
    )!;
    expect(q.items[0]!.options).toBeUndefined();
    expect(q.items[0]!.allowOther).toBe(true);
  });

  it('maps confirm to Yes and No', () => {
    const q = dialogToQuestion(req({ method: 'confirm', title: 'Sure?' }))!;
    expect(
      dialogResponse(q.dialog, {
        status: 'answered',
        answers: [{ id: 'dialog', selected: ['Yes'] }],
      }),
    ).toEqual({ confirmed: true });
  });

  it('cancels a dialog nobody answered, and says when it timed out', () => {
    const q = dialogToQuestion(req({ method: 'input', title: 'Name' }))!;
    expect(
      dialogResponse(q.dialog, { status: 'expired', answers: [] }),
    ).toEqual({ cancelled: true, timedOut: true });
    expect(
      dialogResponse(q.dialog, { status: 'cancelled', answers: [] }),
    ).toEqual({ cancelled: true, timedOut: false });
  });
});
