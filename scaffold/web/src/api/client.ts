export interface WorkspaceRole {
  id: string;
  role: string;
}

export interface UserMe {
  sub: string;
  workspaces: WorkspaceRole[];
  name?: string;
  email?: string;
}

export interface Conversation {
  workspace: string;
  contact: string;
  assignee: string | null;
  status: 'open' | 'closed';
  lastActivityAt: string;
  createdAt: string;
}

export interface Message {
  workspace: string;
  contact: string;
  direction: 'inbound' | 'outbound';
  messageId?: string;
  clientRef?: string;
  text: string;
  status?: 'queued' | 'sent' | 'delivered' | 'failed';
  occurredAt?: string;
  createdAt: string;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`) as Error & {
      status?: number;
      body?: Record<string, unknown>;
    };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

export async function getMe(): Promise<UserMe | null> {
  const res = await fetch('/api/me');
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Failed to load user (${res.status})`);
  return res.json();
}

export async function logout(): Promise<void> {
  await requestJson('/auth/logout', { method: 'POST' });
}

export async function listConversations(
  workspace: string,
  before?: string,
  limit = 50,
): Promise<Conversation[]> {
  const params = new URLSearchParams({ workspace, limit: String(limit) });
  if (before) params.set('before', before);
  const data = await requestJson<{ conversations: Conversation[] }>(
    `/api/conversations?${params.toString()}`,
  );
  return data.conversations;
}

export async function getConversationDetail(
  workspace: string,
  contact: string,
): Promise<{ conversation: Conversation | null; messages: Message[] }> {
  const encoded = encodeURIComponent(contact);
  return requestJson(`/api/conversations/${encoded}?workspace=${encodeURIComponent(workspace)}`);
}

export async function claimConversation(
  workspace: string,
  contact: string,
): Promise<{ ok: boolean; conversation: Conversation }> {
  const encoded = encodeURIComponent(contact);
  return requestJson(
    `/api/conversations/${encoded}/claim?workspace=${encodeURIComponent(workspace)}`,
    { method: 'POST' },
  );
}

export async function closeConversation(
  workspace: string,
  contact: string,
): Promise<{ ok: boolean; conversation: Conversation }> {
  const encoded = encodeURIComponent(contact);
  return requestJson(
    `/api/conversations/${encoded}/close?workspace=${encodeURIComponent(workspace)}`,
    { method: 'POST' },
  );
}

export async function reopenConversation(
  workspace: string,
  contact: string,
): Promise<{ ok: boolean; conversation: Conversation }> {
  const encoded = encodeURIComponent(contact);
  return requestJson(
    `/api/conversations/${encoded}/reopen?workspace=${encodeURIComponent(workspace)}`,
    { method: 'POST' },
  );
}

export async function sendReply(
  workspace: string,
  contact: string,
  text: string,
  clientRef: string,
): Promise<{ ok: boolean; client_ref: string; duplicate: boolean; status: string }> {
  const encoded = encodeURIComponent(contact);
  return requestJson(
    `/api/conversations/${encoded}/replies?workspace=${encodeURIComponent(workspace)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, client_ref: clientRef }),
    },
  );
}
