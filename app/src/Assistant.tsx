import { useEffect, useRef, useState } from 'react';
import { AssistantModel, type AssistantSource } from '@substrat-run/elements/assistant-model';
import type { SubAssistant } from '@substrat-run/elements/assistant';
import { ApiError, callerHeaders } from './api';

/**
 * One conversation per garden, kept for the life of the page: closing the panel keeps it,
 * and opening another garden starts that garden's own.
 */
const conversations = new Map<string, AssistantModel>();

/** The worker's `/api/assistant`: the conversation in, one answer out. */
function sourceFor(siteId: string): AssistantSource {
  return {
    async *send({ text, history }, { signal }) {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', ...callerHeaders() },
        body: JSON.stringify({
          siteId,
          messages: [
            ...history.map((h) => ({ role: h.role, content: h.text })),
            { role: 'user', content: text },
          ],
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        answer?: string;
        used?: string[];
        detail?: string;
        error?: string;
      };
      if (!res.ok) throw new ApiError(res.status, body.detail ?? body.error ?? res.statusText, body);
      // What it computed on the way — one quiet line each, before the answer.
      for (const text of body.used ?? []) yield { t: 'host-event', kind: 'read', text };
      yield { t: 'text-delta', pid: 'answer', delta: body.answer ?? '' };
      yield { t: 'turn-finish', reason: 'done' };
    },
  };
}

function conversationFor(siteId: string): AssistantModel {
  let model = conversations.get(siteId);
  if (!model) {
    model = new AssistantModel({ source: sourceFor(siteId) });
    conversations.set(siteId, model);
  }
  return model;
}

/**
 * Ask about the survey: a side drawer around `<sub-assistant>`. It reads the garden as the
 * signed-in person does (a viewer may ask too) and changes nothing.
 */
export function AssistantDrawer(props: { siteId: string; siteName: string; onClose: () => void }) {
  const el = useRef<SubAssistant | null>(null);
  const [status, setStatus] = useState<{ available: boolean; model: string | null } | null>(null);

  useEffect(() => {
    if (el.current) el.current.model = conversationFor(props.siteId);
    // Opened from ⌘K / Ctrl-K: the cursor belongs in the question box.
    const t = setTimeout(() => el.current?.focus(), 150);
    return () => clearTimeout(t);
  }, [props.siteId]);
  useEffect(() => {
    void fetch('/api/assistant', { headers: callerHeaders() })
      .then((r) => (r.ok ? r.json() : { available: false, model: null }))
      .then(setStatus)
      .catch(() => setStatus({ available: false, model: null }));
  }, []);

  return (
    <wa-drawer
      class="assistant-drawer"
      label={`Ask about ${props.siteName}`}
      placement="end"
      open
      light-dismiss
      onwa-after-hide={(e: Event) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="assistant-body">
        <sub-assistant
          ref={(node: SubAssistant | null) => {
            el.current = node;
            if (node) node.model = conversationFor(props.siteId);
          }}
          label="Conversation about the survey"
          placeholder="Ask about your measurements…"
        >
          <div slot="empty" className="assistant-empty">
            <p>
              Ask about this garden's survey. The AI sees every point, tape pull and residual, and can
              check impossible triangles, test what-ifs and look for typos before it answers.
            </p>
            <ul>
              <li>Which measurement is probably wrong?</li>
              <li>What if the pillar to the pool is 369 cm?</li>
              <li>Is Pool NW corner on the wrong side?</li>
              <li>What should I measure next?</li>
            </ul>
            <p className="hint">⌘K / Ctrl-K opens this from anywhere in the garden.</p>
          </div>
        </sub-assistant>
        <div className="hint assistant-foot">
          {status === null
            ? ''
            : status.available
              ? `Answered by ${status.model} through the Substrat platform. It reads your survey; it changes nothing.`
              : 'No AI model is available on this install right now.'}
        </div>
      </div>
    </wa-drawer>
  );
}
