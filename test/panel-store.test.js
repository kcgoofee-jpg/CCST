import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/panel/core/store.js';

test('get returns the initial state and set merges a patch', () => {
    const s = createStore({ a: 1, b: 2 });
    assert.deepEqual(s.get(), { a: 1, b: 2 });
    s.set({ b: 3, c: 4 });
    assert.deepEqual(s.get(), { a: 1, b: 3, c: 4 });
});

test('subscribers hear only the keys they asked for, with the changed keys', () => {
    const s = createStore({ a: 1, b: 2 });
    const seen = [];
    s.subscribe('a', (state, changed) => seen.push(['a', state.a, changed]));
    s.subscribe(['b', 'c'], (state, changed) => seen.push(['bc', state.b, changed]));
    s.subscribe('*', (_state, changed) => seen.push(['*', changed]));
    s.set({ a: 5 });
    s.set({ b: 6, c: 7 });
    assert.deepEqual(seen, [
        ['a', 5, ['a']], ['*', ['a']],
        ['bc', 6, ['b', 'c']], ['*', ['b', 'c']],
    ]);
});

test('every key named in a patch counts as changed, even with an equal value (a pulse)', () => {
    const s = createStore({ pulse: 0 });
    let n = 0;
    s.subscribe('pulse', () => n++);
    s.set({ pulse: 0 });
    s.set({ pulse: 0 });
    assert.equal(n, 2);
});

test('subscribers run in registration order and see the new state', () => {
    const s = createStore({ x: 0 });
    const order = [];
    s.subscribe('x', (st) => order.push(`first:${st.x}`));
    s.subscribe('x', (st) => order.push(`second:${st.x}`));
    s.set({ x: 1 });
    assert.deepEqual(order, ['first:1', 'second:1']);
});

test('unsubscribe stops further calls', () => {
    const s = createStore({ x: 0 });
    let n = 0;
    const off = s.subscribe('x', () => n++);
    s.set({ x: 1 });
    off();
    s.set({ x: 2 });
    assert.equal(n, 1);
});

test('a throwing subscriber does not stop the others or the update', () => {
    const s = createStore({ x: 0 });
    const errors = [];
    const realError = console.error;
    console.error = (...a) => errors.push(a);
    try {
        let reached = false;
        s.subscribe('x', () => { throw new Error('boom'); });
        s.subscribe('x', () => { reached = true; });
        s.set({ x: 1 });
        assert.equal(reached, true);
        assert.equal(s.get().x, 1);
        assert.equal(errors.length, 1);
    } finally {
        console.error = realError;
    }
});

test('merge updates one object-valued key without touching the rest of it', () => {
    const s = createStore({ glance: { quota: null, cache: 90, issues: null } });
    const seen = [];
    s.subscribe('glance', (st) => seen.push(st.glance));
    s.merge('glance', { quota: 42 });
    assert.deepEqual(s.get().glance, { quota: 42, cache: 90, issues: null });
    assert.equal(seen.length, 1);
    s.merge('other', { a: 1 });
    assert.deepEqual(s.get().other, { a: 1 });
});

test('an empty patch notifies nobody; state objects are replaced, not mutated', () => {
    const s = createStore({ x: 1 });
    const before = s.get();
    let n = 0;
    s.subscribe('*', () => n++);
    s.set({});
    assert.equal(n, 0);
    s.set({ x: 2 });
    assert.notEqual(s.get(), before);
    assert.equal(before.x, 1);
});
