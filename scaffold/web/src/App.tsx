import { useCallback, useEffect, useRef, useState } from 'react';
import {
  claimConversation,
  closeConversation,
  getConversationDetail,
  getMe,
  listConversations,
  logout,
  reopenConversation,
  sendReply,
  type Conversation,
  type Message,
  type UserMe,
} from './api/client';
import {
  connectWorkspaceSocket,
  type SocketStatus,
  type WorkspaceEvent,
} from './api/socket';
import { ConversationList } from './components/ConversationList';
import { LoginScreen } from './components/LoginScreen';
import { MessageThread } from './components/MessageThread';

const PAGE_SIZE = 50;

export function App() {
  const [user, setUser] = useState<UserMe | null | undefined>(undefined);
  const [workspace, setWorkspace] = useState<string>('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [selectedContact, setSelectedContact] = useState<string | null>(null);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<SocketStatus>('disconnected');

  const selectedContactRef = useRef<string | null>(null);
  selectedContactRef.current = selectedContact;

  // 1. Check current session on mount
  useEffect(() => {
    getMe()
      .then((me) => {
        setUser(me);
        if (me && me.workspaces.length > 0) {
          setWorkspace(me.workspaces[0].id);
        }
      })
      .catch(() => setUser(null));
  }, []);

  // 2. Load conversations whenever workspace changes
  useEffect(() => {
    if (!workspace) return;
    setSelectedContact(null);
    setActiveConversation(null);
    setMessages([]);
    setActionError(null);

    listConversations(workspace, undefined, PAGE_SIZE)
      .then((list) => {
        setConversations(list);
        setHasMore(list.length === PAGE_SIZE);
      })
      .catch((err) => {
        setActionError(err instanceof Error ? err.message : 'Failed to load conversations');
      });
  }, [workspace]);

  // 3. Load messages when a contact is selected
  useEffect(() => {
    if (!workspace || !selectedContact) {
      setActiveConversation(null);
      setMessages([]);
      return;
    }

    setLoadingThread(true);
    setActionError(null);
    getConversationDetail(workspace, selectedContact)
      .then((data) => {
        setActiveConversation(data.conversation);
        setMessages(data.messages);
      })
      .catch((err) => {
        setActionError(err instanceof Error ? err.message : 'Failed to load messages');
      })
      .finally(() => setLoadingThread(false));
  }, [workspace, selectedContact]);

  // 4. Subscribe to live WebSocket events for the active workspace
  const handleWsEvent = useCallback(
    (event: WorkspaceEvent) => {
      if (event.type === 'message.inbound') {
        setConversations((prev) => {
          const existing = prev.find((c) => c.contact === event.contact);
          const updated: Conversation = existing
            ? { ...existing, lastActivityAt: event.occurred_at }
            : {
                workspace,
                contact: event.contact,
                assignee: null,
                status: 'open',
                lastActivityAt: event.occurred_at,
                createdAt: event.occurred_at,
              };
          const rest = prev.filter((c) => c.contact !== event.contact);
          return [updated, ...rest];
        });

        if (selectedContactRef.current === event.contact) {
          setMessages((prev) => {
            if (prev.some((m) => m.messageId === event.message_id)) return prev;
            return [
              ...prev,
              {
                workspace,
                contact: event.contact,
                direction: 'inbound',
                messageId: event.message_id,
                text: event.text,
                occurredAt: event.occurred_at,
                createdAt: event.occurred_at,
              },
            ];
          });
        }
      } else if (event.type === 'conversation.assigned') {
        setConversations((prev) =>
          prev.map((c) =>
            c.contact === event.contact ? { ...c, assignee: event.assignee } : c,
          ),
        );
        if (selectedContactRef.current === event.contact) {
          setActiveConversation((prev) =>
            prev ? { ...prev, assignee: event.assignee } : prev,
          );
        }
      } else if (event.type === 'message.status') {
        if (selectedContactRef.current === event.contact) {
          setMessages((prev) =>
            prev.map((m) =>
              m.clientRef === event.client_ref
                ? { ...m, status: event.status, messageId: event.message_id ?? m.messageId }
                : m,
            ),
          );
        }
      }
    },
    [workspace],
  );

  useEffect(() => {
    if (!workspace || !user) return;
    return connectWorkspaceSocket(workspace, handleWsEvent, setWsStatus);
  }, [workspace, user, handleWsEvent]);

  async function handleLoadMore() {
    if (!workspace || conversations.length === 0 || loadingMore) return;
    const oldest = conversations[conversations.length - 1];
    setLoadingMore(true);
    try {
      const more = await listConversations(workspace, oldest.lastActivityAt, PAGE_SIZE);
      setConversations((prev) => {
        const seen = new Set(prev.map((c) => c.contact));
        return [...prev, ...more.filter((c) => !seen.has(c.contact))];
      });
      setHasMore(more.length === PAGE_SIZE);
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleClaim() {
    if (!workspace || !selectedContact) return;
    setActionError(null);
    try {
      const res = await claimConversation(workspace, selectedContact);
      setActiveConversation(res.conversation);
      setConversations((prev) =>
        prev.map((c) => (c.contact === selectedContact ? res.conversation : c)),
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to claim conversation');
    }
  }

  async function handleToggleStatus() {
    if (!workspace || !selectedContact || !activeConversation) return;
    setActionError(null);
    try {
      const res =
        activeConversation.status === 'open'
          ? await closeConversation(workspace, selectedContact)
          : await reopenConversation(workspace, selectedContact);
      setActiveConversation(res.conversation);
      setConversations((prev) =>
        prev.map((c) => (c.contact === selectedContact ? res.conversation : c)),
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update status');
    }
  }

  async function handleSendReply(text: string) {
    if (!workspace || !selectedContact) return;
    setActionError(null);
    const clientRef = `web_${crypto.randomUUID()}`;
    const nowIso = new Date().toISOString();

    const optimistic: Message = {
      workspace,
      contact: selectedContact,
      direction: 'outbound',
      clientRef,
      text,
      status: 'queued',
      occurredAt: nowIso,
      createdAt: nowIso,
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      await sendReply(workspace, selectedContact, text, clientRef);
      setConversations((prev) => {
        const current = prev.find((c) => c.contact === selectedContact);
        if (!current) return prev;
        const updated = { ...current, lastActivityAt: nowIso };
        return [updated, ...prev.filter((c) => c.contact !== selectedContact)];
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to send reply');
      setMessages((prev) => prev.filter((m) => m.clientRef !== clientRef));
    }
  }

  async function handleLogout() {
    await logout();
    setUser(null);
    setWorkspace('');
    setConversations([]);
  }

  if (user === undefined) {
    return (
      <main style={{ fontFamily: 'system-ui', padding: 40, textAlign: 'center' }}>
        Loading Switchboard…
      </main>
    );
  }

  if (user === null) {
    return <LoginScreen />;
  }

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* Top Bar */}
      <header
        style={{
          height: 52,
          padding: '0 20px',
          borderBottom: '1px solid #e2e8f0',
          background: '#0f172a',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <strong style={{ fontSize: 16 }}>Switchboard</strong>
          <select
            aria-label="Workspace"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            style={{
              padding: '4px 8px',
              borderRadius: 4,
              border: '1px solid #334155',
              background: '#1e293b',
              color: '#fff',
              fontSize: 13,
            }}
          >
            {user.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.id} ({w.role})
              </option>
            ))}
          </select>
          <span
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 10,
              background: wsStatus === 'connected' ? '#166534' : '#92400e',
            }}
          >
            {wsStatus === 'connected' ? 'Live' : wsStatus}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
          <span>{user.name || user.sub}</span>
          <button
            type="button"
            onClick={handleLogout}
            style={{
              padding: '4px 10px',
              borderRadius: 4,
              border: '1px solid #475569',
              background: 'transparent',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Main Split Pane */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <ConversationList
          conversations={conversations}
          selectedContact={selectedContact}
          onSelect={setSelectedContact}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={handleLoadMore}
        />
        <MessageThread
          conversation={activeConversation}
          messages={messages}
          currentUserSub={user.sub}
          loading={loadingThread}
          actionError={actionError}
          onClaim={handleClaim}
          onToggleStatus={handleToggleStatus}
          onSendReply={handleSendReply}
        />
      </div>
    </div>
  );
}
