// AI Elements' Message and MessageContent (https://elements.ai-sdk.dev, Apache-2.0), stock. Replies here are built
// from the server's structured answer rather than streamed Markdown, so the Markdown renderer, actions and branches
// are left out.
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: 'user' | 'assistant' | 'system';
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn('group flex w-full max-w-[95%] flex-col gap-2', from === 'user' ? 'is-user ml-auto justify-end' : 'is-assistant', className)}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      'is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm',
      'group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground',
      'group-[.is-assistant]:text-foreground',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);
