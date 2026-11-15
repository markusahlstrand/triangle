import { useCallback, useEffect, useState } from 'react';
import { members as api, type Invite, type Member } from './api';
import { ErrorNote, OkNote, RemoveButton, Sheet, useAction, valueOf } from './Sheets';

/** What each role means, in the garden's own words (concept §4). */
const ROLE_LABEL: Record<string, string> = {
  'garden-owner': 'Owner — surveys and plans',
  'garden-viewer': 'Viewer — sees everything, changes nothing',
};
const roleName = (key: string) => (key === 'garden-owner' ? 'Owner' : key === 'garden-viewer' ? 'Viewer' : key);

/**
 * Who is in this garden (owner-only): the members with their roles, the open invites,
 * and a new invite — a single-use link the owner hands on, bounded by what they hold.
 */
export function MembersSheet(props: { onClose: () => void }) {
  const [list, setList] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [roleKey, setRoleKey] = useState('garden-viewer');
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const [m, i] = await Promise.all([api.list(), api.invites()]);
    setList(m);
    setRoles(i.roles);
    setInvites(i.invites.filter((x) => x.link?.state === 'open' || x.link === null));
  }, []);
  const action = useAction(load);

  useEffect(() => {
    void action.run(async () => {});
  }, []);

  const invite = () =>
    action.run(async () => {
      const r = await api.invite(roleKey, email.trim() || undefined);
      setLink(r.acceptUrl);
      setCopied(false);
      setEmail('');
    });

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
  };

  return (
    <Sheet title="Members" onClose={props.onClose}>
      {action.error && <ErrorNote>{action.error}</ErrorNote>}

      <div className="section-label">In this garden</div>
      {list === null ? (
        <div className="hint">Loading…</div>
      ) : (
        <div className="member-list">
          {list.map((m) => (
            <div key={m.principal} className="member-row">
              <div className="member-who">
                <div>{m.you ? 'You' : (m.email ?? 'Member')}</div>
                <div className="hint">{m.roles.map(roleName).join(', ') || 'No role'}</div>
              </div>
              {!m.you && !m.ownerOfRecord && (
                <RemoveButton
                  what={m.email ?? 'member'}
                  disabled={action.busy}
                  onClick={() => {
                    if (confirm(`Remove ${m.email ?? 'this member'} from the garden?`)) {
                      void action.run(() => api.remove(m.principal));
                    }
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {invites.length > 0 && (
        <>
          <div className="section-label">Invited, not yet joined</div>
          <div className="member-list">
            {invites.map((i) => (
              <div key={i.principal} className="member-row">
                <div className="member-who">
                  <div>{i.email ?? 'Anyone with the link'}</div>
                  <div className="hint">{roleName(i.roleKey)}</div>
                </div>
                <RemoveButton
                  what="invite"
                  disabled={action.busy}
                  onClick={() => void action.run(() => api.revokeInvite(i.principal))}
                />
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-label">Invite someone</div>
      <wa-select label="Role" value={roleKey} onChange={(e) => setRoleKey(valueOf(e))}>
        {roles.map((r) => (
          <wa-option key={r} value={r}>
            {ROLE_LABEL[r] ?? r}
          </wa-option>
        ))}
      </wa-select>
      <wa-input
        label="Email (optional)"
        hint="With an address, only a sign-in with that verified email can accept."
        type="email"
        value={email}
        onInput={(e) => setEmail(valueOf(e))}
      />
      <div className="actions">
        <wa-button variant="brand" disabled={action.busy} loading={action.busy} onClick={invite}>
          Create invite link
        </wa-button>
      </div>
      {link && (
        <OkNote>
          Send this link to the person you invite. It works once and expires.
          <div className="invite-link">
            <code>{link}</code>
            <wa-button size="small" appearance="outlined" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </wa-button>
          </div>
        </OkNote>
      )}
    </Sheet>
  );
}
