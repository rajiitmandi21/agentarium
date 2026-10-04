'use strict';

const assert = require('assert');
const {
  createMaestroLangGraph,
  createNativeModel,
  normalizeProvider,
  scrubError,
  validateResolvedRun,
} = require('../agentarium/maestro-langgraph');

async function main() {
  assert.strictEqual(normalizeProvider('claude'), 'anthropic');
  assert.strictEqual(normalizeProvider('gpt'), 'openai');
  assert.strictEqual(normalizeProvider('gemini'), 'google');
  assert.throws(() => normalizeProvider('local'), /Unsupported provider/);
  assert.throws(() => validateResolvedRun({ runId: 'run-1', steps: [{ id: 's1', model_config: { provider: 'openai', model: 'x' }, tools: ['shell'] }] }), /does not permit tools/);

  let clientOptions;
  const nativeModel = await createNativeModel({ provider: 'openai', model: 'fixture-model', temperature: 0.2 },
    { OPENAI_API_KEY: 'server-secret' }, async (name) => {
      assert.strictEqual(name, '@langchain/openai');
      return { ChatOpenAI: class { constructor(options) { clientOptions = options; } } };
    });
  assert(nativeModel);
  assert.strictEqual(clientOptions.apiKey, 'server-secret');
  assert.strictEqual(clientOptions.temperature, 0.2);
  await assert.rejects(createNativeModel({ provider: 'anthropic', model: 'x' }, {}, async () => ({})), /credentials/);
  const redacted = scrubError(new Error('Authorization: Bearer private-key at https://secret.example'));
  assert(!JSON.stringify(redacted).includes('private-key'));
  assert(!JSON.stringify(redacted).includes('secret.example'));

  // Minimal injected LangGraph contract fixture: exercises authority gating,
  // canonical server steps, real-model invocation seam and event shape without
  // credentials, provider network calls, or installed LangChain packages.
  class Command { constructor(value) { Object.assign(this, value); } }
  const checkpointer = {};
  class StateGraph {
    constructor() { this.nodes = {}; }
    addNode(name, fn) { this.nodes[name] = fn; return this; }
    addEdge() { return this; }
    compile() {
      const nodes = this.nodes;
      let finalState;
      return {
        async *stream(input) {
          let state = input;
          let at = 'execute_step';
          for (let count = 0; at !== '__end__' && count < 5; count += 1) {
            const result = await nodes[at](state);
            state = Object.assign({}, state, result.update || {});
            at = result.goto;
            finalState = state;
            yield { [at || 'execute_step']: { index: state.index } };
          }
        },
        async getState() { return { values: finalState, next: [] }; },
      };
    }
  }
  const fakeRuntime = {
    Annotation: Object.assign(() => ({}), { Root: (schema) => schema }),
    StateGraph,
    Command,
    START: '__start__',
    END: '__end__',
    interrupt: () => ({ approved: true }),
    HumanMessage: class { constructor(content) { this.content = content; } },
    SystemMessage: class { constructor(content) { this.content = content; } },
  };
  const packageLoader = async (name) => {
    if (name === '@langchain/langgraph') return fakeRuntime;
    if (name === '@langchain/core/messages') return {};
    if (name === '@langchain/langgraph-checkpoint-sqlite') return { SqliteSaver: { fromConnString: () => checkpointer } };
    throw new Error('unexpected package ' + name);
  };
  let calls = 0;
  const events = [];
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const denied = createMaestroLangGraph({
    importPackage: packageLoader,
    dbPath: '/tmp/maestro-adapter-test/checkpoints.sqlite',
    authorizeRun: async () => ({ allowed: false, steps: [] }),
    providerFactory: async () => { calls += 1; return { invoke: async () => ({ content: 'no' }) }; },
  });
  await assert.rejects(denied.start({ runId: 'denied', steps: [] }, () => {}), /denied/);
  assert.strictEqual(calls, 0);

  const adapter = createMaestroLangGraph({
    importPackage: packageLoader,
    dbPath: '/tmp/maestro-adapter-test/checkpoints.sqlite',
    authorizeRun: async () => ({
      allowed: true,
      // This canonical server step deliberately differs from any client data.
      steps: [{ id: 'task-1', performer: 'agent-fixture', prompt: 'Do one bounded step.', model_config: { provider: 'openai', model: 'fixture-model' } }],
    }),
    providerFactory: async (config) => {
      assert.strictEqual(config.model, 'fixture-model');
      calls += 1;
      return { invoke: async (messages) => ({ content: 'fixture-result:' + messages[messages.length - 1].content }) };
    },
  });
  await adapter.start({ runId: 'fixture-run', steps: [{ id: 'client-spoof', prompt: 'spoof', model_config: { provider: 'anthropic', model: 'spoof' } }] }, (event) => {
    events.push(event);
    if (event.type === 'complete' || event.type === 'failed') finish();
  });
  await finished;
  assert.strictEqual(calls, 1, 'one provider invocation used canonical server resolution: ' + JSON.stringify(events));
  assert(events.some((event) => event.type === 'step-complete' && event.output.text.includes('Do one bounded step.')));
  assert(events.some((event) => event.type === 'complete'));
  console.log('maestro-langgraph adapter fixtures: PASS');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
