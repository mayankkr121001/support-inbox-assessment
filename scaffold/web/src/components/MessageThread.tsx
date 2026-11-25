import { useState, type FormEvent } from 'react';
import type { Conversation, Message } from '../api/client';

interface MessageThreadProps {
  conversation: Conversation | null;
  messages: Message[];
  currentUserSub: string;
  loading: boolean;
  actionError: string | null;
  onClaim: () => Promise<void>;
  onToggleStatus: () => Promise<void>;
  onSendReply: (text: string) => Promise<void>;
}

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  queued: { bg: '#fef3c7', fg: '#92400e' },
  sent: { bg: '#e0f2fe', fg: '#075985' },
  delivered: { bg: '#dcfce7', fg: '#166534' },
  failed: { bg: '#fee2e2', fg: '#991b1b' },
};

export function MessageThread({
  conversation,
  messages,
  currentUserSub,
  loading,
  actionError,
  onClaim,
  onToggleStatus,
  onSendReply,
}: MessageThreadProps) {
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);

  if (!conversation) {
    return (
      <section
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#64748b',
          fontSize: 14,
        }}
      >
        Select a conversation to view messages and reply.
      </section>
    );
  }

  const claimedByMe = conversation.assignee === currentUserSub;
  const claimedByOther =
    conversation.assignee !== null && conversation.assignee !== currentUserSub;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = replyText.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onSendReply(trimmed);
      setReplyText('');
    } finally {
      setSending(false);
    }
  }

  return (
    <section
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        background: '#f8fafc',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 20px',
          background: '#fff',
          borderBottom: '1px solid #e2e8f0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontWeight: 600, fontSize: 16, color: '#0f172a' }}>
            {conversation.contact}
          </div>
          <div style={{ fontSize: 12, color: '#64748b' }}>
            {conversation.assignee
              ? `Assigned to ${conversation.assignee}`
              : 'Unassigned'}{' '}
            · Status: <strong>{conversation.status}</strong>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={onClaim}
            disabled={claimedByMe}
            style={{
              padding: '6px 12px',
              fontSize: 13,
              borderRadius: 6,
              border: '1px solid #cbd5e1',
              background: claimedByMe ? '#e2e8f0' : claimedByOther ? '#fff' : '#0f172a',
              color: claimedByMe ? '#475569' : claimedByOther ? '#0f172a' : '#fff',
              cursor: claimedByMe ? 'default' : 'pointer',
            }}
          >
            {claimedByMe
              ? 'Claimed by you'
              : claimedByOther
                ? `Claimed by ${conversation.assignee}`
                : 'Claim'}
          </button>

          <button
            type="button"
            onClick={onToggleStatus}
            style={{
              padding: '6px 12px',
              fontSize: 13,
              borderRadius: 6,
              border: '1px solid #cbd5e1',
              background: '#fff',
              color: '#0f172a',
              cursor: 'pointer',
            }}
          >
            {conversation.status === 'open' ? 'Close' : 'Reopen'}
          </button>
        </div>
      </div>

      {actionError && (
        <div
          style={{
            padding: '8px 20px',
            background: '#fee2e2',
            color: '#991b1b',
            fontSize: 13,
            borderBottom: '1px solid #fecaca',
          }}
        >
          {actionError}
        </div>
      )}

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {loading ? (
          <div style={{ color: '#64748b', fontSize: 13 }}>Loading messages…</div>
        ) : messages.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: 13 }}>No messages yet.</div>
        ) : (
          messages.map((m, idx) => {
            const isOutbound = m.direction === 'outbound';
            const badge = m.status ? STATUS_COLORS[m.status] : undefined;
            return (
              <div
                key={m.messageId || m.clientRef || idx}
                style={{
                  alignSelf: isOutbound ? 'flex-end' : 'flex-start',
                  maxWidth: '72%',
                  background: isOutbound ? '#0f172a' : '#fff',
                  color: isOutbound ? '#fff' : '#0f172a',
                  border: isOutbound ? 'none' : '1px solid #e2e8f0',
                  borderRadius: 10,
                  padding: '8px 12px',
                  fontSize: 14,
                }}
              >
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
                <div
                  style={{
                    marginTop: 4,
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    fontSize: 11,
                    opacity: 0.8,
                  }}
                >
                  <span>
                    {new Date(m.occurredAt || m.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  {isOutbound && m.status && (
                    <span
                      style={{
                        padding: '1px 5px',
                        borderRadius: 4,
                        background: badge?.bg ?? '#e2e8f0',
                        color: badge?.fg ?? '#0f172a',
                        fontWeight: 600,
                      }}
                    >
                      {m.status}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Reply Input */}
      <form
        onSubmit={handleSubmit}
        style={{
          padding: 12,
          background: '#fff',
          borderTop: '1px solid #e2e8f0',
          display: 'flex',
          gap: 8,
        }}
      >
        <input
          type="text"
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          placeholder="Type a reply…"
          style={{
            flex: 1,
            padding: '8px 12px',
            border: '1px solid #cbd5e1',
            borderRadius: 6,
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          disabled={sending || !replyText.trim()}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: 'none',
            background: '#0f172a',
            color: '#fff',
            fontWeight: 500,
            fontSize: 14,
            cursor: sending || !replyText.trim() ? 'not-allowed' : 'pointer',
            opacity: sending || !replyText.trim() ? 0.6 : 1,
          }}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
    </section>
  );
}
