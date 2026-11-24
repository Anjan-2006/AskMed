import { useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import type { DocumentRecord } from '../types/chat';
import {
  extractFirstPageNumber,
  formatCitationsForMarkdown,
  matchDocumentForCitation,
  parseCitationHref,
} from '../utils/citations';
import { CitationChip } from './CitationChip';

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable in insecure context.
    }
  };

  return (
    <div className="code-block-wrap">
      <div className="code-block-header">
        <span>{language || 'code'}</span>
        <button
          type="button"
          className="code-copy-btn"
          onClick={handleCopy}
          aria-label="Copy code block"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className="code-block-pre">
        <code className="code-block-code">{code}</code>
      </pre>
    </div>
  );
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  return '';
}

interface MarkdownRendererProps {
  content: string;
  conversationId?: string;
  documents?: DocumentRecord[];
  onOpenPdf?: (doc: DocumentRecord, page: number) => void;
}

export function MarkdownRenderer({
  content,
  conversationId,
  documents = [],
  onOpenPdf,
}: MarkdownRendererProps) {
  const formatted = useMemo(() => formatCitationsForMarkdown(content), [content]);

  return (
    <div className="md-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            return <>{children}</>;
          },
          code({ className, children, ...props }) {
            const match = /language-([\w-]+)/.exec(className || '');
            const text = extractText(children).replace(/\n$/, '');
            const isBlock = Boolean(match) || text.includes('\n');
            if (isBlock) {
              return <CodeBlock language={match?.[1] || ''} code={text} />;
            }
            return <code {...props}>{children}</code>;
          },
          a({ href, children, ...props }) {
            const cite = parseCitationHref(href);
            if (cite) {
              const matchedDoc = conversationId
                ? matchDocumentForCitation(cite.title, documents)
                : null;
              const pageNum = extractFirstPageNumber(cite.pageLabel);
              const chipInner = (
                <>
                  <span className="cite-title">{cite.title}</span>
                  <span className="cite-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="cite-page">{cite.pageLabel}</span>
                </>
              );

              if (conversationId && matchedDoc && matchedDoc.hasFile !== false && onOpenPdf) {
                return (
                  <CitationChip
                    title={cite.title}
                    pageLabel={cite.pageLabel}
                    pageNum={pageNum || 1}
                    conversationId={conversationId}
                    doc={matchedDoc}
                    onOpenPdf={onOpenPdf}
                  />
                );
              }

              return (
                <span className="cite-chip" title={`${cite.title} (${cite.pageLabel})`}>
                  {chipInner}
                </span>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div className="md-table-wrap">
                <table>{children}</table>
              </div>
            );
          },
        }}
      >
        {formatted}
      </ReactMarkdown>
    </div>
  );
}
