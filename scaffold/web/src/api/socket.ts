export type WorkspaceEvent =
  | {
      seq: number;
      type: 'message.inbound';
      contact: string;
      message_id: string;
      text: string;
      occurred_at: string;
    }
  | {
      seq: number;
      type: 'message.status';
      contact: string;
      client_ref: string;
      status: 'queued' | 'sent' | 'delivered' | 'failed';
      message_id?: string;
    }
  | {
      seq: number;
      type: 'conversation.assigned';
      contact: string;
      assignee: string | null;
    };

export type SocketStatus = 'connecting' | 'connected' | 'disconnected';

export function connectWorkspaceSocket(
  workspace: string,
  onEvent: (event: WorkspaceEvent) => void,
  onStatus: (status: SocketStatus) => void,
): () => void {
  let closed = false;
  let lastSeq = 0;
  let ws: WebSocket | null = null;
  let reconnectTimer: number | undefined;

  function connect() {
    if (closed) return;
    onStatus('connecting');

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({ workspace });
    if (lastSeq > 0) params.set('after', String(lastSeq));

    ws = new WebSocket(`${proto}//${window.location.host}/ws?${params.toString()}`);

    ws.onopen = () => {
      if (!closed) onStatus('connected');
    };

    ws.onmessage = (msg) => {
      try {
        const frame = JSON.parse(String(msg.data)) as WorkspaceEvent;
        if (frame && typeof frame.seq === 'number') {
          if (frame.seq > lastSeq) {
            lastSeq = frame.seq;
          }
          onEvent(frame);
        }
      } catch {
        // Ignore non-JSON frames
      }
    };

    ws.onclose = () => {
      if (closed) return;
      onStatus('disconnected');
      reconnectTimer = window.setTimeout(connect, 1500);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return () => {
    closed = true;
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    ws?.close();
  };
}
