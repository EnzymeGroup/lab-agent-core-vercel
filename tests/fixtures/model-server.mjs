import http from 'node:http';

/** A deterministic local OpenAI-compatible server. It never creates artifacts.
 * Real AI SDK HTTP requests, tool execution and stream parsing remain in use.
 * options.plan may be [{name,args}] or (request) => that array.
 */
export async function startModelServer(options = {}) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const record = { method: req.method, path: req.url, body: undefined, aborted: false };
    requests.push(record);
    req.on('aborted', () => { record.aborted = true; });
    res.on('close', () => { if (!res.writableEnded) record.aborted = true; });
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'deterministic-demo', object: 'model', owned_by: 'local-fixture' }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404); res.end('not found'); return;
    }
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 8_000_000) throw new Error('request too large'); }
      const input = JSON.parse(body);
      record.body = input;
      const messages = input.messages ?? [];
      const lastUser = messages.findLastIndex(m => m.role === 'user');
      const turn = messages.slice(Math.max(0, lastUser));
      const user = typeof turn[0]?.content === 'string' ? turn[0].content : JSON.stringify(turn[0]?.content ?? '');
      const system = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
      const skillNames = [...system.matchAll(/^- ([\w-]+): /gm)].map(match => match[1]);
      const scenario = options.scenario ?? (/\[model-error\]/i.test(user) ? 'error' : /\[wait\]/i.test(user) ? 'slow' : 'normal');
      if (scenario === 'error') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Deterministic provider failure', type: 'server_error' } })); return;
      }
      if (scenario === 'slow') {
        await new Promise(resolve => { const timer = setTimeout(resolve, options.delayMs ?? 30_000); res.once('close', () => { clearTimeout(timer); resolve(); }); });
        if (res.destroyed) return;
      }
      const available = (input.tools ?? []).map(t => t.function).filter(Boolean);
      let plan = typeof options.plan === 'function' ? options.plan(input) : options.plan;
      if (!plan) {
        plan = [];
        const toolCommand = user.match(/\[tool:([\w-]+)\]/);
        const wantsAnalysis = !/\[chat-only\]/i.test(user) && !toolCommand;
        const python = available.find(t => t.name === 'runPython');
        const registeredScript = python?.description?.match(/Scripts:\s*([\w-]+):/)?.[1];
        const explicitSkill = user.match(/\[skill:([\w-]+)\]/)?.[1];
        if (wantsAnalysis && available.some(t => t.name === 'loadSkill') && (skillNames.length || explicitSkill)) {
          const preferred = /table|csv/i.test(user) || registeredScript === 'analyze' ? 'table-quality' : 'sequence-summary';
          const name = explicitSkill ?? (skillNames.includes(preferred) ? preferred : skillNames[0]);
          plan.push({ name: 'loadSkill', args: { name } });
        }
        if (wantsAnalysis && available.some(t => t.name === 'runPython')) {
          const script = user.match(/\[script:([\w-]+)\]/)?.[1] ?? registeredScript ?? (/table|csv/i.test(user) ? 'analyze' : 'summarize');
          plan.push({ name: 'runPython', args: { script, args: [] } });
        }
        const requested = toolCommand?.[1] ?? (/\bMCP\b/i.test(user) || scenario === 'mcp' ? available.find(t => t.name.startsWith('mcp_'))?.name : undefined);
        if (requested) {
          const schema = available.find(t => t.name === requested)?.parameters ?? {};
          const args = {};
          for (const key of schema.required ?? []) {
            const p = schema.properties?.[key] ?? {};
            args[key] = p.enum?.[0] ?? (p.type === 'number' || p.type === 'integer' ? 2 : p.type === 'boolean' ? true : p.type === 'array' ? [] : 'fixture MCP request');
          }
          plan.push({ name: requested, args: options.toolInput ?? args });
        }
      }
      const results = turn.filter(m => m.role === 'tool');
      const next = plan[results.length];
      const toolCall = next ? { id: `call_${results.length + 1}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.args ?? {}) } } : undefined;
      const text = next ? undefined : (options.text ?? `Deterministic demo finished. ${results.length} real tool call(s) completed; inspect the artifact and independent check report. This response is a local fixture, not live model inference.`);
      const id = `chatcmpl-fixture-${requests.length}`;
      const base = { id, object: 'chat.completion', created: 1_700_000_000, model: input.model };
      if (!input.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...base, choices: [{ index: 0, message: { role: 'assistant', content: text ?? null, ...(toolCall ? { tool_calls: [toolCall] } : {}) }, finish_reason: toolCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const event = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      event({ role: 'assistant', content: '' });
      if (toolCall) event({ tool_calls: [{ index: 0, ...toolCall }] });
      else for (const piece of text.match(/.{1,32}/gs) ?? []) event({ content: piece });
      event({}, toolCall ? 'tool_calls' : 'stop');
      res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`, requests,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
