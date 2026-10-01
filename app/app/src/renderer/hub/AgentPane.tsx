import React, { useCallback, useRef, useEffect, useState } from 'react';
import { STATUS_LABEL } from './constants';
import claudeCodeLogo from './claude-code-logo.svg';
import openaiLogoDark from './openai-logo.svg';
import openaiLogoLight from './openai-logo-light.svg';
import opencodeLogoDark from './opencode-logo-dark.svg';
import opencodeLogoLight from './opencode-logo-light.svg';
import { useThemedAsset } from '../design/useThemedAsset';
import type { AgentSession, OutputEntry } from './types';

function formatElapsed(createdAt: number): string {
  const seconds = Math.floor((Date.now() - createdAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function isApiKeyError(raw: string): boolean {
  const lower = raw.toLowerCase();
  return (
    lower.includes('invalid_api_key') ||
    lower.includes('invalid api key') ||
    lower.includes('no api key') ||
    lower.includes('authentication_error') ||
    lower.includes('x-api-key') ||
    lower.includes('401')
  );
}

function friendlyError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('browsercode') || lower.includes('moonshot') || lower.includes('minimax') || lower.includes('qwen') || lower.includes('alibaba')) {
    if (isApiKeyError(raw)) return 'BrowserCode provider API key is missing or invalid. Update it in Settings.';
  }
  if (lower.includes('credit balance is too low') || lower.includes('insufficient_quota')) return 'API credits exhausted. Please add credits to your Anthropic account.';
  if (isApiKeyError(raw)) return 'Anthropic API key is missing or invalid. Update it in Settings.';
  if (lower.includes('rate_limit') || lower.includes('rate limit')) return 'Rate limited. Too many requests — try again in a moment.';
  if (lower.includes('overloaded') || lower.includes('529')) return 'API is overloaded. Try again shortly.';
  if (lower.includes('cancelled')) return 'Task was cancelled.';
  if (lower.includes('app exited unexpectedly')) return 'App exited unexpectedly during this task.';
  if (lower.includes('cdp') || lower.includes('browser session expired')) return 'Browser session expired. Start a new task.';
  return raw.length > 120 ? raw.slice(0, 120) + '...' : raw;
}

function formatCostUsd(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}







function ErrorIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7 4.5v3M7 9.5v.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}







function BrowserIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.5 5.5h11" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="3.5" cy="4" r="0.5" fill="currentColor" />
      <circle cx="5.5" cy="4" r="0.5" fill="currentColor" />
    </svg>
  );
}

function SplitIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="2" width="11" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="7.5" width="11" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function RerunIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <path d="M2 7a5 5 0 019.33-2.5M12 7a5 5 0 01-9.33 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M11 2v3h-3M3 12V9h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ResumeIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <path d="M5 3.5v7L10.5 7 5 3.5Z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <rect x="4" y="3" width="2" height="8" rx="0.6" fill="currentColor" />
      <rect x="8" y="3" width="2" height="8" rx="0.6" fill="currentColor" />
    </svg>
  );
}




function CloseIcon(): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

interface AgentPaneProps {
  session: AgentSession;
  focused?: boolean;
  onRerun?: (sessionId: string) => void;
  onResume?: (sessionId: string) => void;
  onPause?: (sessionId: string) => void;
  onFollowUp?: (sessionId: string, prompt: string, attachments?: Array<{ name: string; mime: string; bytes: Uint8Array }>) => void;
  onDismiss?: (sessionId: string) => void;
  onCancel?: (sessionId: string) => void;
  onSelect?: (sessionId: string) => void;
  onOpenFollowUp?: () => void;
  onOpenSettings?: () => void;
  onOpenChat?: (sessionId: string) => void;
  shouldDetachBrowserOnUnmount?: () => boolean;
  followUpShortcut?: string;
  cycleShortcut?: string;
}

export function AgentPane({ session, focused, onRerun, onResume, onPause, onFollowUp, onDismiss, onCancel, onSelect, onOpenFollowUp, onOpenSettings, onOpenChat, shouldDetachBrowserOnUnmount, followUpShortcut, cycleShortcut }: AgentPaneProps): React.ReactElement {
  const openaiLogo = useThemedAsset(openaiLogoDark, openaiLogoLight);
  const opencodeLogo = useThemedAsset(opencodeLogoDark, opencodeLogoLight);
  const paneRef = useRef<HTMLDivElement>(null);
  const pendingUnmountDetachRef = useRef<number | null>(null);
  const [browserDead, setBrowserDead] = useState(false);
  const [browserMissing, setBrowserMissing] = useState(false);
  const [frameRect, setFrameRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  // Logs overlay is a separate window (see logsPill.ts). The pane tracks
  // visibility only to reflect it in the Logs button's active state.
  const [logsOpen, setLogsOpen] = useState(false);
  // Auto-open the logs overlay once per fresh session id so users see the
  // agent's stream as soon as a task starts.
  const autoLogsTriggeredRef = useRef<Set<string>>(new Set());
  const computeBounds = useCallback((): { x: number; y: number; width: number; height: number; slotWidth: number } | null => {
    const el = paneRef.current?.querySelector('.pane__output') as HTMLElement | null;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const fullWidth = Math.round(rect.width);
    const slotWidth = fullWidth;
    const border = 1;
    return {
      x: Math.round(rect.x) + border,
      y: Math.round(rect.y) + border,
      width: slotWidth - border * 2,
      height: Math.round(rect.height) - border * 2,
      slotWidth,
    };
  }, []);

  useEffect(() => {
    if (session.status === 'running') {
      setBrowserDead(false);
    }
  }, [session.id, session.status]);

  useEffect(() => {
    if (session.hasBrowser) {
      setBrowserDead(false);
      setBrowserMissing(false);
    }
  }, [session.id, session.hasBrowser]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.on?.sessionBrowserGone) return;
    const off = api.on.sessionBrowserGone((id) => {
      if (id === session.id) {
        console.log('[AgentPane] browser-gone signal', { id });
        setBrowserDead(true);
        // Keep frameRect — the "Browser ended" overlay needs it to paint.
        // Without it the empty .pane__output area shows as black with no label.
      }
    });
    return off;
  }, [session.id]);

  const handleToggleLogs = useCallback(() => {
    const api = window.electronAPI;
    if (!api?.logs) return;
    const outEl = paneRef.current?.querySelector('.pane__output') as HTMLElement | null;
    const rect = outEl?.getBoundingClientRect();
    const anchor = rect
      ? { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
      : undefined;
    void api.logs.toggle(session.id, anchor).then((nowOpen) => setLogsOpen(nowOpen));
  }, [session.id]);

  // On session change, push the new session id to the floating logs overlay
  // so it re-targets (also handles first-mount auto-show for running sessions).
  // Deliberately does NOT depend on session.status — re-firing logs.show() on
  // every running→idle transition causes the logs window's showInactive +
  // setAlwaysOnTop calls to surface the app/Space on macOS, yanking the user
  // back from whatever window they'd switched to.
  useEffect(() => {
    if (session.status === 'draft') return;
    const api = window.electronAPI;
    if (!api?.logs?.show) return;
    const outEl = paneRef.current?.querySelector('.pane__output') as HTMLElement | null;
    const rect = outEl?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const anchor = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    void api.logs.show(session.id, anchor).then((open) => setLogsOpen(open));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [session.id]);

  useEffect(() => {
    const paneEl = paneRef.current;
    if (!paneEl) return;
    const api = window.electronAPI;
    if (!api) return;
    if (browserDead && !session.hasBrowser) {
      // Dead browser — ensure any lingering view is detached.
      // Keep frameRect so the "Browser ended" overlay can paint over the
      // pane__output slot; nulling it leaves the pane black with no label.
      api.sessions.viewDetach(session.id).catch(() => {});
      return;
    }

    let lastKey = '';
    let hasAttached = false;
    // Tracks whether the last viewAttach actually got a browser view. If
    // false, we skip the takeover overlay — the session is broken/deleted.
    let attachSucceeded = false;
    let rafScheduled = 0;
    const applyBounds = () => {
      rafScheduled = 0;
      const outEl = paneEl.querySelector('.pane__output') as HTMLElement | null;
      if (!outEl) return;
      const computed = computeBounds();
      if (!computed) return;
      const { slotWidth, ...bounds } = computed;
      const key = `${bounds.x}|${bounds.y}|${bounds.width}|${bounds.height}`;
      if (key === lastKey) return;
      lastKey = key;
      // Overlay is always visible while the session is running. Mode switches
      // from 'idle' (plain "Browser not started yet" label) to 'active'
      // (pulsing glow + hover-to-stop button) the moment SessionManager
      // records a real navigation via session.primarySite. The ambiguous
      // idle label covers both chat-only tasks and browser tasks still
      // warming up.
      const overlayMode: 'idle' | 'active' = session.primarySite ? 'active' : 'idle';

      if (!hasAttached) {
        hasAttached = true;
        api.sessions.viewAttach(session.id, bounds).then((ok) => {
          if (!ok) {
            attachSucceeded = false;
            setBrowserMissing(true);
            api.takeover?.hide(session.id).catch(() => {});
          } else {
            attachSucceeded = true;
            setBrowserDead(false);
            setBrowserMissing(false);
            if (session.status === 'running') {
              void api.takeover?.show(session.id, bounds, overlayMode);
            }
          }
        }).catch(() => {
          hasAttached = false;
          attachSucceeded = false;
        });
      } else {
        api.sessions.viewResize(session.id, bounds);
        if (attachSucceeded && session.status === 'running') {
          void api.takeover?.show(session.id, bounds, overlayMode);
        } else {
          api.takeover?.hide(session.id).catch(() => {});
        }
      }
      const p = paneEl.getBoundingClientRect();
      const o = outEl.getBoundingClientRect();
      setFrameRect({
        left: Math.round(o.left - p.left),
        top: Math.round(o.top - p.top),
        width: slotWidth,
        height: Math.round(o.height),
      });
      // Auto-show the logs overlay once per session on the first real pane
      // measurement. Ref-keyed so Esc-close doesn't trigger a re-open.
      const logsAnchor = {
        x: Math.round(o.left),
        y: Math.round(o.top),
        width: Math.round(o.width),
        height: Math.round(o.height),
      };
      if (logsAnchor.width > 0 && logsAnchor.height > 0) {
        api.logs?.updateAnchor?.(logsAnchor);
      }
      if (
        session.status !== 'draft' &&
        api.logs?.show &&
        logsAnchor.width > 0 &&
        logsAnchor.height > 0 &&
        !autoLogsTriggeredRef.current.has(session.id)
      ) {
        autoLogsTriggeredRef.current.add(session.id);
        console.log('[AgentPane] auto-open logs on first pane measurement', { sessionId: session.id, logsAnchor });
        void api.logs.show(session.id, logsAnchor).then((open) => setLogsOpen(open));
      }
    };
    // Coalesce rapid ResizeObserver / layout callbacks into one IPC per frame.
    const updateBounds = () => {
      if (rafScheduled) return;
      rafScheduled = requestAnimationFrame(applyBounds);
    };

    const observer = new ResizeObserver(updateBounds);
    observer.observe(paneEl, { box: 'border-box' });

    // ResizeObserver misses position-only changes (e.g. sibling pane dismissed
    // causes a grid reflow without this pane resizing). HubApp dispatches
    // pane:layout-change when the session list or grid layout changes — we
    // re-read bounds across a few frames to catch any CSS transition.
    const onLayoutChange = () => {
      // Layout just changed (grid columns, page, session list). Force the next
      // bounds call through the viewAttach path so if the WebContentsView was
      // silently detached (e.g. by temporarilyDetachAll for pill/settings), it
      // gets re-added. Bounds are always set BEFORE addChildView so there's no
      // stale-position flash.
      hasAttached = false;
      lastKey = '';
      updateBounds();
      requestAnimationFrame(updateBounds);
      setTimeout(updateBounds, 120);
    };
    window.addEventListener('pane:layout-change', onLayoutChange);

    return () => {
      observer.disconnect();
      window.removeEventListener('pane:layout-change', onLayoutChange);
      if (rafScheduled) cancelAnimationFrame(rafScheduled);
    };
  }, [session.id, computeBounds, browserDead, session.hasBrowser, session.status, session.primarySite]);

  useEffect(() => {
    if (pendingUnmountDetachRef.current !== null) {
      window.clearTimeout(pendingUnmountDetachRef.current);
      pendingUnmountDetachRef.current = null;
    }
    return () => {
      const api = window.electronAPI;
      if (!api) return;
      const sessionId = session.id;
      // React dev StrictMode replays effect cleanup/setup on mount; defer the
      // real detach so the immediate setup can cancel it.
      pendingUnmountDetachRef.current = window.setTimeout(() => {
        pendingUnmountDetachRef.current = null;
        if (shouldDetachBrowserOnUnmount && !shouldDetachBrowserOnUnmount()) {
          console.log('[AgentPane] unmount -> keep browser parked offscreen', { id: sessionId });
          api.takeover?.hide(sessionId).catch(() => {});
          return;
        }
        console.log('[AgentPane] unmount -> detach', { id: sessionId });
        api.sessions.viewDetach(sessionId).catch(() => {});
        api.takeover?.hide(sessionId).catch(() => {});
      }, 0);
    };
  }, [session.id, shouldDetachBrowserOnUnmount]);

  // Hide the takeover overlay whenever the session leaves 'running' state.
  // Show is driven by the bounds-update effect above so it tracks the same
  // rect as the browser view without a separate measurement path.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.takeover) return;
    if (session.status !== 'running') {
      void api.takeover.hide(session.id);
    }
  }, [session.id, session.status]);

  const elapsed = formatElapsed(session.createdAt);
  const statusText = STATUS_LABEL[session.status] ?? session.status;
  const isCancellation = !!session.error && session.error.toLowerCase().includes('cancel');
  const showErrorUi = !!session.error && !isCancellation;
  const hasLiveBrowser = session.hasBrowser && !browserDead && !browserMissing;
  const endedWithoutBrowser = !hasLiveBrowser && (
    session.status === 'stopped' ||
    session.status === 'idle' ||
    session.status === 'stuck'
  );
  const isRunningLike = session.status === 'running' || session.status === 'stuck';
  const isPaused = session.status === 'paused';
  const canResume = Boolean(
    onResume &&
    session.canResume === true &&
    (
      session.status === 'paused' ||
      (
        (session.status === 'idle' || session.status === 'stopped') &&
        (browserDead || browserMissing || session.status === 'stopped')
      )
    ),
  );

  useEffect(() => {
    if (!focused || (!isRunningLike && !isPaused) || (!onPause && !onCancel)) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key.toLowerCase() !== 'c' || !e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (isPaused) {
        onCancel?.(session.id);
      } else {
        onPause?.(session.id);
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [focused, isPaused, isRunningLike, onCancel, onPause, session.id]);

  return (
    <div
      ref={paneRef}
      className={`pane pane--${session.status}${focused ? ' pane--focused' : ''}`}
      onClick={() => onSelect?.(session.id)}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) e.preventDefault();
      }}
    >
      <div className="pane__header">
        <span className={`pane__dot pane__dot--${session.status}`} />
        <div className="pane__title-group">
          <span className="pane__prompt">{session.prompt}</span>
          {session.engine === 'codex' && (
            <img className="pane__engine-icon" src={openaiLogo} alt="Codex" title="Codex" />
          )}
          {session.engine === 'browsercode' && (
            <img className="pane__engine-icon" src={opencodeLogo} alt="BrowserCode" title="BrowserCode" />
          )}
          {session.engine === 'claude-code' && (
            <img className="pane__engine-icon" src={claudeCodeLogo} alt="Claude Code" title="Claude Code" />
          )}
          {session.model && session.engine === 'browsercode' && (
            <span className="pane__model-badge" title={`Model: ${session.model}`}>
              {session.model.includes('/') ? session.model.split('/').pop() : session.model}
            </span>
          )}
          {session.authMode && (
            <span
              className={`pane__auth-badge pane__auth-badge--${session.authMode}`}
              title={
                session.authMode === 'subscription'
                  ? `Ran under ${session.subscriptionType ?? 'subscription'} OAuth`
                  : session.authMode === 'router'
                    ? 'Ran through the operator LLM router'
                    : 'Ran under saved API key'
              }
            >
              {session.authMode === 'subscription' ? 'SUBSCRIPTION' : session.authMode === 'router' ? 'ROUTER' : 'KEY'}
            </span>
          )}
          {/* Cost chip is hidden under subscription auth (Claude Code / Codex
              OAuth) — billing is covered by the subscription, so the
              API-equivalent figure is noise. Only show for direct API-key
              auth where the user is actually paying per-token. */}
          {typeof session.costUsd === 'number' && session.costUsd > 0 && session.authMode !== 'subscription' && (
            <span
              className="pane__cost"
              title={
                session.costSource === 'estimated'
                  ? `Estimated from token count × local price table · ${session.inputTokens ?? 0} in / ${session.outputTokens ?? 0} out`
                  : `${session.inputTokens ?? 0} in / ${session.outputTokens ?? 0} out`
              }
            >
              {session.costSource === 'estimated' ? '~' : ''}
              {formatCostUsd(session.costUsd)}
            </span>
          )}
        </div>
        <div className="pane__actions">
          {browserDead && (
            <span className="pane__action-btn pane__action-btn--disabled">
              <BrowserIcon />
              <span>Browser ended</span>
            </span>
          )}
          {onOpenChat && (
            <button
              className="pane__action-btn"
              onClick={(e) => { e.stopPropagation(); onOpenChat(session.id); }}
              aria-label="Back to chat view"
              data-tip="Back to chat view"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M7 3L4 6l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>Back to chat</span>
            </button>
          )}
          <button
            className={`pane__action-btn${logsOpen ? ' pane__action-btn--active' : ''}`}
            onClick={(e) => { e.stopPropagation(); handleToggleLogs(); }}
            aria-label="Toggle logs overlay"
            data-tip="Toggle logs overlay"
          >
            <SplitIcon />
            <span>Logs</span>
          </button>
          {onRerun && (
            <button
              className="pane__action-btn pane__action-btn--icon"
              onClick={(e) => { e.stopPropagation(); onRerun(session.id); }}
              aria-label="Rerun"
              data-tip="Rerun"
            >
              <RerunIcon />
            </button>
          )}
          {canResume && (
            <button
              className="pane__action-btn pane__action-btn--icon pane__action-btn--primary"
              onClick={(e) => { e.stopPropagation(); onResume?.(session.id); }}
              aria-label="Resume"
              data-tip="Resume"
            >
              <ResumeIcon />
            </button>
          )}
          {isRunningLike && onPause && (
            <button
              className="pane__action-btn pane__action-btn--icon"
              onClick={(e) => { e.stopPropagation(); onPause(session.id); }}
              aria-label="Pause"
              data-tip="Pause"
            >
              <PauseIcon />
            </button>
          )}
          {(isRunningLike || isPaused) && onCancel && (
            <button
              className="pane__action-btn pane__action-btn--icon pane__action-btn--danger"
              onClick={(e) => { e.stopPropagation(); onCancel(session.id); }}
              aria-label="Stop"
              data-tip="Stop"
            >
              <CloseIcon />
            </button>
          )}
          {!isRunningLike && !isPaused && onDismiss && (
            <button
              className="pane__action-btn pane__action-btn--icon pane__action-btn--danger"
              onClick={(e) => { e.stopPropagation(); onDismiss(session.id); }}
              aria-label="Close"
              data-tip="Close"
            >
              <CloseIcon />
            </button>
          )}
        </div>
      </div>
      <div className="pane__meta">
        <span className="pane__status">{statusText}</span>
        <span className="pane__sep" />
        <span className="pane__elapsed">{elapsed}</span>
        {session.group && (
          <>
            <span className="pane__sep" />
            <span className="pane__group">{session.group}</span>
          </>
        )}
      </div>

      <div className="pane__progress" aria-hidden="true">
        {session.status === 'running' && <div className="pane__progress-bar" />}
      </div>

      {frameRect && (showErrorUi || browserDead || browserMissing || session.status === 'draft' || endedWithoutBrowser) && (() => {
        const isStarting = !showErrorUi && !browserDead && !browserMissing && session.status === 'draft';
        const browserLine = browserDead
          ? 'Browser ended'
          : browserMissing
            ? (session.status === 'stopped' || session.status === 'idle' || session.status === 'stuck' ? 'Browser stopped' : 'No browser started yet')
            : (endedWithoutBrowser ? 'Browser ended' : null);
        const primaryLine = showErrorUi
          ? friendlyError(session.error!)
          : isCancellation
            ? 'Task was cancelled.'
            : browserLine;
        const subLine = (showErrorUi || isCancellation) ? browserLine : null;
        const showActions = !isStarting && (onRerun || canResume || (showErrorUi && isApiKeyError(session.error) && onOpenSettings));
        return (
          <div
            className="pane__browser-frame"
            style={{
              left: frameRect.left,
              top: frameRect.top,
              width: frameRect.width,
              height: frameRect.height,
            }}
          >
            <div className="pane__browser-starting">
              {showErrorUi && (
                <div className="pane__error-icon">
                  <ErrorIcon />
                </div>
              )}
              <span className="pane__browser-starting-row">
                {isStarting ? (
                  <>
                    <span className="pane__spinner" />
                    <span>Browser starting…</span>
                  </>
                ) : (
                  <span>{primaryLine}</span>
                )}
              </span>
              {subLine && primaryLine !== subLine && (
                <span className="pane__browser-subline">{subLine}</span>
              )}
              {showActions && (
                <div className="pane__browser-actions">
                  {canResume && (
                    <button
                      className="pane__rerun-btn pane__rerun-btn--primary"
                      onClick={() => onResume?.(session.id)}
                    >
                      <ResumeIcon />
                      <span>Resume</span>
                    </button>
                  )}
                  {showErrorUi && isApiKeyError(session.error) && onOpenSettings && (
                    <button className="pane__rerun-btn" onClick={onOpenSettings}>
                      <span>Open Settings</span>
                    </button>
                  )}
                  {onRerun && (
                    <button
                      className="pane__rerun-btn"
                      onClick={() => onRerun(session.id)}
                    >
                      <RerunIcon />
                      <span>Rerun task</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })()}
      <div
        className="pane__output"
      />

    </div>
  );
}

export default AgentPane;
