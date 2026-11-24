import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createConversationApi,
  deleteConversationApi,
  dismissConversationWebOfferApi,
  getConversationApi,
  listConversationsApi,
  removeDocumentApi,
  runConversationWebSearchApi,
  sendConversationMessageApi,
  startConversationApi,
  uploadDocumentApi,
} from '../api/askmedApi';
import type {
  ChatMessage,
  ConversationDetail,
  ConversationSummary,
  DraftUploadItem,
} from '../types/chat';

const ACTIVE_CONV_KEY = 'askmed.activeConversationId.v1';
const VALID_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function readSavedActiveId(): string | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_CONV_KEY);
    if (!raw) return null;
    if (!VALID_ID_RE.test(raw)) {
      window.localStorage.removeItem(ACTIVE_CONV_KEY);
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function saveActiveId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(ACTIVE_CONV_KEY, id);
    else window.localStorage.removeItem(ACTIVE_CONV_KEY);
  } catch {
    // Ignore storage errors
  }
}

function makeLocalId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useConversations() {
  const initialSavedId = typeof window !== 'undefined' ? readSavedActiveId() : null;
  const [view, setView] = useState<'upload' | 'chat'>(initialSavedId ? 'chat' : 'upload');
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [activeConversation, setActiveConversation] = useState<ConversationDetail | null>(null);
  const [loadingConversation, setLoadingConversation] = useState(Boolean(initialSavedId));

  // Draft setup state for the document-upload screen (always isolated per new conversation)
  const [draftConversationId, setDraftConversationId] = useState<string | null>(null);
  const [draftUploads, setDraftUploads] = useState<DraftUploadItem[]>([]);
  const [starting, setStarting] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const [isSending, setIsSending] = useState(false);
  const inFlightRef = useRef(false);
  const draftIdPromiseRef = useRef<Promise<string> | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const list = await listConversationsApi();
      setConversations(list);
      setSetupError((prev) => (prev && prev.includes('MongoDB') ? null : prev));
    } catch (err) {
      if (err instanceof Error && /MongoDB|MONGODB_URI/i.test(err.message)) {
        setSetupError(err.message);
      }
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void refreshList();
    // Restore the active conversation after a page refresh so the user stays where they were
    const savedId = readSavedActiveId();
    if (!savedId) return;
    setLoadingConversation(true);
    getConversationApi(savedId)
      .then((detail) => {
        if (cancelled) return;
        setActiveConversation(detail);
        setView('chat');
      })
      .catch(() => {
        if (cancelled) return;
        saveActiveId(null);
        setView('upload');
      })
      .finally(() => {
        if (!cancelled) setLoadingConversation(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshList]);

  /** Lazily create a fresh backend conversation for the current upload screen. */
  const ensureDraftConversation = useCallback(async (): Promise<string> => {
    if (draftConversationId) return draftConversationId;
    if (!draftIdPromiseRef.current) {
      draftIdPromiseRef.current = createConversationApi()
        .then((conv) => {
          setDraftConversationId(conv.conversationId);
          return conv.conversationId;
        })
        .finally(() => {
          draftIdPromiseRef.current = null;
        });
    }
    return draftIdPromiseRef.current;
  }, [draftConversationId]);

  const startNewConversationFlow = useCallback(() => {
    saveActiveId(null);
    setActiveConversation(null);
    setDraftConversationId(null);
    draftIdPromiseRef.current = null;
    setDraftUploads([]);
    setSetupError(null);
    setView('upload');
  }, []);

  const addDraftFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (!files.length) return;
      setSetupError(null);

      let convId: string;
      try {
        convId = await ensureDraftConversation();
      } catch (err) {
        setSetupError(
          err instanceof Error
            ? err.message
            : 'Unable to start a new conversation. Please check the server connection.'
        );
        return;
      }

      for (const file of files) {
        const localId = makeLocalId();
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (!isPdf) {
          setDraftUploads((prev) => [
            ...prev,
            {
              localId,
              filename: file.name,
              sizeBytes: file.size,
              status: 'error',
              error: 'Only PDF files are supported',
            },
          ]);
          continue;
        }

        setDraftUploads((prev) => [
          ...prev,
          {
            localId,
            filename: file.name,
            sizeBytes: file.size,
            status: 'uploading',
          },
        ]);

        try {
          const { document } = await uploadDocumentApi(convId, file);
          setDraftUploads((prev) =>
            prev.map((u) =>
              u.localId === localId
                ? {
                    ...u,
                    status: 'ready',
                    docId: document.docId,
                    title: document.title,
                    totalPages: document.totalPages,
                  }
                : u
            )
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Upload failed';
          setDraftUploads((prev) =>
            prev.map((u) =>
              u.localId === localId ? { ...u, status: 'error', error: errMsg } : u
            )
          );
        }
      }
    },
    [ensureDraftConversation]
  );

  const removeDraftFile = useCallback(
    async (localId: string) => {
      const target = draftUploads.find((u) => u.localId === localId);
      setDraftUploads((prev) => prev.filter((u) => u.localId !== localId));
      if (target?.docId && draftConversationId) {
        await removeDocumentApi(draftConversationId, target.docId).catch(() => {
          // Non-fatal if already removed.
        });
      }
    },
    [draftConversationId, draftUploads]
  );

  const beginConversation = useCallback(async () => {
    if (!draftConversationId || starting) return;
    setStarting(true);
    setSetupError(null);
    try {
      const started = await startConversationApi(draftConversationId);
      saveActiveId(started.conversationId);
      setActiveConversation(started);
      setConversations((prev) => [
        started,
        ...prev.filter((c) => c.conversationId !== started.conversationId),
      ]);
      // Reset draft state so next "New conversation" always starts completely fresh
      setDraftConversationId(null);
      setDraftUploads([]);
      setView('chat');
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'Could not start conversation.');
    } finally {
      setStarting(false);
    }
  }, [draftConversationId, starting]);

  const selectConversation = useCallback(async (conversationId: string) => {
    setLoadingConversation(true);
    setSetupError(null);
    try {
      const detail = await getConversationApi(conversationId);
      saveActiveId(detail.conversationId);
      setActiveConversation(detail);
      setView('chat');
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'Unable to load conversation.');
    } finally {
      setLoadingConversation(false);
    }
  }, []);

  const deleteConversation = useCallback(
    async (conversationId: string) => {
      setConversations((prev) => prev.filter((c) => c.conversationId !== conversationId));
      if (activeConversation?.conversationId === conversationId) {
        saveActiveId(null);
        setActiveConversation(null);
        setView('upload');
      }
      await deleteConversationApi(conversationId).catch(() => {
        void refreshList();
      });
    },
    [activeConversation, refreshList]
  );

  const sendMessage = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text || !activeConversation || inFlightRef.current) return;

      inFlightRef.current = true;
      setIsSending(true);
      const convId = activeConversation.conversationId;
      const tempUserId = makeLocalId();
      const optimisticUser: ChatMessage = {
        id: tempUserId,
        role: 'user',
        content: text,
        createdAt: Date.now(),
      };

      setActiveConversation((prev) =>
        prev && prev.conversationId === convId
          ? {
              ...prev,
              messages: [
                ...prev.messages.map((m) => (m.error ? { ...m, error: undefined } : m)),
                optimisticUser,
              ],
            }
          : prev
      );

      try {
        const res = await sendConversationMessageApi(convId, text);
        setActiveConversation((prev) =>
          prev && prev.conversationId === convId
            ? {
                ...prev,
                title: res.title,
                messages: [
                  ...prev.messages.filter((m) => m.id !== tempUserId),
                  res.userMessage,
                  res.assistantMessage,
                ],
                updatedAt: new Date().toISOString(),
              }
            : prev
        );
        setConversations((prev) => {
          const existing = prev.find((c) => c.conversationId === convId);
          const updated: ConversationSummary = {
            ...(existing || activeConversation),
            title: res.title,
            updatedAt: new Date().toISOString(),
          };
          return [updated, ...prev.filter((c) => c.conversationId !== convId)];
        });
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : 'Something went wrong while sending your message.';
        setActiveConversation((prev) =>
          prev && prev.conversationId === convId
            ? {
                ...prev,
                messages: prev.messages.map((m) =>
                  m.id === tempUserId ? { ...m, error: errMsg } : m
                ),
              }
            : prev
        );
      } finally {
        inFlightRef.current = false;
        setIsSending(false);
      }
    },
    [activeConversation]
  );

  const retryMessage = useCallback(
    async (messageId: string) => {
      if (!activeConversation || inFlightRef.current) return;
      const failed = activeConversation.messages.find((m) => m.id === messageId && m.role === 'user');
      if (!failed) return;

      // Remove failed bubble and resend cleanly
      const convId = activeConversation.conversationId;
      setActiveConversation((prev) =>
        prev && prev.conversationId === convId
          ? { ...prev, messages: prev.messages.filter((m) => m.id !== messageId) }
          : prev
      );
      await sendMessage(failed.content);
    },
    [activeConversation, sendMessage]
  );

  const dismissWebOffer = useCallback(
    (messageId: string) => {
      if (!activeConversation) return;
      const convId = activeConversation.conversationId;
      setActiveConversation((prev) =>
        prev && prev.conversationId === convId
          ? {
              ...prev,
              messages: prev.messages.map((m) =>
                m.id === messageId
                  ? { ...m, webOfferDismissed: true, webSearchError: undefined }
                  : m
              ),
            }
          : prev
      );
      void dismissConversationWebOfferApi(convId, messageId).catch(() => {});
    },
    [activeConversation]
  );

  const triggerWebSearch = useCallback(
    async (messageId: string) => {
      if (!activeConversation || inFlightRef.current) return;
      const targetMsg = activeConversation.messages.find((m) => m.id === messageId);
      const query = targetMsg?.webSearchQuestion;
      if (!query) return;

      inFlightRef.current = true;
      setIsSending(true);
      const convId = activeConversation.conversationId;

      setActiveConversation((prev) =>
        prev && prev.conversationId === convId
          ? {
              ...prev,
              messages: prev.messages.map((m) =>
                m.id === messageId
                  ? { ...m, webSearchLoading: true, webSearchError: undefined }
                  : m
              ),
            }
          : prev
      );

      try {
        const res = await runConversationWebSearchApi(convId, query, messageId);
        setActiveConversation((prev) =>
          prev && prev.conversationId === convId
            ? {
                ...prev,
                messages: [
                  ...prev.messages.map((m) =>
                    m.id === messageId
                      ? { ...m, webSearchLoading: false, webOfferDismissed: true }
                      : m
                  ),
                  res.assistantMessage,
                ],
                updatedAt: new Date().toISOString(),
              }
            : prev
        );
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : 'Unable to complete web search right now.';
        setActiveConversation((prev) =>
          prev && prev.conversationId === convId
            ? {
                ...prev,
                messages: prev.messages.map((m) =>
                  m.id === messageId
                    ? { ...m, webSearchLoading: false, webSearchError: errMsg }
                    : m
                ),
              }
            : prev
        );
      } finally {
        inFlightRef.current = false;
        setIsSending(false);
      }
    },
    [activeConversation]
  );

  return {
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
  };
}
