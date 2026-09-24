/**
 * MyPilot Agent engine adapter — wraps the Python sidecar
 * (sidecar/run_agent.py) running the OSS browser-use Agent with a
 * self-contained Chromium subprocess per task.
 *
 * The sidecar speaks NDJSON on stdout:
 *   sidecar_ready / browser_launched / step / done / error
 *   → translated to HlEvents below.
 *
 * LLM access flows through the operator's one-api router
 * (BU_ROUTER_URL + BU_ROUTER_TOKEN), never direct provider keys.
 */

import { mainLogger } from '../../../logger';
import { register } from '../registry';
import { runCliCapture } from '../cliSpawn';
import { ensureSidecarRuntime, findPython, pythonRuntimeDir, resolveSidecarLauncher, sidecarBinPath } from './runtime';
import path from 'node:path';
import { loadRouterConfig } from '../../../identity/authStore';
import type {
  AuthProbe,
  EngineAdapter,
  InstallProbe,
  ParseContext,
  ParseResult,
  SpawnContext,
} from '../types';
import type { HlEvent } from '../../../../shared/session-schemas';

const ID = 'browser-use-agent';
const DISPLAY = 'MyPilot Agent';
const BIN = 'bu-sidecar';

const MAX_PREVIEW = 2000;

function summarizeActions(actions: unknown): string {
  if (!Array.isArray(actions)) return '';
  return actions
    .map((a) => {
      if (!a || typeof a !== 'object') return '';
      const o = a as Record<string, unknown>;
      const name = Object.keys(o).find((k) => k !== 'index');
      if (!name) return '';
      const value = o[name];
      const detail = typeof value === 'object' && value !== null
        ? JSON.stringify(value)
        : String(value ?? '');
      return `${name}(${detail.slice(0, 120)})`;
    })
    .filter(Boolean)
    .join(', ');
}

const browserUseAgentAdapter: EngineAdapter = {
  id: ID,
  displayName: DISPLAY,
  binaryName: BIN,
  metered: true,

  resolveBinary(): string {
    return resolveSidecarLauncher()?.command ?? BIN;
  },

  async probeInstalled(): Promise<InstallProbe> {
    // Bundled runtime wins; then a provisioned venv; then bu-sidecar on PATH.
    if (pythonRuntimeDir()) return { installed: true, version: 'bundled' };
    if (sidecarBinPath()) return { installed: true, version: 'bundled' };
    if (findPython()) {
      const ok = await ensureSidecarRuntime();
      if (ok) return { installed: true, version: 'bundled' };
    }
    const r = await runCliCapture('bu-sidecar', ['--help'], 5000).catch(() => null);
    if (r?.ok) return { installed: true, version: 'path' };
    return {
      installed: false,
      error:
        'The MyPilot Agent runtime is missing from this build and no Python 3.11+ interpreter was found. Reinstall MyPilot to use this engine.',
    };
  },

  async probeAuthed(): Promise<AuthProbe> {
    // Auth = router token in settings; probeAuthed tells the engine picker
    // whether we can actually spawn this engine. Falls through to the normal
    // preflight gate (assertSessionEngineReady) in index.ts.
    const router = await loadRouterConfig();
    if (!router) return { authed: false, error: 'No LLM router token configured. Open Settings → Connections to set it.' };
    if (!router.url || !router.token) return { authed: false, error: 'LLM router token is incomplete. Check both the URL and token.' };
    return { authed: true };
  },

  async openLoginInTerminal(): Promise<{ opened: boolean; error?: string }> {
    return { opened: false, error: 'MyPilot Agent uses the router token configured in Settings; no local login is required.' };
  },

  wrapPrompt(ctx: SpawnContext): string {
    const lines: string[] = [
      'You are a browser automation agent. Complete the task in the browser.',
      'Save any requested files (report, CSV, screenshot, transcript) to',
      '`./outputs/' + ctx.sessionId + '/` and mention the filename in your final answer.',
    ];
    if (ctx.attachmentRefs.length > 0) {
      lines.push('', 'The user attached these files for this task:');
      for (const a of ctx.attachmentRefs) lines.push(`  - ${a.relPath} (${a.mime}, ${a.size} bytes)`);
    }
    lines.push('', `Task: ${ctx.prompt}`);
    return lines.join('\n');
  },

  buildSpawnArgs(_ctx: SpawnContext, _wrappedPrompt: string): string[] {
    // Bundled runtime is launched as `python -m bu_sidecar`; a venv/PATH install
    // ships its own `bu-sidecar` console script and takes no args.
    // The task text travels via stdin — never argv — so it never shows in
    // process listings and no shell-quoting bugs can eat it.
    return resolveSidecarLauncher()?.args ?? [];
  },

  buildEnv(ctx: SpawnContext, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const launcher = resolveSidecarLauncher();
    const env = { ...baseEnv, ...(launcher?.env ?? {}) };
    delete env.OPENAI_API_KEY; // never leak machine keys into the sidecar
    // Router wiring. savedApiKey carries the user's router token
    // (resolved from app settings by runEngine).
    if (ctx.savedApiKey) env.BU_ROUTER_TOKEN = ctx.savedApiKey;
    env.BU_ROUTER_URL = ctx.routerUrl ?? process.env.BU_ROUTER_URL ?? '';
    env.BU_MODEL = process.env.BU_MODEL ?? 'gpt-4.1-mini';
    env.BU_MAX_STEPS = '50';
    env.BU_HEADLESS = 'true';
    env.BU_SESSION_ID = ctx.sessionId;
    // Sidecar-managed Chromium lives under the app userData dir so profiles
    // and session recordings persist across launches (cloud-style).
    env.BU_PROFILE_DIR = path.join(ctx.harnessDir, 'profiles', ctx.sessionId);
    env.BU_SESSION_DIR = path.join(ctx.harnessDir, 'runs', ctx.sessionId);
    env.BU_SEED_SKILLS_DIR = path.join(ctx.harnessDir, 'domain-skills');
    // Let the sidecar talk to the same CDP REPL the browser harness uses so
    // the desktop live view can attach.
    env.BU_CDP_PORT = String(ctx.cdpPort);
    env.BU_TARGET_ID = ctx.targetId;
    return env;
  },

  getStdinPayload(_ctx: SpawnContext, wrappedPrompt: string): string | null {
    return wrappedPrompt;
  },

  parseLine(line: string, ctx: ParseContext): ParseResult {
    let evt: unknown;
    try { evt = JSON.parse(line); } catch { return { events: [] }; }
    if (!evt || typeof evt !== 'object') return { events: [] };
    const e = evt as Record<string, unknown>;
    const type = e.type as string | undefined;
    const events: HlEvent[] = [];
    let terminalDone = false;
    let terminalError: string | undefined;

    if (type === 'sidecar_ready' || type === 'browser_launched') {
      return { events: [] };
    }

    if (type === 'step') {
      ctx.iter++;
      const nextGoal = typeof e.next_goal === 'string' ? e.next_goal : '';
      const memory = typeof e.memory === 'string' ? e.memory : '';
      const evalPrev = typeof e.evaluation_previous_goal === 'string' ? e.evaluation_previous_goal : '';
      const actions = summarizeActions(e.actions);
      const url = typeof e.url === 'string' ? e.url : '';

      const thought = [evalPrev && `Previous: ${evalPrev}`, memory, nextGoal && `Next: ${nextGoal}`]
        .filter(Boolean)
        .join('\n');
      if (thought.trim()) events.push({ type: 'thinking', text: thought });

      if (actions) {
        events.push({
          type: 'tool_call',
          name: 'browser',
          args: { preview: actions, url },
          iteration: ctx.iter,
        });
        events.push({
          type: 'tool_result',
          name: 'browser',
          ok: true,
          preview: actions.slice(0, MAX_PREVIEW),
          ms: 0,
        });
      }

      // Per-step usage delta from the sidecar (tokens since the previous
      // step) — emit immediately so the session ledger meters live rather
      // than only at done. Accumulated on ctx.usageEmitted so the final
      // done event can subtract it and never double-count.
      const stepUsage = e.usage as Record<string, unknown> | undefined;
      if (stepUsage) {
        const inputTokens = typeof stepUsage.input_tokens === 'number' ? stepUsage.input_tokens : 0;
        const outputTokens = typeof stepUsage.output_tokens === 'number' ? stepUsage.output_tokens : 0;
        const cachedInputTokens = typeof stepUsage.cached_input_tokens === 'number' ? stepUsage.cached_input_tokens : 0;
        if (inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0) {
          const usageModel = typeof stepUsage.model === 'string' && stepUsage.model ? stepUsage.model : ctx.currentModel;
          events.push({
            type: 'turn_usage',
            inputTokens,
            outputTokens,
            cachedInputTokens,
            costUsd: 0,
            model: usageModel,
            source: 'estimated',
          });
          const acc = ctx.usageEmitted
            ?? (ctx.usageEmitted = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
          acc.inputTokens += inputTokens;
          acc.outputTokens += outputTokens;
          acc.cachedInputTokens += cachedInputTokens;
        }
      }
      return { events };
    }

    if (type === 'done') {
      ctx.iter++;
      const usage = e.usage as Record<string, unknown> | undefined;
      if (usage) {
        const totalInput = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
        const totalOutput = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
        const costUsd = typeof usage.cost_usd === 'number' ? usage.cost_usd : 0;
        // Per-step events already reported most tokens — emit only the
        // residual (calls after the last step, e.g. judge/compaction) so
        // additive session roll-ups never double-count. Cost is reported
        // once, here, at run end. Legacy sidecars without per-step usage
        // fall through to full totals (usageEmitted stays unset).
        const emitted = ctx.usageEmitted;
        const inputTokens = Math.max(0, totalInput - (emitted?.inputTokens ?? 0));
        const outputTokens = Math.max(0, totalOutput - (emitted?.outputTokens ?? 0));
        if (inputTokens > 0 || outputTokens > 0 || costUsd > 0) {
          events.push({
            type: 'turn_usage',
            inputTokens,
            outputTokens,
            cachedInputTokens: 0,
            costUsd,
            model: ctx.currentModel,
            source: 'estimated',
          });
        }
      }
      const errors = Array.isArray(e.errors) ? (e.errors as string[]) : [];
      const summary = typeof e.summary === 'string' ? e.summary : '(done)';
      if (errors.length > 0 && /no result/.test(summary)) {
        terminalError = `task_errors: ${errors.join('; ').slice(0, MAX_PREVIEW)}`;
        events.push({ type: 'error', message: terminalError });
      } else {
        terminalDone = true;
        events.push({ type: 'done', summary: summary.slice(0, MAX_PREVIEW), iterations: ctx.iter });
      }
      mainLogger.info('browser-use-agent.done', { steps: e.steps, urls: Array.isArray(e.urls) ? (e.urls as unknown[]).length : 0 });
      return { events, terminalDone, terminalError };
    }

    if (type === 'error') {
      terminalError = `sidecar_error: ${typeof e.message === 'string' ? e.message : 'unknown'}`;
      events.push({ type: 'error', message: terminalError });
      return { events, terminalError };
    }

    return { events };
  },
};

register(browserUseAgentAdapter);
