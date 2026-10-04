'use strict';

// Server-only LangGraph adapter for Maestro (AG-P15.6). This file is not
// included by the no-build browser bundle. The host must authorize the run
// against its current Crews data before dispatch; client previews are not
// accepted as authority proof.

const path = require('path');
const fs = require('fs');

const PROVIDER_KEY_ENV = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
});

const SAFE_FAILURE = 'The configured model provider could not complete this step.';

function scrubError(error) {
  // Provider errors frequently include request headers, endpoint URLs, or
  // response bodies. Never return their original text to API clients/logs.
  const code = error && (error.code || error.name);
  return { code: typeof code === 'string' ? code.slice(0, 64) : 'PROVIDER_ERROR', message: SAFE_FAILURE };
}

function safeId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value);
}

function outputText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.content === 'string') return value.content;
  if (value && Array.isArray(value.content)) {
    return value.content.map((part) => typeof part === 'string' ? part : (part && part.text) || '').join('');
  }
  return String(value == null ? '' : value);
}

function loadPackage(name) {
  // LangChain packages expose ESM; dynamic import keeps this CommonJS server
  // loadable when optional runtime packages have not been installed yet.
  return import(name);
}

function normalizeProvider(provider) {
  const key = String(provider || '').toLowerCase();
  if (key === 'gemini' || key === 'google-genai' || key === 'google') return 'google';
  if (key === 'claude' || key === 'anthropic') return 'anthropic';
  if (key === 'gpt' || key === 'openai') return 'openai';
  throw new Error('Unsupported provider');
}

async function createNativeModel(config, env, importPackage) {
  if (!config || typeof config !== 'object') throw new Error('Missing model configuration');
  const provider = normalizeProvider(config.provider);
  const keyName = PROVIDER_KEY_ENV[provider];
  const apiKey = env[keyName];
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Provider credentials are not configured');
  if (typeof config.model !== 'string' || !config.model.trim()) throw new Error('Missing model name');
  const opts = { model: config.model, apiKey };
  if (Number.isFinite(config.temperature)) opts.temperature = config.temperature;
  if (Number.isFinite(config.max_output_tokens) && config.max_output_tokens > 0) {
    if (provider === 'google') opts.maxOutputTokens = config.max_output_tokens;
    else opts.maxTokens = config.max_output_tokens;
  }
  if (provider === 'anthropic') {
    const pkg = await importPackage('@langchain/anthropic');
    return new pkg.ChatAnthropic(opts);
  }
  if (provider === 'openai') {
    const pkg = await importPackage('@langchain/openai');
    return new pkg.ChatOpenAI(opts);
  }
  const pkg = await importPackage('@langchain/google-genai');
  return new pkg.ChatGoogleGenerativeAI(opts);
}

function validateResolvedRun(run) {
  if (!run || !safeId(run.runId)) throw new Error('A stable runId is required');
  if (!Array.isArray(run.steps) || run.steps.length === 0) throw new Error('Resolved steps are required');
  for (const step of run.steps) {
    if (!step || !safeId(step.id || step.taskId) || !step.model_config ||
        !step.model_config.provider || !step.model_config.model) {
      throw new Error('Every authorized step needs an id and provider model_config');
    }
    if (step.tools && step.tools.length) throw new Error('Maestro real adapter does not permit tools');
  }
}

function createMaestroLangGraph(options) {
  options = options || {};
  const env = options.env || process.env;
  const importPackage = options.importPackage || loadPackage;
  const authorizeRun = options.authorizeRun;
  const providerFactory = options.providerFactory || ((config) => createNativeModel(config, env, importPackage));
  const dbPath = options.dbPath || env.MAESTRO_CHECKPOINT_PATH ||
    path.join(process.cwd(), 'project-management', 'artifacts', 'maestro-checkpoints.sqlite');
  const active = new Map();
  let graphRuntime;
  let checkpointer;

  async function ensureRuntime() {
    if (graphRuntime) return graphRuntime;
    const [lg, sqlite, core] = await Promise.all([
      importPackage('@langchain/langgraph'),
      importPackage('@langchain/langgraph-checkpoint-sqlite'),
      importPackage('@langchain/core/messages'),
    ]);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    checkpointer = sqlite.SqliteSaver.fromConnString(dbPath);
    try { fs.chmodSync(dbPath, 0o600); } catch (_) { /* opening the saver can defer file creation */ }
    graphRuntime = { ...lg, ...core };
    return graphRuntime;
  }

  async function compile(run, emit, handle) {
    const lg = await ensureRuntime();
    const State = lg.Annotation.Root({
      steps: lg.Annotation({ reducer: (_, value) => value, default: () => [] }),
      index: lg.Annotation({ reducer: (_, value) => value, default: () => 0 }),
      outputs: lg.Annotation({ reducer: (_, value) => value, default: () => [] }),
      approved: lg.Annotation({ reducer: (_, value) => value, default: () => [] }),
      status: lg.Annotation({ reducer: (_, value) => value, default: () => 'running' }),
    });
    const { StateGraph, START, END, interrupt, Command, HumanMessage, SystemMessage } = lg;
    const builder = new StateGraph(State);
    builder.addNode('execute_step', async (state) => {
      const index = state.index;
      const step = state.steps[index];
      if (handle.aborted) return new Command({ update: { status: 'aborted' }, goto: END });
      if (!step) return new Command({ update: { status: 'done' }, goto: END });

      // Interrupt happens before constructing/invoking the provider. A resume
      // uses the same checkpointer thread and records approval in graph state.
      if (step.requiresApproval && !state.approved.includes(index)) {
        const decision = interrupt({ kind: 'step-approval', runId: run.runId, stepId: step.id || step.taskId });
        if (!decision || decision.approved !== true) {
          return new Command({ update: { status: 'blocked' }, goto: END });
        }
      }

      const model = await providerFactory(step.model_config);
      const messages = [];
      if (step.system_prompt) messages.push(new SystemMessage(String(step.system_prompt)));
      messages.push(new HumanMessage(String(step.prompt || step.task || step.description || '')));
      const response = await model.invoke(messages);
      const text = outputText(response);
      const output = {
        stepId: step.id || step.taskId,
        performer: step.performer || null,
        provider: normalizeProvider(step.model_config.provider),
        model: step.model_config.model,
        text,
        at: new Date().toISOString(),
      };
      emit({ type: 'step-complete', runId: run.runId, stepIndex: index, output });
      const nextIndex = index + 1;
      return new Command({
        update: { index: nextIndex, outputs: state.outputs.concat([output]),
          approved: step.requiresApproval ? state.approved.concat([index]) : state.approved },
        goto: nextIndex < state.steps.length ? 'execute_step' : END,
      });
    });
    builder.addEdge(START, 'execute_step');
    return builder.compile({ checkpointer });
  }

  async function execute(run, emit, resumeValue, handle) {
    try {
      const graph = await compile(run, emit, handle);
      const config = { configurable: { thread_id: run.runId } };
      const input = resumeValue === undefined
        ? { steps: run.steps, index: 0, outputs: [], approved: [], status: 'running' }
        : new (await ensureRuntime()).Command({ resume: resumeValue });
      for await (const chunk of await graph.stream(input, { ...config, streamMode: 'updates' })) {
        emit({ type: 'graph-update', runId: run.runId, update: safeGraphChunk(chunk) });
      }
      const snapshot = await graph.getState(config);
      const status = snapshot && snapshot.values && snapshot.values.status;
      if (status === 'blocked') emit({ type: 'blocked', runId: run.runId });
      else if (status === 'aborted') emit({ type: 'aborted', runId: run.runId, outcomeUncertain: true });
      else if (snapshot && snapshot.next && snapshot.next.length) emit({ type: 'awaiting-approval', runId: run.runId });
      else emit({ type: 'complete', runId: run.runId, outputs: snapshot && snapshot.values && snapshot.values.outputs || [] });
      if (status === 'done' || status === 'blocked' || status === 'aborted') active.delete(run.runId);
    } catch (error) {
      emit({ type: 'failed', runId: run.runId, error: scrubError(error) });
      active.delete(run.runId);
    }
  }

  function safeGraphChunk(chunk) {
    // Only expose graph node names; update contents can include model objects.
    return Object.keys(chunk || {}).slice(0, 20);
  }

  return {
    name: 'langgraph',
    async start(run, emit) {
      if (!run || !safeId(run.runId)) throw new Error('A stable runId is required');
      if (typeof authorizeRun !== 'function') throw new Error('Real Maestro dispatch requires a server authority resolver');
      const authorization = await authorizeRun(run);
      if (!authorization || authorization.allowed !== true || !Array.isArray(authorization.steps)) {
        throw new Error('Maestro real dispatch was denied by server authority');
      }
      // The server resolver supplies canonical steps; never execute client
      // preview/model configuration as authority or provider configuration.
      const authorizedRun = Object.assign({}, run, { steps: authorization.steps.map((step) => Object.assign({}, step)) });
      if (authorization.requiresOwnerApproval && authorizedRun.steps.length) {
        authorizedRun.steps[0].requiresApproval = true;
      }
      validateResolvedRun(authorizedRun);
      if (active.has(authorizedRun.runId)) throw new Error('A run with this id is already active');
      const handle = { run: authorizedRun, emit, busy: true, aborted: false };
      active.set(authorizedRun.runId, handle);
      void execute(authorizedRun, (event) => emit(event), undefined, handle).finally(() => { handle.busy = false; });
      return { runId: authorizedRun.runId, threadId: authorizedRun.runId, adapter: 'langgraph' };
    },
    async resume(runId, approval) {
      const handle = active.get(runId);
      if (!handle || handle.busy) return false;
      if (!approval || approval.approved !== true || !safeId(approval.approvedBy)) return false;
      handle.busy = true;
      void execute(handle.run, handle.emit, approval, handle)
        .finally(() => { handle.busy = false; });
      return true;
    },
    pause(runId) {
      const handle = active.get(runId);
      // LangGraph pauses durably only at an interrupt/node boundary. The server
      // integration must expose this limitation to clients until P15.7 wires a
      // durable operator pause interrupt.
      return handle ? { ok: false, reason: 'pause-requires-a-checkpointed-operator-interrupt' } : false;
    },
    abort(runId) {
      const handle = active.get(runId);
      if (!handle) return false;
      handle.aborted = true;
      handle.emit({ type: 'abort-requested', runId, outcomeUncertain: !!handle.busy });
      // An in-flight provider request cannot be recalled; the next graph node
      // checkpoints the aborted terminal state before another model call.
      return { ok: true, outcomeUncertain: !!handle.busy };
    },
    async close() {
      if (checkpointer && typeof checkpointer.end === 'function') await checkpointer.end();
      else if (checkpointer && typeof checkpointer.close === 'function') await checkpointer.close();
    },
    threadIdFor(runId) { return runId; },
  };
}

module.exports = { createMaestroLangGraph, createNativeModel, normalizeProvider, scrubError, validateResolvedRun };
