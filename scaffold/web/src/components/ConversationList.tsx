import type { Conversation } from '../api/client';

interface ConversationListProps {
  conversations: Conversation[];
  selectedContact: string | null;
  onSelect: (contact: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

export function ConversationList({
  conversations,
  selectedContact,
  onSelect,
  hasMore,
  loadingMore,
  onLoadMore,
}: ConversationListProps) {
  return (
    <aside
      style={{
        width: 300,
        borderRight: '1px solid #e2e8f0',
        display: 'flex',
        flexDirection: 'column',
        background: '#fff',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid #e2e8f0',
          fontWeight: 600,
          fontSize: 14,
          color: '#0f172a',
        }}
      >
        Conversations ({conversations.length})
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {conversations.length === 0 ? (
          <div style={{ padding: 20, color: '#64748b', fontSize: 13 }}>
            No conversations in this workspace yet.
          </div>
        ) : (
          conversations.map((c) => {
            const active = c.contact === selectedContact;
            return (
              <button
                key={c.contact}
                type="button"
                onClick={() => onSelect(c.contact)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '12px 16px',
                  border: 'none',
                  borderBottom: '1px solid #f1f5f9',
                  background: active ? '#eff6ff' : '#fff',
                  cursor: 'pointer',
                  display: 'block',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 4,
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: 14, color: '#0f172a' }}>
                    {c.contact}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      padding: '2px 6px',
                      borderRadius: 4,
                      background: c.status === 'closed' ? '#f1f5f9' : '#dcfce7',
                      color: c.status === 'closed' ? '#475569' : '#166534',
                    }}
                  >
                    {c.status}
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 12,
                    color: '#64748b',
                  }}
                >
                  <span>{c.assignee ? `Claimed: ${c.assignee}` : 'Unassigned'}</span>
                  <span>
                    {new Date(c.lastActivityAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </button>
            );
          })
        )}

        {hasMore && (
          <div style={{ padding: 12, textAlign: 'center' }}>
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                border: '1px solid #cbd5e1',
                borderRadius: 6,
                background: '#fff',
                cursor: 'pointer',
              }}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
