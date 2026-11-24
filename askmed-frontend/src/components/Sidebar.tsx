import { FileText, PanelLeftClose, Plus, Trash2 } from 'lucide-react';
import type { ConversationSummary } from '../types/chat';
import { BrandMark } from './BrandMark';

interface SidebarProps {
  conversations: ConversationSummary[];
  activeId: string | null;
  collapsed: boolean;
  loadingList: boolean;
  backendStatus: 'checking' | 'ok' | 'degraded' | 'offline';
  onNewConversation: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCollapse: () => void;
}

function getDateBucket(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Earlier';
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = startToday - 86400000;
  const startWeek = startToday - 6 * 86400000;
  const t = d.getTime();
  if (t >= startToday) return 'Today';
  if (t >= startYesterday) return 'Yesterday';
  if (t >= startWeek) return 'Previous 7 days';
  return 'Earlier';
}

function groupByDate(list: ConversationSummary[]): Array<{ label: string; items: ConversationSummary[] }> {
  const order = ['Today', 'Yesterday', 'Previous 7 days', 'Earlier'];
  const map = new Map<string, ConversationSummary[]>();
  for (const c of list) {
    const bucket = getDateBucket(c.updatedAt || c.createdAt);
    const arr = map.get(bucket) || [];
    arr.push(c);
    map.set(bucket, arr);
  }
  return order.filter((k) => map.has(k)).map((label) => ({ label, items: map.get(label)! }));
}

function summarizeDocs(conv: ConversationSummary): string {
  const docs = conv.documents || [];
  if (!docs.length) return '';
  if (docs.length === 1) return docs[0].title || docs[0].filename;
  return `${docs.length} documents`;
}

export function Sidebar({
  conversations,
  activeId,
  collapsed,
  loadingList,
  backendStatus,
  onNewConversation,
  onSelect,
  onDelete,
  onCollapse,
}: SidebarProps) {
  const groups = groupByDate(conversations);

  const statusLabel =
    backendStatus === 'ok'
      ? 'Connected'
      : backendStatus === 'degraded'
        ? 'Setup needed'
        : backendStatus === 'offline'
          ? 'Offline'
          : 'Connecting…';

  const statusClass =
    backendStatus === 'ok' ? 'ok' : backendStatus === 'offline' ? 'err' : '';

  return (
    <>
      <div
        className={`sidebar-backdrop ${collapsed ? '' : 'visible'}`}
        onClick={onCollapse}
        aria-hidden="true"
      />
      <aside
        className={`sidebar ${collapsed ? 'collapsed' : ''}`}
        aria-label="Conversation sidebar"
      >
        <div className="sidebar-top">
          <div className="brand-lockup">
            <span className="brand-mark">
              <BrandMark size={14} />
            </span>
            <span className="brand-wordmark">AskMed</span>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onCollapse}
            aria-label="Close sidebar"
            title="Close sidebar"
          >
            <PanelLeftClose size={17} strokeWidth={1.7} />
          </button>
        </div>

        <div className="new-chat-wrap">
          <button
            type="button"
            className="new-chat-btn"
            onClick={onNewConversation}
          >
            <span className="new-chat-left">
              <Plus size={15} strokeWidth={2} />
              <span>New conversation</span>
            </span>
            <span className="kbd-hint" aria-hidden="true">
              ⌘K
            </span>
          </button>
        </div>

        <nav className="history-list" aria-label="Previous conversations">
          {loadingList ? (
            <p className="history-empty">Loading conversations…</p>
          ) : groups.length === 0 ? (
            <p className="history-empty">
              Upload healthcare PDFs to start your first conversation.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.label} className="history-group">
                <div className="sidebar-section-label">{group.label}</div>
                {group.items.map((conv) => {
                  const isActive = conv.conversationId === activeId;
                  const docSummary = summarizeDocs(conv);
                  return (
                    <div
                      key={conv.conversationId}
                      className={`history-item ${isActive ? 'active' : ''}`}
                    >
                      <button
                        type="button"
                        className="history-item-btn"
                        onClick={() => onSelect(conv.conversationId)}
                        aria-current={isActive ? 'page' : undefined}
                        title={conv.title}
                      >
                        <span className="history-item-title">{conv.title}</span>
                        {docSummary && (
                          <span className="history-item-docs">
                            <FileText size={11} strokeWidth={1.7} />
                            <span>{docSummary}</span>
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="history-delete-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(conv.conversationId);
                        }}
                        aria-label={`Delete conversation ${conv.title}`}
                        title="Delete conversation"
                      >
                        <Trash2 size={14} strokeWidth={1.7} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </nav>

        <div className="sidebar-footer">
          <span className="status-pill" title={`Backend status: ${statusLabel}`}>
            <span className={`status-dot ${statusClass}`} />
            <span>{statusLabel}</span>
          </span>
        </div>
      </aside>
    </>
  );
}
