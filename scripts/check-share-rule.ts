import assert from 'node:assert/strict';
import { reshareable, originalReshareable, type ShareParent } from '../src/share-rule.ts';

// Test: parent reshareable + public = true
const parent1: ShareParent = { reshareable: true };
assert.equal(reshareable(parent1, 'public'), true, 'parent reshareable + public should be true');

// Test: parent reshareable + private = false
assert.equal(reshareable(parent1, 'private'), false, 'parent reshareable + private should be false');

// Test: parent NOT reshareable + public = false
const parent2: ShareParent = { reshareable: false };
assert.equal(reshareable(parent2, 'public'), false, 'parent NOT reshareable + public should be false');

// Test: chain of three with all public
const chainParent1: ShareParent = { reshareable: true };
const child1Public = reshareable(chainParent1, 'public');
assert.equal(child1Public, true, 'originalReshareable -> public should be true');
const chainParent2: ShareParent = { reshareable: child1Public };
const grandchild1Public = reshareable(chainParent2, 'public');
assert.equal(grandchild1Public, true, 'chain public -> public -> public should be true');

// Test: chain with middle private
const chainParent3: ShareParent = { reshareable: true };
const child2Private = reshareable(chainParent3, 'private');
assert.equal(child2Private, false, 'originalReshareable -> private should be false');
const chainParent4: ShareParent = { reshareable: child2Private };
const grandchild2Private = reshareable(chainParent4, 'public');
assert.equal(grandchild2Private, false, 'chain public -> private -> public should be false');

// Test: missing parent (null) + public = false
assert.equal(reshareable(null, 'public'), false, 'null parent + public should be false');

// Test: missing parent (undefined) + public = false
assert.equal(reshareable(undefined, 'public'), false, 'undefined parent + public should be false');

// Test: originalReshareable('private') = false
assert.equal(originalReshareable('private'), false, 'originalReshareable(private) should be false');

// Test: originalReshareable('public') = true
assert.equal(originalReshareable('public'), true, 'originalReshareable(public) should be true');

console.log('share-rule: all checks passed');
process.exit(0);
