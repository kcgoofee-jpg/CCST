import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { ROUTES, routeKeys, registerRoutes } from '../src/proxy/api/routes.js';

function listRoutes(router) {
    const out = [];
    for (const layer of router.stack ?? router._router?.stack ?? []) {
        if (layer.route) for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${layer.route.path}`);
    }
    return out;
}

test('both mounts register exactly what the table says', () => {
    const standalone = express();
    registerRoutes(standalone, 'standalone');
    const plugin = express.Router();
    registerRoutes(plugin, 'plugin');
    const noOptions = (l) => l.filter((k) => !k.startsWith('OPTIONS '));
    assert.deepEqual(noOptions(listRoutes(standalone)).sort(), routeKeys('standalone').sort());
    assert.deepEqual(listRoutes(plugin).sort(), routeKeys('plugin').sort());
});

test('plugin mount serves the panel same-origin endpoints, each backed by a standalone path', () => {
    for (const r of ROUTES.filter((x) => x.plugin)) assert.ok(r.standalone, r.plugin);
    assert.deepEqual(routeKeys('plugin').sort(), [
        'GET /backend', 'GET /debug', 'GET /diag/full', 'GET /diag/report', 'GET /quota', 'GET /reply/:slot', 'GET /stats', 'GET /status',
        'POST /backend', 'POST /reply/:slot/cancel',
    ].sort());
});

test('standalone keeps every documented URL', () => {
    for (const k of ['GET /status', 'GET /v1/models', 'GET /v1/usage/quota', 'GET /v1/usage/stats', 'GET /v1/debug/last', 'GET /v1/diag/report', 'GET /v1/diag/full',
        'POST /v1/chat/completions', 'GET /v1/replies/:slot', 'POST /v1/replies/:slot/cancel',
        'GET /v1/backend', 'POST /v1/backend', 'POST /v1/embeddings']) {
        assert.ok(routeKeys('standalone').includes(k), k);
    }
});

test('CORS preflight exists for every cors route on the standalone mount', () => {
    const app = express();
    registerRoutes(app, 'standalone');
    const opts = listRoutes(app).filter((k) => k.startsWith('OPTIONS ')).map((k) => k.slice(8));
    for (const r of ROUTES.filter((x) => x.cors)) assert.ok(opts.includes(r.standalone), r.standalone);
    assert.ok(!opts.includes('/v1/chat/completions'));
});
