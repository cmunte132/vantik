import { cycleChangeRows } from './cycle-history';

const issue = { id: 'i1', stateId: 's1', estimate: 3 };

describe('cycleChangeRows', () => {
  it('writes ADDED for an issue created in a cycle', () => {
    const rows = cycleChangeRows(issue, null, 'c1', 'u1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cycleId: 'c1',
      issueId: 'i1',
      userId: 'u1',
      changeType: 'ADDED',
      toEstimate: 3,
    });
  });

  it('writes MOVED then ADDED when the cycle changes', () => {
    const rows = cycleChangeRows(issue, 'c1', 'c2', 'u1');
    expect(rows.map((r) => [r.cycleId, r.changeType])).toEqual([
      ['c1', 'MOVED'],
      ['c2', 'ADDED'],
    ]);
  });

  it('writes REMOVED when the issue leaves its cycle', () => {
    const rows = cycleChangeRows(issue, 'c1', null, 'u1');
    expect(rows.map((r) => [r.cycleId, r.changeType])).toEqual([
      ['c1', 'REMOVED'],
    ]);
  });

  it('writes nothing when the cycle is unchanged', () => {
    expect(cycleChangeRows(issue, 'c1', 'c1', 'u1')).toEqual([]);
    expect(cycleChangeRows(issue, null, null, 'u1')).toEqual([]);
  });
});
