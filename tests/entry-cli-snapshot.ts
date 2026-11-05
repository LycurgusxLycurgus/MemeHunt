import assert from 'node:assert/strict';
import {buildEntryReport} from '../src/app/report.js';
import type {EntrySnapshot} from '../src/domain/contracts.js';

/** The CLI adds a current report without changing the stored snapshot envelope. */
export function assertEntryCliSnapshot(actual:unknown,expected:unknown,message='CLI snapshot'):EntrySnapshot {
 assert.ok(actual!==null&&typeof actual==='object'&&!Array.isArray(actual),message);
 assert.ok(expected!==null&&typeof expected==='object'&&!Array.isArray(expected),message);
 assert.equal((expected as EntrySnapshot).checklistKind,'ENTRY',message+' expected frozen entry snapshot');
 assert.equal(Object.hasOwn(expected,'report'),false,message+' expected snapshot excludes CLI projection');
 const {report,...frozen}=actual as EntrySnapshot&{report?:{method?:unknown}};
 assert.equal(report?.method,'entry-outcomes-v1',message+' current report method');
 // Only the report is projected to its JSON wire representation. Every frozen field is compared intact.
 assert.deepEqual(report,JSON.parse(JSON.stringify(buildEntryReport(expected as EntrySnapshot))),message+' current report');
 assert.deepEqual(frozen,expected,message+' frozen snapshot');
 return frozen as EntrySnapshot;
}
