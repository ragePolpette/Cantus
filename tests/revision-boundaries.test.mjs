import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from "node:timers/promises";
import { scaffold, ProjectState } from '../dist/index.js';
import { verifyDecision } from '../dist/run/verify.js';
const design = p => ({name:'fixture',blocks:[{name:'A',layer:'domain',path:p,description:'test',contract:'export const a=1;'}],dependencies:[]});

test('scaffold validates every target before writing and refuses traversal, drives and symlinks', t => {
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'cantus-path-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const root=path.join(parent,'root');fs.mkdirSync(root);
 for(const p of ['../outside','/tmp/outside','C:\\outside','..\\outside','C:outside']) assert.throws(()=>scaffold(root,design(p)),/path|root|relative/i);
 const outside=path.join(parent,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(root,'link'),process.platform==='win32'?'junction':'dir');
 assert.throws(()=>scaffold(root,design('link')),/symlink|junction/i);
 const mixed=design('src/ok');mixed.blocks.push({...mixed.blocks[0],name:'B',path:'../escape'});
 assert.throws(()=>scaffold(root,mixed));assert.equal(fs.existsSync(path.join(root,'src')),false);
 scaffold(root,design('src/ok'));assert.ok(fs.existsSync(path.join(root,'src/ok/index.ts')));
});

test('verifier refuses executable Git options and altered test commands', () => {
 for (const command of ['git constructor','git toString','git grep -Oecho needle','git grep --open-files-in-pager=echo needle','git diff --ext-diff','git show --textconv','git status --config-env=core.fsmonitor=EVIL','git log --output=x','git -c core.pager=echo log','pnpm test --require ./evil.js']) {
  assert.equal(verifyDecision('Bash',{command},'pnpm test').allow,false,command);
 }
 assert.equal(verifyDecision('Bash',{command:'git diff HEAD -- src/a.ts'}).allow,true);
});

test('live cache notices config-only alias changes and deletion', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cantus-alias-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'src'));
 fs.writeFileSync(path.join(root,'src/main.ts'),'import {value} from "@value"; export const result=value;');
 for(const name of ['one','two'])fs.writeFileSync(path.join(root,`src/${name}.ts`),'export const value=1;');
 const config=name=>fs.writeFileSync(path.join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{baseUrl:'.',paths:{'@value':[`src/${name}.ts`]}}}));
 config('one');const state=new ProjectState(root);const first=state.get();
 config('two');const after=state.get();assert.notStrictEqual(after,first);
 assert.ok(after.analysis.fileImports.some(i => i.from === 'src/main.ts' && i.to === 'src/two.ts'));
 assert.ok(!after.analysis.fileImports.some(i => i.from === 'src/main.ts' && i.to === 'src/one.ts'));
 fs.rmSync(path.join(root,'tsconfig.json'));assert.notStrictEqual(state.get(),after);
});

test("malformed map entries report their field instead of throwing during analysis", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-invalid-map-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, ".cantus", "model.json");
  fs.mkdirSync(path.dirname(target));
  fs.writeFileSync(target, JSON.stringify({ version: 1, name: "invalid", blocks: [null] }));
  assert.throws(() => new ProjectState(root).get(), /blocks\[0\] must be an object/);
  fs.writeFileSync(target, JSON.stringify({ version: 1, name: "invalid", blocks: [], rules: { allow: { domain: true } } }));
  assert.throws(() => new ProjectState(root).get(), /rules\.allow\.domain must be a list/);
});

test("live and persisted analysis refresh after a same-size edit with preserved mtime", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-preserved-mtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.ts");
  fs.writeFileSync(source, "export function before() { return 1; }");
  const mtime = new Date("2025-01-01T00:00:00Z");
  fs.utimesSync(source, mtime, mtime);
  const state = new ProjectState(root);
  const first = state.get();
  assert.ok(first.analysis.catalog.some(entry => entry.name === "before"));

  // Some file systems expose change time at the operating system clock resolution.
  await delay(25);
  fs.writeFileSync(source, "export function after_() { return 1; }");
  fs.utimesSync(source, mtime, mtime);
  for (const current of [new ProjectState(root), state]) {
    const refreshed = current.get();
    assert.notEqual(refreshed.fingerprint, first.fingerprint);
    assert.ok(refreshed.analysis.catalog.some(entry => entry.name === "after_"));
    assert.ok(!refreshed.analysis.catalog.some(entry => entry.name === "before"));
  }
});
