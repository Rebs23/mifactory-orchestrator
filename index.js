
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Redis } = require('@upstash/redis');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SERVICES = {
  scraping: {
    baseUrl: 'https://scraping-api-alpha.vercel.app',
    endpoints: {
      '/scrape': { method: 'POST', credits: 1, params: ['url'] },
    },
  },
  memory: {
    baseUrl: 'https://agent-memory-api.vercel.app',
    endpoints: {
      '/memory/write': { method: 'POST', credits: 1, params: ['agentId', 'key', 'value'] },
      '/memory/read':  { method: 'POST', credits: 1, params: ['agentId', 'key'] },
    },
  },
  spec: {
    baseUrl: 'https://spec-api-mcp.vercel.app',
    endpoints: {
      '/spec/convert':  { method: 'POST', credits: 10, params: ['documentText'] },
      '/spec/validate': { method: 'POST', credits: 5,  params: ['spec'] },
    },
  },
  contratos: {
    baseUrl: 'https://freelance-contratos.vercel.app',
    endpoints: {
      '/contract/generate': { method: 'POST', credits: 50, params: ['projectName', 'clientName', 'freelancerName', 'amount'] },
    },
  },
  'logic-verifier': {
    baseUrl: 'https://logic-verifier-mcp.vercel.app',
    endpoints: {
      '/verify': { method: 'POST', credits: 2, params: ['reasoning', 'context'] },
    },
  },
};

async function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing x-api-key header' });
  try {
    const keyData = await redis.hget('api_keys', apiKey);
    if (!keyData) return res.status(403).json({ error: 'Invalid API key' });
    const parsed = typeof keyData === 'string' ? JSON.parse(keyData) : keyData;
    if (parsed.credits < 10) return res.status(402).json({ error: 'Insufficient credits. Need at least 10.' });
    req.keyData = parsed;
    req.apiKey = apiKey;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Auth check failed' });
  }
}

async function deductCredits(apiKey, keyData, amount) {
  const updated = { ...keyData, credits: keyData.credits - amount };
  await redis.hset('api_keys', { [apiKey]: JSON.stringify(updated) });
  return updated.credits;
}

async function generateBlueprint(task) {
  const serviceList = Object.entries(SERVICES).map(([name, svc]) => {
    const eps = Object.entries(svc.endpoints).map(
      ([ep, info]) => '  ' + ep + ' (' + info.params.join(', ') + ') — ' + info.credits + ' creditos'
    ).join('\n');
    return name + ':\n' + eps;
  }).join('\n\n');

  const prompt = `You are an agent orchestrator. Design a Blueprint JSON for this task. Always respond in English only.

TASK: ${task}

SERVICES:
${serviceList}

RULES:
1. Use ONLY the listed services and ONLY the exact endpoints listed above
2. To reference previous node output use: "{{node_ID.output}}"
3. To reference a specific field: "{{node_ID.output.fieldName}}"
4. For spec service: ALWAYS use endpoint "/spec/convert" (NEVER "/convert" alone). The documentText param MUST reference the scraping node output directly using "{{node_X.output.text}}" where node_X is the scraping node. NEVER reference a memory node output as documentText
5. For contract/generate: always include projectName, clientName, freelancerName and amount as direct strings/numbers
6. Order nodes in logical sequence
7. ONLY use scraping/scrape if the task contains an explicit URL starting with http. If no URL in task, NEVER use scraping.
8. CRITICAL: Every endpoint in your blueprint MUST exactly match one of the endpoints listed in SERVICES above. Double-check before responding.
9. NEVER use spec/validate right after spec/convert in the same pipeline. Use logic-verifier/verify instead for validation.
10. NEVER use memory/read in the same pipeline where data is already available from a previous node output. Use {{node_X.output}} directly instead.

Respond ONLY with valid JSON:
{
  "task": "description",
  "estimated_credits": number,
  "nodes": [
    {
      "id": "node_1",
      "service": "name",
      "endpoint": "/endpoint",
      "params": {},
      "depends_on": [],
      "description": "what it does"
    }
  ]
}`;
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

function computeBlueprintCredits(blueprint) {
  if (!blueprint || !Array.isArray(blueprint.nodes)) return 0;
  let total = 0;
  for (const node of blueprint.nodes) {
    const service = SERVICES[node.service];
    if (!service) continue;
    const endpointInfo = service.endpoints[node.endpoint];
    if (!endpointInfo) continue;
    total += endpointInfo.credits || 0;
  }
  return total;
}

function validateBlueprint(task, blueprint) {
  if (!blueprint || !Array.isArray(blueprint.nodes)) {
    return { ok: false, error: 'Blueprint missing nodes array' };
  }

  const urlInTask = /https?:\/\/\S+/i.test(task || '');

  for (let i = 0; i < blueprint.nodes.length; i++) {
    const node = blueprint.nodes[i];
    const service = SERVICES[node.service];
    if (!service) return { ok: false, error: `Unknown service: ${node.service}` };
    const endpointInfo = service.endpoints[node.endpoint];
    if (!endpointInfo) return { ok: false, error: `Unknown endpoint: ${node.service}${node.endpoint}` };

    if (!urlInTask && node.service === 'scraping' && node.endpoint === '/scrape') {
      return { ok: false, error: 'Scraping used without URL in task' };
    }

    if (node.service === 'spec' && node.endpoint === '/spec/convert') {
      const doc = node.params && node.params.documentText;
      const ok = typeof doc === 'string' && /\{\{node_\w+\.output\.text\}\}/.test(doc);
      if (!ok) return { ok: false, error: 'spec/convert must use {{node_X.output.text}} from scraping output' };
    }

    const prev = blueprint.nodes[i - 1];
    if (prev && prev.service === 'spec' && prev.endpoint === '/spec/convert' && node.service === 'spec' && node.endpoint === '/spec/validate') {
      return { ok: false, error: 'spec/validate cannot be immediately after spec/convert; use logic-verifier/verify instead' };
    }
  }

  return { ok: true };
}

async function executeNode(node, outputs, apiKey) {
  const service = SERVICES[node.service];
  if (!service) throw new Error('Servicio desconocido: ' + node.service);
  const endpointInfo = service.endpoints[node.endpoint];
  if (!endpointInfo) throw new Error('Endpoint desconocido: ' + node.endpoint);

  const resolvedParams = {};
  for (const [key, val] of Object.entries(node.params)) {
    if (typeof val === 'string') {
      resolvedParams[key] = val.replace(/\{\{(\w+)\.output(?:\.(\w+))?\}\}/g, (_, nodeId, field) => {
        const out = outputs[nodeId];
        if (!out) return '';
        if (field) return out[field] !== undefined ? String(out[field]) : '';
        return typeof out === 'object' ? JSON.stringify(out) : String(out);
      });
    } else {
      resolvedParams[key] = val;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await fetch(service.baseUrl + node.endpoint, {
      method: endpointInfo.method,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(resolvedParams),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    let details = '';
    try {
      const text = await res.text();
      details = text ? ` - ${text.slice(0, 500)}` : '';
    } catch (_) {
      details = '';
    }
    throw new Error(node.service + node.endpoint + ' returned ' + res.status + details);
  }
  return await res.json();
}

async function executeBlueprint(blueprint, apiKey) {
  const outputs = {};
  const results = [];
  for (const node of blueprint.nodes) {
    const startTime = Date.now();
    try {
      const output = await executeNode(node, outputs, apiKey);
      outputs[node.id] = output;
      results.push({ id: node.id, service: node.service, endpoint: node.endpoint, description: node.description, status: 'success', output, duration_ms: Date.now() - startTime });
    } catch (err) {
      results.push({ id: node.id, service: node.service, endpoint: node.endpoint, description: node.description, status: 'error', error: err.message, duration_ms: Date.now() - startTime });
      break;
    }
  }
  return results;
}

function buildInfo() {
  return {
    version: '2.0.2',
    build: process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT || 'unknown',
  };
}

app.get('/', (req, res) => {
  const info = buildInfo();
  res.json({ service: 'mifactory-orchestrator', status: 'live', version: info.version, build: info.build });
});

app.get('/ui', (req, res) => {
  const uiPath = path.join(__dirname, 'ui.html');
  if (fs.existsSync(uiPath)) res.sendFile(uiPath);
  else res.status(404).send('UI not found');
});

app.post('/orchestrate', async (req, res) => {
  const { task } = req.body;
  if (!task) return res.status(400).json({ error: 'Missing task' });
  try {
    const blueprint = await generateBlueprint(task);
    const validation = validateBlueprint(task, blueprint);
    blueprint.estimated_credits = computeBlueprintCredits(blueprint);
    res.json({ blueprint });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate blueprint', details: err.message });
  }
});

app.post('/execute', authenticate, async (req, res) => {
  const { blueprint } = req.body;
  if (!blueprint || !blueprint.nodes) return res.status(400).json({ error: 'Missing blueprint' });
  try {
    const validation = validateBlueprint(blueprint.task, blueprint);
    if (!validation.ok) return res.status(400).json({ error: 'Invalid blueprint', details: validation.error });
    const totalCredits = computeBlueprintCredits(blueprint);
    if (req.keyData.credits < totalCredits) {
      return res.status(402).json({ error: `Insufficient credits. Need ${totalCredits}.` });
    }
    await deductCredits(req.apiKey, req.keyData, totalCredits);
    const results = await executeBlueprint(blueprint, req.apiKey);
    const success = results.filter(r => r.status === 'success').length;
    const failed = results.filter(r => r.status === 'error').length;
    res.json({ task: blueprint.task, summary: { total: results.length, success, failed }, results });
  } catch (err) {
    res.status(500).json({ error: 'Execution failed', details: err.message });
  }
});

app.post('/mas-factory', authenticate, async (req, res) => {
  const { task } = req.body;
  if (!task) return res.status(400).json({ error: 'Missing task' });
  try {
    const blueprint = await generateBlueprint(task);
    await deductCredits(req.apiKey, req.keyData, 10);
    const results = await executeBlueprint(blueprint, req.apiKey);
    const success = results.filter(r => r.status === 'success').length;
    const failed = results.filter(r => r.status === 'error').length;
    res.json({ task, blueprint, summary: { total: results.length, success, failed }, results });
  } catch (err) {
    res.status(500).json({ error: 'MAS-Factory failed', details: err.message });
  }
});

module.exports = app;

app.get('/mcp', (req, res) => {
  const info = buildInfo();
  res.json({
    schema_version: '1.0',
    name: 'mifactory-orchestrator',
    description: 'MAS-Factory — Vibe Graphing orchestrator that chains MCP servers from plain English descriptions',
    version: info.version,
    build: info.build,
    tools: [
      { name: 'orchestrate', description: 'Generate a blueprint JSON from a natural language task', input_schema: { type: 'object', properties: { task: { type: 'string', description: 'Task description in natural language' } }, required: ['task'] } },
      { name: 'execute', description: 'Execute an approved blueprint', input_schema: { type: 'object', properties: { blueprint: { type: 'object' } }, required: ['blueprint'] } },
      { name: 'mas_factory', description: 'Orchestrate and execute in one call', input_schema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } }
    ]
  });
});

app.get('/.well-known/mcp/server-card.json', (req, res) => {
  const info = buildInfo();
  res.json({
    serverInfo: { name: 'mifactory-orchestrator', version: info.version, build: info.build },
    authentication: { required: true },
    tools: [
      { name: 'orchestrate', description: 'Generate a blueprint from a natural language task', inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
      { name: 'execute', description: 'Execute an approved blueprint', inputSchema: { type: 'object', properties: { blueprint: { type: 'object' } }, required: ['blueprint'] } },
      { name: 'mas_factory', description: 'Orchestrate and execute in one call', inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } }
    ],
    resources: [],
    prompts: []
  });
});

app.post('/mcp', (req, res) => {
  const { method, id } = req.body;
  if (method === 'initialize') {
    return res.json({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mifactory-orchestrator', version: '2.0.2' }, capabilities: { tools: {} } } });
  }
  if (method === 'tools/list') {
    return res.json({ jsonrpc: '2.0', id, result: { tools: [
      { name: 'orchestrate', description: 'Generate a blueprint from a natural language task', inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
      { name: 'execute', description: 'Execute an approved blueprint', inputSchema: { type: 'object', properties: { blueprint: { type: 'object' } }, required: ['blueprint'] } },
      { name: 'mas_factory', description: 'Orchestrate and execute in one call', inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } }
    ]}});
  }
  if (method === 'tools/call') {
    return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Use the REST API directly: POST /orchestrate, /execute, or /mas-factory' }] } });
  }
  res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});
