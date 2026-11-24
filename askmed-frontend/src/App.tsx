import { useCallback, useEffect, useState } from 'react';
import { PanelLeftOpen, Plus } from 'lucide-react';
import { checkBackendHealth } from './api/askmedApi';
import { Composer } from './components/Composer';
import { DocumentContextBar } from './components/DocumentContextBar';
import { DocumentUploadScreen } from './components/DocumentUploadScreen';
import { EmptyState } from './components/EmptyState';
import { MessageList } from './components/MessageList';
import { PdfViewerPanel, type ActivePdfTarget } from './components/PdfViewerPanel';
import { Sidebar } from './components/Sidebar';
import { useConversations } from './hooks/useConversations';
import type { DocumentRecord } from './types/chat';
import { isSpeechSupported, speakText, stopSpeaking } from './utils/speech';

export function App() {
  const {
    view,
    conversations,
    loadingList,
    activeConversation,
    loadingConversation,
    draftUploads,
    starting,
    setupError,
    isSending,
    startNewConversationFlow,
    addDraftFiles,
    removeDraftFile,
    beginConversation,
    selectConversation,
    deleteConversation,
    sendMessage,
    retryMessage,
    triggerWebSearch,
    dismissWebOffer,
  } = useConversations();

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 820 : false
  );
  const [scrolled, setScrolled] = useState(false);
  const [backendStatus, setBackendStatus] = useState<'checking' | 'ok' | 'degraded' | 'offline'>(
    'checking'
  );
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [pdfTarget, setPdfTarget] = useState<ActivePdfTarget | null>(null);
  const speechSupported = isSpeechSupported();

  const activeId = activeConversation?.conversationId ?? null;

  // Close PDF preview when switching conversations or returning to upload screen
  useEffect(() => {
    setPdfTarget(null);
  }, [activeId, view]);

  const handleOpenPdf = useCallback(
    (doc: DocumentRecord, page: number) => {
      if (!activeId) return;
      setPdfTarget({
        conversationId: activeId,
        docId: doc.docId,
        title: doc.title || doc.filename,
        filename: doc.filename,
        page: Math.max(1, page || 1),
      });
    },
    [activeId]
  );

  const handlePdfPageChange = useCallback((page: number) => {
    setPdfTarget((prev) => (prev ? { ...prev, page } : null));
  }, []);

  useEffect(() => {
    let active = true;
    checkBackendHealth()
      .then((h) => {
        if (active) setBackendStatus(h.status === 'ok' ? 'ok' : 'degraded');
      })
      .catch(() => {
        if (active) setBackendStatus('offline');
      });
    return () => {
      active = false;
    };
  }, []);

  // Stop speech when switching conversations, switching to upload view, or unmounting
  useEffect(() => {
    stopSpeaking();
    setSpeakingMessageId(null);
  }, [activeId, view]);

  useEffect(() => {
    return () => stopSpeaking();
  }, []);

  const handleToggleSpeak = useCallback(
    (messageId: string, content: string) => {
      if (speakingMessageId === messageId) {
        stopSpeaking();
        setSpeakingMessageId(null);
        return;
      }
      const started = speakText(content, {
        onEnd: () => setSpeakingMessageId((curr) => (curr === messageId ? null : curr)),
        onError: () => setSpeakingMessageId((curr) => (curr === messageId ? null : curr)),
      });
      setSpeakingMessageId(started ? messageId : null);
    },
    [speakingMessageId]
  );

  // Global keyboard shortcut: Cmd/Ctrl + K starts a new conversation (returns to upload screen)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        stopSpeaking();
        setSpeakingMessageId(null);
        startNewConversationFlow();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [startNewConversationFlow]);

  const handleSelectConversation = (id: string) => {
    void selectConversation(id);
    if (window.innerWidth <= 820) setSidebarCollapsed(true);
  };

  const handleNewConversation = () => {
    stopSpeaking();
    setSpeakingMessageId(null);
    startNewConversationFlow();
    if (window.innerWidth <= 820) setSidebarCollapsed(true);
  };

  return (
    <div className="app-shell">
      <Sidebar
        conversations={conversations}
        activeId={view === 'chat' ? activeId : null}
        collapsed={sidebarCollapsed}
        loadingList={loadingList}
        backendStatus={backendStatus}
        onNewConversation={handleNewConversation}
        onSelect={handleSelectConversation}
        onDelete={deleteConversation}
        onCollapse={() => setSidebarCollapsed(true)}
      />

      <main className="main-workspace">
        {view === 'upload' ? (
          <DocumentUploadScreen
            uploads={draftUploads}
            starting={starting}
            setupError={setupError}
            historyCount={conversations.length}
            sidebarCollapsed={sidebarCollapsed}
            onAddFiles={addDraftFiles}
            onRemoveFile={removeDraftFile}
            onStartConversation={beginConversation}
            onOpenHistory={() => setSidebarCollapsed(false)}
          />
        ) : (
          <div className={`chat-split-layout ${pdfTarget ? 'with-pdf' : ''}`}>
            <div className="chat-pane">
              <header className={`topbar ${scrolled ? 'scrolled' : ''}`}>
                <div className="topbar-left">
                  {sidebarCollapsed && (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setSidebarCollapsed(false)}
                      aria-label="Open sidebar"
                      title="Open sidebar"
                    >
                      <PanelLeftOpen size={17} strokeWidth={1.7} />
                    </button>
                  )}
                  {activeConversation && (
                    <span className="topbar-title">{activeConversation.title}</span>
                  )}
                </div>

                {sidebarCollapsed && (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={handleNewConversation}
                    aria-label="New conversation"
                    title="New conversation (⌘K)"
                  >
                    <Plus size={17} strokeWidth={1.8} />
                  </button>
                )}
              </header>

              {activeConversation && (
                <DocumentContextBar
                  documents={activeConversation.documents}
                  activeDocId={pdfTarget?.docId}
                  onOpenPdf={handleOpenPdf}
                />
              )}

              <div
                className="conversation-scroll"
                onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 8)}
              >
                {loadingConversation ? (
                  <div className="conversation-column" style={{ paddingTop: 40, color: 'var(--ink-muted)' }}>
                    Restoring conversation…
                  </div>
                ) : activeConversation && activeConversation.messages.length > 0 ? (
                  <MessageList
                    conversationId={activeConversation.conversationId}
                    documents={activeConversation.documents}
                    messages={activeConversation.messages}
                    isSending={isSending}
                    speakingMessageId={speakingMessageId}
                    speechSupported={speechSupported}
                    onRetry={retryMessage}
                    onToggleSpeak={handleToggleSpeak}
                    onTriggerWebSearch={triggerWebSearch}
                    onDismissWebOffer={dismissWebOffer}
                    onOpenPdf={handleOpenPdf}
                  />
                ) : activeConversation ? (
                  <EmptyState
                    documents={activeConversation.documents}
                    onSelectPrompt={sendMessage}
                    disabled={isSending}
                  />
                ) : null}
              </div>

              <Composer
                onSend={sendMessage}
                isSending={isSending}
                focusTrigger={activeId ?? 'new'}
              />
            </div>

            {pdfTarget && (
              <PdfViewerPanel
                target={pdfTarget}
                onPageChange={handlePdfPageChange}
                onClose={() => setPdfTarget(null)}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
