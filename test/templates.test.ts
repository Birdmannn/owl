import test from "node:test";
import assert from "node:assert/strict";
import { ccc } from "@ckb-ccc/core";
import { matchesPilotTransactionTemplate, pilotTemplateHash, validatePilotTransactionTemplate, type PilotTransactionTemplate } from "../src/wallet/templates.js";
const h = (n: number) => ccc.hexFrom(new Uint8Array(32).fill(n));
const script = (n: number, args: ccc.Hex = "0x01") => ccc.Script.from({codeHash: h(n), hashType: "data2", args});
const account = script(1), owner = script(2);
function fixture() {
  const app = script(3), typ = script(4);
  const t: PilotTransactionTemplate = {
    version: 1, id: 'buy', maxSpend: '100',
    inputs: [{role: 'campaign', lock: {codeHash: app.codeHash, hashType: app.hashType, args: {length: 1}}, type: {codeHash: typ.codeHash, hashType: typ.hashType, args: {prefix: '0x'}}, data: {length: 2}}],
    outputs: [
      {role: 'campaign', lock: {codeHash: app.codeHash, hashType: app.hashType, args: {length: 1}}, type: {codeHash: typ.codeHash, hashType: typ.hashType, args: {prefix: '0x'}}, data: {length: 2}},
      {role: 'ticket', min: 1, max: 3, lock: 'account', type: null, data: {length: 32, fields: [{offset: 0, value: 'accountLockHash'}]}},
    ],
    relations: [
      {left: {source: 'input', role: 'campaign', field: 'lock'}, right: {source: 'output', role: 'campaign', field: 'lock'}},
      {left: {source: 'input', role: 'campaign', field: 'type'}, right: {source: 'output', role: 'campaign', field: 'type'}},
      {left: {source: 'input', role: 'campaign', field: 'data', offset: 0, length: 1}, right: {source: 'output', role: 'campaign', field: 'data', offset: 0, length: 1}},
    ],
    witnesses: [{inputRole: 'campaign', field: 'outputType', equals: '0x03'}],
  };
  const output = ccc.CellOutput.from({lock: app, type: typ, capacity: ccc.fixedPointFrom(200)});
  const ticket = ccc.CellOutput.from({lock: account, capacity: ccc.fixedPointFrom(200)});
  const tx = ccc.Transaction.default(); tx.setWitnessArgs(0, {outputType: '0x03'});
  const e = {inputs: [{output, data: '0x0100' as ccc.Hex, index: 0}], outputs: [
    {output: output.clone(), data: '0x0101' as ccc.Hex, index: 0},
    {output: ticket, data: account.hash(), index: 1},
  ], tx, spent: 100n};
  return { t, e, match: () => matchesPilotTransactionTemplate(t, e, account, owner) };
}
test('templates allow new instances while pinning cross-cell identity, beneficiaries and witnesses', () => {
  const f = fixture();
  assert.equal(f.match(), true);
  for (const args of ['0x02', '0x03'] as const) {
    f.e.inputs[0]!.output.lock.args = args; f.e.outputs[0]!.output.lock.args = args;
    f.e.inputs[0]!.output.type!.args = args; f.e.outputs[0]!.output.type!.args = args;
    assert.equal(f.match(), true);
  }
  f.e.outputs[0]!.output.lock.args = '0x04'; assert.equal(f.match(), false);
});
test('templates reject wrong beneficiary, unexpected outputs, wrong witness, overspend and absent required roles', () => {
  const cases = [
    (f: ReturnType<typeof fixture>) => { f.e.outputs[1]!.data = h(9); },
    (f: ReturnType<typeof fixture>) => { f.e.outputs.push({...f.e.outputs[1]!, output: ccc.CellOutput.from({lock: owner})}); },
    (f: ReturnType<typeof fixture>) => { f.e.tx.setWitnessArgs(0, {outputType: '0x04'}); },
    (f: ReturnType<typeof fixture>) => { f.e.spent = 101n; },
    (f: ReturnType<typeof fixture>) => { f.e.outputs.splice(1); },
    (f: ReturnType<typeof fixture>) => { f.e.outputs[0]!.data = '0x0201'; },
    (f: ReturnType<typeof fixture>) => { f.e.outputs[0]!.output.type!.hashType = 'type'; },
  ];
  for (const mutate of cases) { const f = fixture(); mutate(f); assert.equal(f.match(), false); }
});
test('bounded repetition and ambiguous roles fail closed; unknown fields cannot silently weaken checks', () => {
  const f = fixture();
  f.e.outputs.push({...f.e.outputs[1]!}); assert.equal(f.match(), true);
  f.e.outputs.push({...f.e.outputs[1]!}); assert.equal(f.match(), true);
  f.e.outputs.push({...f.e.outputs[1]!}); assert.equal(f.match(), false);
  const overlap = fixture(); overlap.t.outputs = [...overlap.t.outputs, {...overlap.t.outputs[1]!, role: 'also-ticket'}];
  assert.equal(overlap.match(), false);
  const invalid = {...fixture().t, maxSpendPerAction: '1'};
  assert.throws(() => validatePilotTransactionTemplate(invalid), /Invalid transaction template/);
});
test('template commitments are canonical and bind every approved rule', () => {
  const {t} = fixture();
  const reordered = {outputs: t.outputs, inputs: t.inputs, id: t.id, version: t.version, maxSpend: t.maxSpend, witnesses: t.witnesses, relations: t.relations};
  assert.equal(pilotTemplateHash(t), pilotTemplateHash(reordered));
  const changed = structuredClone(t); changed.maxSpend = '101';
  assert.notEqual(pilotTemplateHash(t), pilotTemplateHash(changed));
});

test('script and data byte fields bind account-specific prefixes without fixing future instance arguments', () => {
  const f = fixture();
  f.t.inputs = [];
  f.t.relations = [];
  f.t.witnesses = [];
  f.e.inputs = [];
  f.t.outputs = [{role: 'owned-instance', lock: {codeHash: h(3), hashType: 'data2', args: {length: 21, fields: [{offset: 0, value: {account: 'accountLockHash', offset: 0, length: 20}}]}}, type: null, data: {length: 1, fields: [{offset: 0, value: 'accountLockArgs'}]}}];
  f.e.outputs = [{output: ccc.CellOutput.from({lock: script(3, `${account.hash().slice(0,42)}ff` as ccc.Hex)}), data: account.args, index: 0}];
  assert.equal(f.match(), true);
  f.e.outputs[0]!.output.lock.args = `${owner.hash().slice(0,42)}ff` as ccc.Hex;
  assert.equal(f.match(), false);
});
