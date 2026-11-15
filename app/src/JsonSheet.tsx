import { useEffect, useMemo, useState } from 'react';
import { surveyJson, type SitePayload } from './api';
import { ErrorNote, OkNote, Sheet } from './Sheets';
import { planImport, type ImportPlan } from './surveyImport';

/**
 * The survey as JSON you can edit in place — the same shape `⇩ JSON` downloads. Change a
 * distance, set `verifiedAt`, add a point or a pull, delete a row; then preview exactly what
 * that means and apply it as ordinary operations (each one on the History, each re-solved).
 */
export function JsonSheet(props: { site: SitePayload; readOnly: boolean; onClose: () => void; onApplied: () => Promise<void> }) {
  const original = useMemo(() => JSON.stringify(surveyJson(props.site), null, 2), [props.site]);
  const [text, setText] = useState(original);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  // The garden moved (an apply, or a change elsewhere): the editor shows it as it now stands —
  // new rows have ids now, and a preview against stale text would replay what is already done.
  useEffect(() => {
    setText(original);
    setPlan(null);
  }, [original]);

  const preview = () => {
    setError(null);
    setDone(null);
    try {
      setPlan(planImport(props.site, text));
    } catch (e) {
      setPlan(null);
      setError((e as Error).message);
    }
  };

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    const ids = new Map<string, string>();
    let ran = 0;
    try {
      for (const step of plan.steps) {
        await step.run(ids);
        ran += 1;
        setProgress(ran);
      }
      setDone(`Applied ${ran} change${ran === 1 ? '' : 's'}.`);
      setPlan(null);
      await props.onApplied();
    } catch (e) {
      // What ran is saved (each step is its own operation); say where it stopped.
      setError(`Stopped after ${ran} of ${plan.steps.length}: ${(e as Error).message}`);
      await props.onApplied();
    } finally {
      setBusy(false);
    }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    setText(await file.text());
    setPlan(null);
    setDone(null);
  };

  return (
    <Sheet title="Survey as JSON" onClose={props.onClose}>
      {error && <ErrorNote>{error}</ErrorNote>}
      {done && <OkNote>{done}</OkNote>}
      <div className="hint">
        Edit the survey directly: change a <code>distanceCm</code>, set or clear <code>verifiedAt</code>, add a point or a
        measurement (no <code>id</code>; name its ends with <code>from</code>/<code>to</code>), or delete a measurement's row.
        Nothing is saved until you apply.
      </div>
      <textarea
        className="json-editor"
        spellCheck={false}
        value={text}
        readOnly={props.readOnly || busy}
        onChange={(e) => {
          setText(e.target.value);
          setPlan(null);
        }}
      />
      {!props.readOnly && (
        <div className="actions">
          <label className="file-pick">
            <input type="file" accept="application/json,.json" onChange={(e) => void loadFile(e.target.files?.[0])} />
            <wa-button appearance="outlined" size="small" onClick={(e: Event) => ((e.currentTarget as HTMLElement).previousElementSibling as HTMLInputElement).click()}>
              Load file…
            </wa-button>
          </label>
          <wa-button appearance="outlined" size="small" disabled={text === original} onClick={() => { setText(original); setPlan(null); }}>
            Reset
          </wa-button>
          <wa-button variant="brand" size="small" disabled={busy || text === original} onClick={preview}>
            Preview changes
          </wa-button>
        </div>
      )}
      {plan && (
        <div className="import-plan">
          <div className="section-label">
            {plan.steps.length === 0 ? 'Nothing to change' : `${plan.steps.length} change${plan.steps.length === 1 ? '' : 's'}`}
          </div>
          {plan.steps.map((s, i) => (
            <div key={i} className={`import-step ${s.kind}${i < progress && busy ? ' done' : ''}`}>
              {s.label}
            </div>
          ))}
          {plan.notes.map((n, i) => (
            <div key={`n${i}`} className="hint">
              {n}
            </div>
          ))}
          {plan.steps.length > 0 && (
            <wa-button variant="brand" disabled={busy} loading={busy} onClick={apply}>
              Apply {plan.steps.length} change{plan.steps.length === 1 ? '' : 's'}
            </wa-button>
          )}
        </div>
      )}
    </Sheet>
  );
}
