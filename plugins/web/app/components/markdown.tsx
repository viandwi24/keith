import { cn } from 'cn'
import ReactMarkdown, { type Components } from 'react-markdown'

/**
 * CommonMark text (assistant replies, `markdown` blocks, card bodies). Raw HTML is skipped, not
 * rendered (ui-blocks.md: "no raw HTML"). Links open in a new tab and keep only safe schemes.
 * Markdown images are not loaded (they could point anywhere): their alt text is shown instead;
 * pictures come through `image` blocks, which follow the URL rules.
 */

const SAFE_LINK = /^(https?:|mailto:)/i

const components: Components = {
  a: ({ node: _node, href, children, ...props }) =>
    href && SAFE_LINK.test(href) ? (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-primary underline underline-offset-4"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span className="text-muted-foreground">{alt ? `[image: ${alt}]` : '[image]'}</span>,
  p: ({ node: _node, ...props }) => <p className="leading-relaxed [&:not(:first-child)]:mt-2" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-2 ml-5 list-disc [&>li]:mt-1" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-2 ml-5 list-decimal [&>li]:mt-1" {...props} />,
  code: ({ node: _node, className, ...props }) => (
    <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]', className)} {...props} />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      className="my-2 overflow-x-auto rounded-lg bg-muted p-3 text-sm [&>code]:bg-transparent [&>code]:p-0"
      {...props}
    />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground" {...props} />
  ),
  h1: ({ node: _node, ...props }) => <h3 className="mt-3 text-lg font-semibold" {...props} />,
  h2: ({ node: _node, ...props }) => <h4 className="mt-3 text-base font-semibold" {...props} />,
  h3: ({ node: _node, ...props }) => <h5 className="mt-2 font-semibold" {...props} />,
}

export function Markdown({ text, className }: { text: string; className?: string | undefined }) {
  return (
    <div className={cn('text-sm break-words', className)} data-slot="markdown">
      <ReactMarkdown skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
